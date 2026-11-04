import { setTimeout as delay } from 'node:timers/promises';
import { requestJson, requestText } from './http.js';
import { fetchWithCredentialRedirectRefusal } from './httpRedirects.js';

type FetchImpl = typeof fetch;

/** Public failure facts only; request headers and upstream prose never cross this seam. */
export type GitHubReleaseFailure =
  | Readonly<{ reason: 'rate_limited'; resetAtMs: number | null }>
  | Readonly<{ reason: 'not_found' | 'network' | 'upstream'; status: number }>;

/** Same environment precedence as first-party binary self-update. */
export function resolveGitHubReleaseToken(env: Readonly<Record<string, string | undefined>>): string {
  return String(env.HAPPIER_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
}

class GitHubReleaseHttpError extends Error {
  readonly failure: GitHubReleaseFailure;
  constructor(message: string, readonly status: number, cause?: unknown, network = false) {
    super(message, { cause });
    this.failure = { reason: network ? 'network' : status === 404 ? 'not_found' : 'upstream', status };
  }
}

export function readGitHubReleaseFailure(error: unknown): GitHubReleaseFailure | null {
  if (error instanceof GitHubReleaseRateLimitError) return { reason: 'rate_limited', resetAtMs: error.resetAtMs };
  return error instanceof GitHubReleaseHttpError ? error.failure : null;
}

export class GitHubReleaseRateLimitError extends Error {
  readonly code = 'github_rate_limited';
  readonly status: number;
  readonly resetAtMs: number | null;

  constructor(status: number, reset: unknown, options?: ErrorOptions) {
    const seconds = typeof reset === 'string' && /^\d+$/.test(reset) ? Number(reset) : NaN;
    const resetAtMs = Number.isSafeInteger(seconds * 1000) && seconds * 1000 <= 8.64e15 ? seconds * 1000 : null;
    super(`GitHub's API rate limit has been reached.${resetAtMs !== null ? ` Try again after ${new Date(resetAtMs).toISOString()}.` : ' Try again when the GitHub API limit resets.'}`, options);
    this.name = 'GitHubReleaseRateLimitError';
    this.status = status;
    this.resetAtMs = resetAtMs;
  }
}

// GitHub owns this boundary: reuse its reset deadline on later demand, without a timer.
// Transport and authentication origin isolate independently supplied HTTP boundaries.
const exhaustedReleaseQuotas = new WeakMap<object, Map<string, GitHubReleaseRateLimitError>>();
const nativeReleaseTransport = {};

function readReleaseQuota(params: Readonly<{ fetchImpl?: FetchImpl; githubToken?: string }>) {
  const transport = params.fetchImpl ?? globalThis.fetch ?? nativeReleaseTransport;
  let exhausted = exhaustedReleaseQuotas.get(transport);
  if (!exhausted) {
    exhausted = new Map();
    exhaustedReleaseQuotas.set(transport, exhausted);
  }
  const origin = params.githubToken?.trim() || 'anonymous';
  const previous = exhausted.get(origin);
  if (previous && previous.resetAtMs !== null && Date.now() < previous.resetAtMs) throw previous;
  exhausted.delete(origin);
  const owner = exhausted;
  return (error: Error) => {
    if (error instanceof GitHubReleaseRateLimitError && error.resetAtMs !== null) owner.set(origin, error);
  };
}

function responseError(context: string, response: Response): Error {
  if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    return createHttpError('[github] credential-bearing request redirect refused', response.status);
  }
  if ((response.status === 403 || response.status === 429) && response.headers?.get('x-ratelimit-remaining') === '0') {
    return new GitHubReleaseRateLimitError(response.status, response.headers.get('x-ratelimit-reset'));
  }
  return createHttpError(`${context} (${response.status})`, response.status);
}

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

function createHttpError(message: string, status: number, cause?: unknown, network = false) {
  const err = new GitHubReleaseHttpError(message, status, cause, network);
  if (status >= 300 && status < 400 || status === 0) {
    Object.assign(err, { code: `HTTP_${status}`, retryable: false });
  }
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
  if (params.error instanceof GitHubReleaseRateLimitError) return params.error;
  if (params.error instanceof Error && 'code' in params.error
    && (params.error.code === 'credential_request_redirect_refused'
      || 'retryable' in params.error && params.error.retryable === false)) return params.error;
  const upstreamStatus = readGitHubReleaseHttpStatus(params.error);
  const status = upstreamStatus ?? 500;
  if ((status === 403 || status === 429) && typeof params.error === 'object' && params.error !== null
    && 'rateLimitRemaining' in params.error && params.error.rateLimitRemaining === '0') {
    return new GitHubReleaseRateLimitError(status, 'rateLimitReset' in params.error ? params.error.rateLimitReset : undefined, { cause: params.error });
  }
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return createHttpError(`${params.context}: ${message}`, status, params.error, upstreamStatus === null);
}

async function fetchGitHubReleaseAssetsByTag(params: Readonly<{
  githubRepo: string;
  tag: string;
  userAgent?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}>) {
  const repo = params.githubRepo.trim();
  const tag = params.tag.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !tag) {
    throw new Error('[github] repository and release tag are required');
  }
  const url = `https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`;
  const headers = { 'user-agent': params.userAgent?.trim() || 'happier-release-runtime', accept: 'text/html' };
  try {
    // GitHub's public release fragment publishes the same asset SHA-256 digests
    // as REST (observed 2026-10-18). Never send API credentials to this web path.
    let html: string;
    if (params.fetchImpl) {
      const response = await params.fetchImpl(url, { headers, signal: params.signal });
      if (!response.ok) throw responseError('[github] failed to read release assets', response);
      html = await response.text();
    } else {
      html = await requestText({ url, headers, signal: params.signal });
    }
    params.signal?.throwIfAborted();
    const repositoryPath = `/${repo}/releases/download/`;
    const assets: Array<{ name: string; browser_download_url: string; digest: string | null }> = [];
    for (const row of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const href = /<a\b[^>]*\shref=["']([^"']+)["']/i.exec(row[1]!)?.[1];
      if (!href) continue;
      const link = new URL(href.replaceAll('&amp;', '&'), 'https://github.com');
      if (link.origin !== 'https://github.com' || link.search || link.hash) continue;
      const path = decodeURIComponent(link.pathname);
      // GitHub repository names are case-insensitive; release tags are not.
      if (!path.toLowerCase().startsWith(repositoryPath.toLowerCase())) continue;
      const taggedPath = path.slice(repositoryPath.length);
      if (!taggedPath.startsWith(`${tag}/`)) continue;
      const name = taggedPath.slice(tag.length + 1);
      if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') continue;
      const digests = new Set([...row[1]!.matchAll(/<clipboard-copy\b[^>]*\svalue=["'](sha256:[a-f0-9]{64})["']/gi)]
        .map((match) => match[1]!.toLowerCase()));
      if (digests.size > 1 || assets.some((asset) => asset.name === name)) {
        throw new Error('[github] ambiguous release asset integrity metadata');
      }
      assets.push({ name, browser_download_url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
        digest: [...digests][0] ?? null });
    }
    if (assets.length === 0) throw new Error('[github] release asset metadata is unavailable');
    return { tag_name: tag, assets };
  } catch (error) {
    params.signal?.throwIfAborted();
    throw normalizeGitHubRequestError({ context: `[github] failed to read release assets for ${tag}`, error });
  }
}

export async function fetchGitHubReleaseByTag(params: Readonly<{
  githubRepo: string;
  apiBaseUrl?: string;
  tag: string;
  /** Asset-only callers use GitHub's public download/digest facts, without REST. */
  assetsOnly?: boolean;
  userAgent?: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  transientNotFoundAttempts?: number;
  retryDelayMs?: number;
}>): Promise<unknown> {
  params.signal?.throwIfAborted();
  if (params.assetsOnly) return fetchGitHubReleaseAssetsByTag(params);
  const rememberQuota = readReleaseQuota(params);
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
  const fetchImpl = params.fetchImpl;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (fetchImpl) {
        const response = token
          ? await fetchWithCredentialRedirectRefusal(url, { headers, signal: params.signal }, fetchImpl)
          : await fetchImpl(url, { headers, signal: params.signal });
        if (!response.ok) {
          throw responseError(`[github] failed to resolve release tag ${params.tag}`, response);
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
      rememberQuota(normalized);
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
  const rememberQuota = readReleaseQuota(params);
  const userAgent = String(params.userAgent ?? '').trim() || 'happier-release-runtime';
  const token = String(params.githubToken ?? '').trim();
  const url = buildGitHubLatestReleaseUrl(params.githubRepo);
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const fetchImpl = params.fetchImpl;
  try {
    if (fetchImpl) {
      const response = token
        ? await fetchWithCredentialRedirectRefusal(url, { headers, signal: params.signal }, fetchImpl)
        : await fetchImpl(url, { headers, signal: params.signal });
      if (!response.ok) {
        throw responseError('[github] failed to resolve latest release', response);
      }
      return response.json();
    }
    return await requestJson({ url, headers, signal: params.signal });
  } catch (error) {
    params.signal?.throwIfAborted();
    const normalized = normalizeGitHubRequestError({
      context: '[github] failed to resolve latest release',
      error,
    });
    rememberQuota(normalized);
    throw normalized;
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
