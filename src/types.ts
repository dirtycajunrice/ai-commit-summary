export type ModifiedFile = {
  sha: string;
  originSha: string;
  diff: string;
  position: number;
  filename: string;
}