import { requestJson } from './http.js';

type FetchImpl = typeof fetch;

function buildGitHubReleaseTagUrl(githubRepo: string, tag: string) {
  const repo = String(githubRepo ?? '').trim();
  const t = String(tag ?? '').trim();
  if (!repo) throw new Error('[github] githubRepo is required');
  if (!t) throw new Error('[github] tag is required');
  return `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(t)}`;
}

function buildGitHubLatestReleaseUrl(githubRepo: string) {
  const repo = String(githubRepo ?? '').trim();
  if (!repo) throw new Error('[github] githubRepo is required');
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

function createHttpError(message: string, status: number) {
  const err = new Error(message);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (err as any).status = status;
  return err;
}

function readHttpStatus(error: unknown): number | null {
  const statusFromField =
    typeof error === 'object' && error != null && 'status' in error
      ? Number(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error as any).status,
        )
      : NaN;
  if (Number.isInteger(statusFromField) && statusFromField >= 100 && statusFromField <= 599) {
    return statusFromField;
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = /\((\d{3})\)\s*$/.exec(message);
  if (!match) return null;

  const statusFromMessage = Number(match[1]);
  return Number.isInteger(statusFromMessage) ? statusFromMessage : null;
}

function normalizeGitHubRequestError(params: Readonly<{
  context: string;
  error: unknown;
}>): Error {
  const status = readHttpStatus(params.error) ?? 500;
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return createHttpError(`${params.context}: ${message}`, status);
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
  const url = buildGitHubReleaseTagUrl(params.githubRepo, params.tag);
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  if (params.fetchImpl) {
    try {
      const response = await params.fetchImpl(url, { headers });
      if (!response.ok) {
        throw createHttpError(`[github] failed to resolve release tag ${params.tag} (${response.status})`, response.status);
      }
      return response.json();
    } catch (error) {
      throw normalizeGitHubRequestError({
        context: `[github] failed to resolve release tag ${params.tag}`,
        error,
      });
    }
  }
  try {
    return await requestJson({ url, headers });
  } catch (error) {
    throw normalizeGitHubRequestError({
      context: `[github] failed to resolve release tag ${params.tag}`,
      error,
    });
  }
}

export async function fetchGitHubLatestRelease(params: Readonly<{
  githubRepo: string;
  userAgent?: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
}>): Promise<unknown> {
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-release-runtime';
  const token = String(params.githubToken ?? '').trim();
  const url = buildGitHubLatestReleaseUrl(params.githubRepo);
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  if (params.fetchImpl) {
    try {
      const response = await params.fetchImpl(url, { headers });
      if (!response.ok) {
        throw createHttpError(`[github] failed to resolve latest release (${response.status})`, response.status);
      }
      return response.json();
    } catch (error) {
      throw normalizeGitHubRequestError({
        context: '[github] failed to resolve latest release',
        error,
      });
    }
  }
  try {
    return await requestJson({ url, headers });
  } catch (error) {
    throw normalizeGitHubRequestError({
      context: '[github] failed to resolve latest release',
      error,
    });
  }
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
