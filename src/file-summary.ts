import type {PayloadRepository} from "@actions/github/lib/interfaces";

import {octokit} from "./octokit";
import {MAX_OPEN_AI_QUERY_LENGTH, MAX_TOKENS, MODEL_NAME, openai, TEMPERATURE} from "./openai";
import {SHARED_PROMPT} from "./shared-prompt";
import {getOwner, getTitle} from "./utils";
import {ModifiedFile} from "./types";

const linkRegex =
  /\[(?:[a-f0-9]{6}|None)]\(https:\/\/github\.com\/.*?#([a-f0-9]{40}|None)\)/;

export function preprocessCommitMessage(commitMessage: string): string {
  let match = commitMessage.match(linkRegex);
  while (match !== null) {
    commitMessage = commitMessage.split(match[0]).join(match[1]);
    match = commitMessage.match(linkRegex);
  }
  return commitMessage;
}

const OPEN_AI_PROMPT = `${SHARED_PROMPT}
The following is a git diff of a single file.
Please summarize it in a comment, describing the changes made in the diff in high level.
Do it in the following way:
Write \`SUMMARY:\` and then write a summary of the changes made in the diff, as a bullet point list.
Every bullet point should start with a \`*\`.
`;

const MAX_FILES_TO_SUMMARIZE = 20;

async function getOpenAISummaryForFile(
  filename: string,
  patch: string
): Promise<string> {
  try {
    const openAIPrompt = `THE GIT DIFF OF ${filename} TO BE SUMMARIZED:\n\`\`\`\n${patch}\n\`\`\`\n\nSUMMARY:\n`;
    console.log(`OpenAI file summary prompt for ${filename}:\n${openAIPrompt}`);

    if (openAIPrompt.length > MAX_OPEN_AI_QUERY_LENGTH) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("OpenAI query too big");
    }

    const completion = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        {role: "system", content: OPEN_AI_PROMPT},
        {role: "user", content: openAIPrompt}],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    if (completion.choices !== undefined && completion.choices.length > 0) {
      return (
        completion.choices[0].message.content ?? "Error: couldn't generate summary"
      );
    }
  } catch (error) {
    console.error(error);
  }
  return "Error: couldn't generate summary";
}

const getReviewComments = async (pull_number: number, repository: PayloadRepository) => {
  const comments = await octokit.paginate(octokit.pulls.listReviewComments, { ...getOwner(repository), pull_number });
  return comments.map(comment => ({message: preprocessCommitMessage(comment.body ?? ""), id: comment.id}));
};

export const getFileSummaries = async (pull_number: number, repository: PayloadRepository) => {
  const filesChanged = await octokit.pulls.listFiles({...getOwner(repository), pull_number});
  const pullRequest = await octokit.pulls.get({...getOwner(repository), pull_number});
  const baseCommitSha = pullRequest.data.base.sha;
  const headCommitSha = pullRequest.data.head.sha;
  const baseCommitTree = await octokit.git.getTree({
    ...getOwner(repository),
    repo: repository.name,
    tree_sha: baseCommitSha,
    recursive: "true",
  });
  const modifiedFiles = filesChanged.data.reduce((acc, file) => {
    acc[file.filename] = {
      sha: file.sha,
      originSha: baseCommitTree.data.tree.find(tree => tree.path === file.filename)?.sha ?? "None",
      diff: file.patch ?? "",
      position: Number(file.patch?.split("+")[1]?.split(",")[0]) ?? 0,
      filename: file.filename
    };
    return acc;
  }, {} as Record<string, ModifiedFile>);

  const allComments = await getReviewComments(pull_number, repository)
  const aiComments = allComments.filter(comment => comment.message.startsWith("GPT summary of"));
  const commentsToDelete = Object.values(modifiedFiles).reduce((acc, { originSha, sha }) => acc.filter(({ message }) => !message.includes(`GPT summary of ${originSha} - ${sha}:`)), [ ...aiComments ]);
  await Promise.all(commentsToDelete.map(({id : comment_id}) => octokit.pulls.deleteReviewComment({
    ...getOwner (repository),
    comment_id,
  })));
  const result: Record<string, string> = {};
  let summarizedFiles = 0;
  for (const modifiedFile of Object.keys(modifiedFiles)) {
    if (modifiedFiles[modifiedFile].diff === "") {
      console.log("Skipping binary file", modifiedFile)
      continue;
    }
    if (modifiedFiles[modifiedFile].diff.includes("https://git-lfs.github.com/")) {
      console.log("Skipping git lfs file", modifiedFile)
      continue;
    }
    let isFileAlreadySummarized = false;
    const expectedComment = `GPT summary of ${modifiedFiles[modifiedFile].originSha} - ${modifiedFiles[modifiedFile].sha}:`;
    for (const reviewSummary of aiComments) {
      if (reviewSummary.message.includes(expectedComment)) {
        result[modifiedFile] = reviewSummary.message.split("\n").slice(1).join("\n");
        isFileAlreadySummarized = true;
        break;
      }
    }
    if (isFileAlreadySummarized) {
      continue;
    }
    const fileAnalysisAndSummary = await getOpenAISummaryForFile(
      modifiedFile,
      modifiedFiles[modifiedFile].diff
    );
    result[modifiedFile] = fileAnalysisAndSummary;
    const comment = `GPT summary of [${modifiedFiles[
      modifiedFile
      ].originSha.slice(0, 6)}](https://github.com/${repository.owner.login}/${
      repository.name
    }/blob/${baseCommitSha}/${modifiedFile}#${
      modifiedFiles[modifiedFile].originSha
    }) - [${modifiedFiles[modifiedFile].sha.slice(0, 6)}](https://github.com/${
      repository.owner.login
    }/${repository.name}/blob/${headCommitSha}/${modifiedFile}#${
      modifiedFiles[modifiedFile].sha
    }):\n${fileAnalysisAndSummary}`;
    console.log(
      `Adding comment to line ${modifiedFiles[modifiedFile].position}`
    );
    await octokit.pulls.createReviewComment({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pullNumber,
      commit_id: headCommitSha,
      path: modifiedFiles[modifiedFile].filename,
      line: Number.isFinite(modifiedFiles[modifiedFile].position)
        ? modifiedFiles[modifiedFile].position > 0
          ? modifiedFiles[modifiedFile].position
          : 1
        : 1,
      side:
        modifiedFiles[modifiedFile].position > 0 ||
        modifiedFiles[modifiedFile].originSha === "None"
          ? "RIGHT"
          : "LEFT",
      body: comment,
    });
    summarizedFiles += 1;
    if (summarizedFiles >= MAX_FILES_TO_SUMMARIZE) {
      break;
    }
  }
  return result;
}
