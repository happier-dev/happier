import { fetchGitHubLatestRelease, readGitHubReleaseHttpStatus } from '@happier-dev/release-runtime';

/** GitHub owns the latest stable release decision. A Git host with no release API uses HEAD. */
export async function resolvePluginGitRelease(locator: string, options: Readonly<{
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}> = {}): Promise<string | undefined> {
  const repository = new URL(locator);
  if (repository.hostname !== 'github.com') return undefined;
  try {
    const release = await fetchGitHubLatestRelease({ githubRepo: repository.pathname.slice(1), ...options });
    if (release && typeof release === 'object' && 'tag_name' in release && typeof release.tag_name === 'string' && release.tag_name.trim()) {
      return release.tag_name;
    }
    throw new Error('The latest GitHub release did not identify a Git tag');
  } catch (error) {
    if (readGitHubReleaseHttpStatus(error) === 404) return undefined;
    throw error;
  }
}
