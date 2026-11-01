import { parseModelPackManifest, type ModelPackManifest } from '@/voice/modelPacks/manifest';

import { ModelPackInstallCancelledError } from './errors';

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('aborted');
}

/** A cancelled signal does not make a storage/cleanup failure an expected abort. */
export function isModelPackCancellation(error: unknown, signal: AbortSignal): boolean {
  if (error instanceof ModelPackInstallCancelledError) return true;
  return signal.aborted && error instanceof Error && (error.message === 'aborted' || error.name === 'AbortError');
}

export async function raceWithAbort<T>(signal: AbortSignal, promises: Array<Promise<T>>): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([...promises, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer: unknown = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
  });
}

export function cacheBustUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  const suffix = `happierCacheBust=${Date.now()}`;
  return trimmed.includes('?') ? `${trimmed}&${suffix}` : `${trimmed}?${suffix}`;
}

function rewriteGithubReleaseManifestFileUrls(manifest: ModelPackManifest, manifestUrl: string): ModelPackManifest {
  let url: URL;
  try {
    url = new URL(manifestUrl);
  } catch {
    return manifest;
  }

  // Only rewrite for GitHub release download URLs:
  // https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 6) return manifest;
  const [owner, repo, releases, download, tag] = parts;
  if (releases !== 'releases' || download !== 'download') return manifest;

  const base = `${url.origin}/${owner}/${repo}/releases/download/${tag}/`;
  const version = manifest.buildId?.trim() || null;

  // Only the release location is rewritten; the asset name comes from the manifest's own URL because
  // GitHub sanitizes uploaded asset names (e.g. `!` becomes `.`), so it cannot be re-derived from `path`.
  // The URL pathname segment is already percent-encoded, so it is reused as-is.
  const files = manifest.files.map((f) => {
    const assetName = new URL(f.url).pathname.split('/').pop();
    if (!assetName) return f;
    const rewritten = `${base}${assetName}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
    return { ...f, url: rewritten };
  });

  return { ...manifest, files };
}

export async function fetchRemoteManifest(opts: {
  fetchImpl: typeof fetch;
  manifestUrl: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ModelPackManifest> {
  const response = await raceWithAbort(opts.signal, [
    opts.fetchImpl(cacheBustUrl(opts.manifestUrl), { signal: opts.signal }),
    createTimeoutPromise(opts.timeoutMs),
  ]);
  if (!response.ok) throw new Error(`model_pack_manifest_download_failed:${response.status}`);
  const json = await raceWithAbort(opts.signal, [response.json(), createTimeoutPromise(opts.timeoutMs)]);
  const manifest = parseModelPackManifest(json);
  return rewriteGithubReleaseManifestFileUrls(manifest, opts.manifestUrl);
}
