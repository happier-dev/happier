import { setTimeout as delay } from 'node:timers/promises';
import { requestJson, requestText } from './http.js';
import { createGitHubReleaseClient } from './githubClient.js';
export { GitHubReleaseRateLimitError, readGitHubReleaseFailure, readGitHubReleaseHttpStatus, resolveGitHubReleaseToken, type GitHubReleaseFailure } from './githubClient.js';
const client = createGitHubReleaseClient({ requestJson, requestText, delay: (ms, signal) => delay(ms, undefined, { signal }) });
export const { fetchGitHubReleaseByTag, fetchGitHubLatestRelease, fetchGitHubReleases, fetchFirstGitHubReleaseByTags } = client;
