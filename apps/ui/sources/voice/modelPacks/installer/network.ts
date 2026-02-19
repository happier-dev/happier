import { parseModelPackManifest, type ModelPackManifest } from '@/voice/modelPacks/manifest';

export async function raceWithAbort<T>(signal: AbortSignal, promises: Array<Promise<T>>): Promise<T> {
  if (signal.aborted) throw new Error('aborted');
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([...promises, abortPromise]);
  } finally {
    if (onAbort) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // ignore
      }
    }
  }
}

export function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    (timer as any)?.unref?.();
  });
}

function cacheBustUrl(url: string): string {
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
  const version = typeof (manifest as any)?.buildId === 'string' && (manifest as any).buildId.trim() ? (manifest as any).buildId.trim() : null;

  const files = manifest.files.map((f) => {
    const fileName = `${manifest.packId}__${String(f.path).split('/').join('__')}`;
    const rewritten = `${base}${encodeURIComponent(fileName)}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
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
