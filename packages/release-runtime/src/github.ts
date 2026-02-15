type FetchImpl = typeof fetch;

function buildGitHubReleaseTagUrl(githubRepo: string, tag: string) {
  const repo = String(githubRepo ?? '').trim();
  const t = String(tag ?? '').trim();
  if (!repo) throw new Error('[github] githubRepo is required');
  if (!t) throw new Error('[github] tag is required');
  return `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(t)}`;
}

function createHttpError(message: string, status: number) {
  const err = new Error(message);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (err as any).status = status;
  return err;
}

export async function fetchGitHubReleaseByTag(params: Readonly<{
  githubRepo: string;
  tag: string;
  userAgent?: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
}>): Promise<unknown> {
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-release-runtime';
  const token = String(params.githubToken ?? '').trim();
  const fetchImpl: FetchImpl = params.fetchImpl ?? fetch;

  const url = buildGitHubReleaseTagUrl(params.githubRepo, params.tag);
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw createHttpError(`[github] failed to resolve release tag ${params.tag} (${response.status})`, response.status);
  }
  return response.json();
}

export async function fetchFirstGitHubReleaseByTags(params: Readonly<{
  githubRepo: string;
  tags: string[];
  userAgent?: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
}>): Promise<Readonly<{ tag: string; release: unknown }>> {
  const tags = Array.isArray(params.tags) ? params.tags : [];
  for (const tag of tags) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const release = await fetchGitHubReleaseByTag({
        githubRepo: params.githubRepo,
        tag,
        userAgent: params.userAgent,
        githubToken: params.githubToken,
        fetchImpl: params.fetchImpl,
      });
      return { tag, release };
    } catch (e) {
      const status =
        typeof e === 'object' && e != null && 'status' in e
          ? Number(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (e as any).status,
            )
          : NaN;
      if (status === 404) continue;
      throw e;
    }
  }
  throw createHttpError('[github] no matching release tags found', 404);
}
