import { setTimeout as delay } from 'node:timers/promises';
import { requestJson } from './http.js';

type FetchImpl = typeof fetch;

function buildGitHubReleaseTagUrl(githubRepo: string, tag: string, apiBaseUrl = 'https://api.github.com') {
  const repo = String(githubRepo ?? '').trim();
  const t = String(tag ?? '').trim();
  if (!repo) throw new Error('[github] githubRepo is required');
  if (!t) throw new Error('[github] tag is required');
  return `${apiBaseUrl.replace(/\/$/, '')}/repos/${repo}/releases/tags/${encodeURIComponent(t)}`;
}

function buildGitHubLatestReleaseUrl(githubRepo: string) {
  const repo = String(githubRepo ?? '').trim();
  if (!repo) throw new Error('[github] githubRepo is required');
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

function createHttpError(message: string, status: number, cause?: unknown) {
  const err = new Error(message, { cause });
  (err as Error & { status: number }).status = status;
  return err;
}

export function readGitHubReleaseHttpStatus(error: unknown): number | null {
  const statusFromField =
    typeof error === 'object' && error != null && 'status' in error
      ? Number(
          (error as { status?: unknown }).status,
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
  const status = readGitHubReleaseHttpStatus(params.error) ?? 500;
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return createHttpError(`${params.context}: ${message}`, status, params.error);
}

export async function fetchGitHubReleaseByTag(params: Readonly<{
  githubRepo: string;
  apiBaseUrl?: string;
  tag: string;
  userAgent?: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  transientNotFoundAttempts?: number;
  retryDelayMs?: number;
}>): Promise<unknown> {
  params.signal?.throwIfAborted();
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-release-runtime';
  const token = String(params.githubToken ?? '').trim();
  const url = buildGitHubReleaseTagUrl(params.githubRepo, params.tag, params.apiBaseUrl);
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const attempts = Math.max(1, Math.floor(params.transientNotFoundAttempts ?? 3));
  const retryDelayMs = Math.max(0, Math.floor(params.retryDelayMs ?? 250));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (params.fetchImpl) {
        const response = await params.fetchImpl(url, { headers, signal: params.signal });
        if (!response.ok) {
          throw createHttpError(`[github] failed to resolve release tag ${params.tag} (${response.status})`, response.status);
        }
        return response.json();
      }
      return await requestJson({ url, headers, signal: params.signal });
    } catch (error) {
      params.signal?.throwIfAborted();
      const normalized = normalizeGitHubRequestError({
        context: `[github] failed to resolve release tag ${params.tag}`,
        error,
      });
      if (readGitHubReleaseHttpStatus(normalized) !== 404 || attempt >= attempts) throw normalized;
      if (retryDelayMs > 0) await delay(retryDelayMs, undefined, { signal: params.signal });
    }
  }
  throw createHttpError(`[github] failed to resolve release tag ${params.tag}`, 404);
}

export async function fetchGitHubLatestRelease(params: Readonly<{
  githubRepo: string;
  userAgent?: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}>): Promise<unknown> {
  params.signal?.throwIfAborted();
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
      const response = await params.fetchImpl(url, { headers, signal: params.signal });
      if (!response.ok) {
        throw createHttpError(`[github] failed to resolve latest release (${response.status})`, response.status);
      }
      return response.json();
    } catch (error) {
      params.signal?.throwIfAborted();
      throw normalizeGitHubRequestError({
        context: '[github] failed to resolve latest release',
        error,
      });
    }
  }
  try {
    return await requestJson({ url, headers, signal: params.signal });
  } catch (error) {
    params.signal?.throwIfAborted();
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
  signal?: AbortSignal;
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
        signal: params.signal,
        transientNotFoundAttempts: 1,
      });
      return { tag, release };
    } catch (e) {
      if (readGitHubReleaseHttpStatus(e) === 404) continue;
      throw e;
    }
  }
  throw createHttpError('[github] no matching release tags found', 404);
}
