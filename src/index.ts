import {context} from "@actions/github";

import {summarizeCommits} from "./commit-summary";
import {getFileSummaries} from "./file-summary";
import * as process from "node:process";

const run = async () => {
  // Get the pull request number and repository owner and name from the context object
  const {repository, pull_request} = context.payload;
  if (pull_request === undefined) {
    throw new Error("Missing pull request in context payload!");
  }
  if (repository === undefined) {
    throw new Error("Repository undefined in context payload!");
  }

  // Create a dictionary with the modified files being keys, and the hash values of the latest commits in which the file was modified being the values
  const summaries = await getFileSummaries(pull_request.number, repository);

  await summarizeCommits(pull_request.number, repository, summaries);
}

run()
  .then(() => {
    console.log("Done");
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
