import * as core from "@actions/core";
import { Octokit } from "@octokit/action";
import { throttling } from "@octokit/plugin-throttling";
import moment from "moment";
import yn from "yn";
import * as sms from "source-map-support";
import * as ds from "dotenv-safe";

sms.install();

const devEnv = process.env.NODE_ENV === "dev";

const inputKeys = {
  AGE: devEnv ? "AGE" : "age",
  SKIP_TAGS: devEnv ? "SKIP_TAGS" : "skip-tags",
  SKIP_RECENT: devEnv ? "SKIP_RECENT" : "skip-recent",
};

if (devEnv) {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  ds.config();
}

function readInput(key, isRequired = false) {
  if (devEnv) {
    return process.env[key];
  }

  return core.getInput(key, { required: isRequired });
}

function getConfigs() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const [age, units] = readInput(inputKeys.AGE, true).split(" ");
  const maxAge = moment().subtract(age, units);

  console.log(
    "Maximum artifact age:",
    age,
    units,
    "( created before",
    maxAge.format(),
    ")"
  );

  const skipRecent = readInput(inputKeys.SKIP_RECENT);

  if (skipRecent) {
    const parsedRecent = Number(skipRecent);

    if (Number.isNaN(parsedRecent)) {
      throw new Error("skip-recent option must be type of number.");
    }
  }

  return {
    repo: {
      owner,
      repo,
    },
    pagination: {
      perPage: 100,
    },
    maxAge: moment().subtract(age, units),
    skipTags: yn(readInput(inputKeys.SKIP_TAGS), {
      default: true,
      lenient: false,
    }),
    skipRecent: Number(skipRecent),
    retriesEnabled: true,
  };
}

const ThrottledOctokit = Octokit.plugin(throttling);

async function run() {
  const configs = getConfigs();
  const octokit = new ThrottledOctokit({
    throttle: {
      onRateLimit: (retryAfter, options) => {
        console.error(
          `Request quota exhausted for request ${options.method} ${options.url}, number of total global retries: ${options.request.retryCount}`
        );

        console.log(`[RateLimit] Retrying after ${retryAfter} seconds!`);

        return configs.retriesEnabled;
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        console.error(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}, retry count: ${options.request.retryCount}`
        );

        console.log(
          `[SecondaryRateLimit] Retrying after ${retryAfter} seconds!`
        );

        return configs.retriesEnabled;
      },
    },
  });

  async function getTaggedCommits() {
    const listTagsRequest = octokit.repos.listTags.endpoint.merge({
      ...configs.repo,
      per_page: configs.pagination.perPage,
      ref: "tags",
    });

    const tags = await octokit.paginate(listTagsRequest);

    return tags.map((tag) => tag.commit.sha);
  }

  let taggedCommits;

  if (configs.skipTags) {
    try {
      taggedCommits = await getTaggedCommits(octokit);
    } catch (err) {
      console.error("Error while requesting tags: ", err);

      throw err;
    }
  }

  const workflowRunsRequest =
    octokit.rest.actions.listWorkflowRunsForRepo.endpoint.merge({
      ...configs.repo,
      per_page: configs.pagination.perPage,
    });

  let skippedArtifactsCounter = 0;

  return octokit
    .paginate(workflowRunsRequest, ({ data }, done) => {
      const stopPagination = data.find((workflowRun) => {
        const createdAt = moment(workflowRun.created_at);

        return createdAt.isBefore(moment.utc().subtract(90, "days"));
      });

      if (stopPagination) {
        done();
      }

      return data;
    })
    .then((workflowRuns) => {
      const artifactPromises = workflowRuns
        .filter((workflowRun) => {
          const skipTaggedWorkflow =
            configs.skipTags && taggedCommits.includes(workflowRun.head_sha);

          if (skipTaggedWorkflow) {
            console.log(`Skipping tagged run ${workflowRun.head_sha}`);

            return false;
          }

          return true;
        })
        .map((workflowRun) => {
          const workflowRunArtifactsRequest =
            octokit.actions.listWorkflowRunArtifacts.endpoint.merge({
              ...configs.repo,
              per_page: configs.pagination.perPage,
              run_id: workflowRun.id,
            });

          return octokit
            .paginate(workflowRunArtifactsRequest)
            .then((artifacts) =>
              artifacts
                .filter((artifact) => {
                  const skipRecentArtifact =
                    configs.skipRecent &&
                    configs.skipRecent > skippedArtifactsCounter;

                  if (skipRecentArtifact) {
                    console.log(
                      `Skipping recent artifact (id: ${artifact.id}, name: ${artifact.name}).`
                    );

                    skippedArtifactsCounter += 1;

                    return false;
                  }

                  const createdAt = moment(artifact.created_at);

                  return createdAt.isBefore(configs.maxAge);
                })
                .map((artifact) => {
                  if (devEnv) {
                    return new Promise((resolve) => {
                      console.log(
                        `Recognized development environment, preventing artifact (id: ${artifact.id}, name: ${artifact.name}) from being removed.`
                      );

                      resolve();
                    });
                  }

                  return octokit.actions
                    .deleteArtifact({
                      ...configs.repo,
                      artifact_id: artifact.id,
                    })
                    .then(() => {
                      console.log(
                        `Successfully removed artifact (id: ${artifact.id}, name: ${artifact.name}).`
                      );
                    });
                })
            );
        });

      return Promise.all(artifactPromises).then((artifactDeletePromises) =>
        Promise.all([].concat(...artifactDeletePromises))
      );
    });
}

run().catch((err) => {
  core.setFailed(err.toString());
});
