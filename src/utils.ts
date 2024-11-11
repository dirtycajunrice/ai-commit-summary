import {PayloadRepository} from "@actions/github/lib/interfaces";
import {ModifiedFile} from "./types";

export const getOwner = (repo: PayloadRepository) => ({owner: repo.owner.login, repo: repo.name})

export const getTitle = ({originSha, sha}: ModifiedFile) => `GPT summary of ${originSha} - ${sha}:`