import {
  createGithubRepositorySourceConfig,
  parseGithubRepositorySpecifier,
  type GithubRepositorySourceConfigV1,
} from './githubProviderContracts.js';
import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
  type GithubApiResponseV1,
} from './githubApiClient.js';

/** One provider response classification shared by GitHub setup consumers. */
export class GithubApiResponseError extends Error {
  constructor(readonly response: GithubApiResponseV1) {
    super(`GitHub API returned ${response.status}`);
  }

  get status(): number {
    return this.response.status;
  }

  get headers(): Readonly<Record<string, string>> {
    return this.response.headers;
  }
}

export function githubRepositoryUrl(repository: Readonly<{ owner: string; name: string }>): string {
  return new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    'https://api.github.com',
  ).toString();
}

/** Resolves user-entered repository text once to GitHub's immutable repository identity. */
export async function resolveGithubRepositoryWithClient(
  client: GithubApiClientV1,
  value: string,
): Promise<GithubRepositorySourceConfigV1> {
  const repository = parseGithubRepositorySpecifier(value);
  const response = await client.request({ url: githubRepositoryUrl(repository) });
  if (response.status !== 200) throw new GithubApiResponseError(response);
  return createGithubRepositorySourceConfig(decodeGithubJsonResponse(response));
}
