import { digest } from '@/platform/digest';
import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerFs, Progress } from './types';
import { filePathParts } from './paths';
import { createTimeoutPromise, raceWithAbort } from './network';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const out = await digest('SHA-256', bytes);
  return toHex(out).toLowerCase();
}

async function writeResponseToFile(opts: {
  response: Response;
  file: any;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<{ loaded: number; total: number }> {
  const contentLength = opts.response.headers.get('content-length');
  const total = contentLength ? Number(contentLength) : 0;
  let loaded = 0;

  const body: any = (opts.response as any).body;
  const reader = body?.getReader?.();
  const writable: WritableStream | null = (opts.file as any).writableStream?.() ?? null;
  const writer = writable ? (writable as any).getWriter?.() : null;

  if (reader && writer) {
    type ReadResult = ReadableStreamReadResult<Uint8Array>;
    while (true) {
      const result = await raceWithAbort(opts.signal, [reader.read() as Promise<ReadResult>]);
      const { done, value } = result;
      if (done) break;
      if (value) {
        await writer.write(value);
        loaded += value.length ?? value.byteLength ?? 0;
        opts.onProgress?.({ loaded, total });
      }
    }
    await writer.close();
    return { loaded, total: total || loaded };
  }

  const buf = new Uint8Array(await raceWithAbort(opts.signal, [opts.response.arrayBuffer()]));
  loaded = buf.length;
  (opts.file as any).write(buf);
  opts.onProgress?.({ loaded, total: total || loaded });
  return { loaded, total: total || loaded };
}

async function downloadAndVerifyFile(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  rootDir: any;
  entry: ModelPackManifest['files'][number];
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  const parts = filePathParts(opts.entry.path);
  const parentParts = parts.slice(0, -1);
  const filename = parts[parts.length - 1]!;

  let dir = opts.rootDir;
  for (const p of parentParts) {
    dir = new opts.fs.Directory(dir, p);
  }
  try {
    dir.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }

  const file = new opts.fs.File(dir, filename);
  if (file.exists) {
    try {
      const bytes = await file.bytes();
      const actual = await sha256Hex(bytes);
      if (actual === opts.entry.sha256.toLowerCase()) return;
      file.delete();
    } catch {
      try {
        file.delete();
      } catch {
        // ignore
      }
    }
  }

  const response = await raceWithAbort(opts.signal, [
    opts.fetchImpl(opts.entry.url, { signal: opts.signal }),
    createTimeoutPromise(opts.timeoutMs),
  ]);
  if (!response.ok) throw new Error(`model_pack_download_failed:${response.status}`);

  try {
    if (!file.exists) {
      try {
        file.create();
      } catch {
        // ignore
      }
    }

    await writeResponseToFile({ response, file, signal: opts.signal, onProgress: opts.onProgress });

    const bytes = await file.bytes();
    const actual = await sha256Hex(bytes);
    if (actual !== opts.entry.sha256.toLowerCase()) {
      try {
        file.delete();
      } catch {
        // ignore
      }
      throw new Error('model_pack_sha256_mismatch');
    }
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
    throw error;
  }
}

export async function downloadManifestFiles(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  rootDir: any;
  manifest: ModelPackManifest;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<void> {
  const total = opts.manifest.files.reduce((acc, f) => acc + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0);
  let loadedTotal = 0;

  for (const f of opts.manifest.files) {
    let loadedThisFile = 0;
    await downloadAndVerifyFile({
      fs: opts.fs,
      fetchImpl: opts.fetchImpl,
      rootDir: opts.rootDir,
      entry: f,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onProgress: (p) => {
        const delta = Math.max(0, p.loaded - loadedThisFile);
        loadedThisFile = p.loaded;
        loadedTotal += delta;
        opts.onProgress?.({ loaded: loadedTotal, total, file: f.path });
      },
    });
  }
}
