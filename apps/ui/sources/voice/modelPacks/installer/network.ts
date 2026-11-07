import { parseModelPackManifest, type ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { assertManifestUrlsAllowed, assertModelPackUrlAllowed, type ModelPackUrlPolicy } from '@happier-dev/voice-modelpacks';
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

/**
 * Fetch + parse a remote pack manifest. The manifest URL and every file URL it
 * declares are validated against the shared {@link ModelPackUrlPolicy} (HTTPS
 * without configured credentials). File URLs are trusted as authored — there is no
 * host-specific URL rewriting; the installer core is the single canonical path.
 */
export async function fetchRemoteManifest(opts: {
  fetchImpl: typeof fetch;
  manifestUrl: string;
  timeoutMs: number | null;
  signal: AbortSignal;
  urlPolicy?: ModelPackUrlPolicy;
}): Promise<ModelPackManifest> {
  assertModelPackUrlAllowed(opts.manifestUrl, opts.urlPolicy);
  const response = await raceWithAbort(opts.signal, [
    opts.fetchImpl(cacheBustUrl(opts.manifestUrl), { signal: opts.signal }),
    ...(opts.timeoutMs === null ? [] : [createTimeoutPromise(opts.timeoutMs)]),
  ]);
  if (!response.ok) throw new Error(`model_pack_manifest_download_failed:${response.status}`);
  const json = await raceWithAbort(opts.signal, [response.json(),
    ...(opts.timeoutMs === null ? [] : [createTimeoutPromise(opts.timeoutMs)]),
  ]);
  const manifest = parseModelPackManifest(json);
  assertManifestUrlsAllowed(manifest, opts.urlPolicy);
  return manifest;
}
