import { createGitHubReleaseClient } from './githubClient.js';
export { GitHubReleaseRateLimitError, readGitHubReleaseFailure, readGitHubReleaseHttpStatus, resolveGitHubReleaseToken, type GitHubReleaseFailure } from './githubClient.js';
const client = createGitHubReleaseClient();
export const { fetchGitHubReleaseByTag, fetchGitHubLatestRelease, fetchGitHubReleases, fetchFirstGitHubReleaseByTags } = client;
