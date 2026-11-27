import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

import { resolveCodexLogicalRolloutPath } from '../utils/codexSessionFiles';
import { createCodexRolloutFileIdentity } from './codexRolloutFileIdentity';

export const canDecodeCompressedCodexRollouts = typeof zlib.createZstdDecompress === 'function';

export function isCompressedCodexRollout(path: string): boolean {
  return resolveCodexLogicalRolloutPath(path) !== path;
}

/** The reader owns both streams even when it stops after the header. */
export async function* readCompressedCodexRollout(path: string): AsyncGenerator<Buffer> {
  const source = createReadStream(path);
  const decoder = zlib.createZstdDecompress();
  const transfer = pipeline(source, decoder);
  // Iteration handles the same stream error. Observe the transfer immediately.
  void transfer.catch(() => undefined);
  try {
    for await (const chunk of decoder) yield Buffer.from(chunk);
    await transfer;
  } finally {
    source.destroy();
    decoder.destroy();
    await transfer.catch(() => undefined);
  }
}

export type CodexRolloutReadPathResolver = (path: string) => Promise<Readonly<{ path: string; fileIdentity?: string }>>;

/** Backward paging needs a seekable file. Keep private scratch for the owning read or follow lease. */
export function createCodexRolloutReadPaths(): Readonly<{ resolve: CodexRolloutReadPathResolver; dispose: () => Promise<void> }> {
  let scratch: string | undefined;
  const decoded = new Map<string, Readonly<{ path: string; fileIdentity: string; sourceVersion: string }>>();
  const readSourceVersion = async (path: string) => {
    const stats = await stat(path, { bigint: true });
    const fileIdentity = createCodexRolloutFileIdentity(stats);
    return { fileIdentity, sourceVersion: `${fileIdentity}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}` };
  };
  return {
    async resolve(path) {
      if (!isCompressedCodexRollout(path)) return { path };
      const source = await readSourceVersion(path);
      const previous = decoded.get(path);
      if (previous?.sourceVersion === source.sourceVersion) return previous;
      if (previous) {
        await rm(previous.path, { force: true });
        decoded.delete(path);
      }
      scratch ??= await mkdtemp(join(tmpdir(), 'happier-codex-rollout-'));
      const output = join(scratch, randomUUID());
      try {
        await pipeline(Readable.from(readCompressedCodexRollout(path)), createWriteStream(output, { mode: 0o600, flags: 'wx' }));
        if ((await readSourceVersion(path)).sourceVersion !== source.sourceVersion) {
          throw new Error('Compressed Codex rollout changed while it was being read');
        }
        const result = { path: output, ...source };
        decoded.set(path, result);
        return result;
      } catch (error) {
        await rm(output, { force: true });
        throw error;
      }
    },
    async dispose() {
      if (scratch) await rm(scratch, { recursive: true, force: true });
      decoded.clear();
      scratch = undefined;
    },
  };
}

export async function withCodexRolloutReadPaths<T>(run: (resolve: CodexRolloutReadPathResolver) => Promise<T>): Promise<T> {
  const paths = createCodexRolloutReadPaths();
  try {
    return await run(paths.resolve);
  } finally {
    await paths.dispose();
  }
}
