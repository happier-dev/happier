export type CodexExternalSessionInvocationBounds = Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
  /** Content discovery may yield before another observed work unit cannot fit. */
  onProgress?: (resetEstimate?: boolean) => void;
}>;

export class CodexExternalSessionContentSearchYield extends Error {}

export function createCodexContentSearchInvocationBounds(
  bounds: CodexExternalSessionInvocationBounds,
): CodexExternalSessionInvocationBounds {
  let previousWorkAtMs = Date.now();
  let longestWorkMs = 0;
  let yielded = false;
  return {
    ...bounds,
    onProgress(resetEstimate) {
      const nowMs = Date.now();
      if (resetEstimate) longestWorkMs = 0;
      else longestWorkMs = Math.max(longestWorkMs, nowMs - previousWorkAtMs);
      previousWorkAtMs = nowMs;
      // Discovery, filesystem reads and decoding use the same host deadline.
      // Preserve the unfinished semantic unit rather than publishing its prefix.
      if (yielded || (bounds.deadlineAtMs !== undefined && bounds.deadlineAtMs - nowMs <= longestWorkMs)) {
        yielded = true;
        throw new CodexExternalSessionContentSearchYield();
      }
    },
  };
}

export function throwIfCodexExternalSessionInvocationStopped(
  bounds: CodexExternalSessionInvocationBounds,
): void {
  bounds.signal?.throwIfAborted();
  bounds.onProgress?.();
  if (
    bounds.deadlineAtMs !== undefined
    && Number.isFinite(bounds.deadlineAtMs)
    && Date.now() >= bounds.deadlineAtMs
  ) {
    const error = new Error('Codex External Sessions invocation deadline exceeded.');
    error.name = 'TimeoutError';
    throw error;
  }
}

/**
 * Runs bounded parallel work for one Codex External Sessions invocation, checking
 * the invocation bounds before and after every unit so an abort or deadline stops
 * new filesystem effects instead of draining the whole input.
 */
export async function mapCodexExternalSessionWorkWithConcurrency<TInput, TOutput>(
  input: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<TOutput[]> {
  const limit = Math.max(1, Math.trunc(concurrency));
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, input.length) }, async () => {
      while (nextIndex < input.length) {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(input[index]!);
        throwIfCodexExternalSessionInvocationStopped(bounds);
      }
    }),
  );
  return output;
}

export function createCodexExternalSessionJsonlScannerFileSystem(
  bounds: CodexExternalSessionInvocationBounds,
): JsonlScannerFileSystemV1 {
  return {
    async stat(filePath) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      const metadata = await stat(filePath);
      throwIfCodexExternalSessionInvocationStopped(bounds);
      return metadata;
    },
    async read(filePath, position, length) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      if (length <= 0) return Buffer.alloc(0);
      const handle = await open(filePath, 'r');
      try {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        throwIfCodexExternalSessionInvocationStopped(bounds);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
import { open, stat } from 'node:fs/promises';

import type { JsonlScannerFileSystem as JsonlScannerFileSystemV1 } from '@happier-dev/plugin-sdk/sessions/file-stores';
