/** @moduleRealm daemon */
import { open, stat } from 'node:fs/promises';

import { createExternalSessionContentMatchSnippet } from '@happier-dev/protocol/sessions/external/contentSearchMatch';
import type { AgentExternalSessionsInvocation } from '../../externalSessions.js';
import type { JsonlScannerFileSystemV1 } from './boundedJsonlScanner.js';

export class ExternalSessionContentSearchYield extends Error {}

export type ExternalSessionContentSearchControl = Readonly<{
  signal?: AbortSignal;
  checkWork(resetEstimate?: boolean): void;
  assertNotYielded(): void;
  fileSystem: JsonlScannerFileSystemV1;
}>;

/** One invocation's observed work cost, governed only by its host deadline. */
export function createExternalSessionContentSearchControl(bounds: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>): ExternalSessionContentSearchControl {
  let previousWorkAtMs = Date.now();
  let longestWorkMs = 0;
  let yielded = false;
  const checkWork = (resetEstimate = false) => {
    bounds.signal?.throwIfAborted();
    const nowMs = Date.now();
    if (resetEstimate) longestWorkMs = 0;
    else longestWorkMs = Math.max(longestWorkMs, nowMs - previousWorkAtMs);
    previousWorkAtMs = nowMs;
    if (yielded || (bounds.deadlineAtMs !== undefined && bounds.deadlineAtMs - nowMs <= longestWorkMs)) {
      yielded = true;
      throw new ExternalSessionContentSearchYield();
    }
  };
  return {
    signal: bounds.signal,
    checkWork,
    assertNotYielded() {
      bounds.signal?.throwIfAborted();
      if (yielded) throw new ExternalSessionContentSearchYield();
    },
    fileSystem: {
      async stat(filePath) {
        checkWork();
        const metadata = await stat(filePath);
        checkWork();
        return metadata;
      },
      async read(filePath, position, length) {
        checkWork();
        if (length <= 0) return Buffer.alloc(0);
        const handle = await open(filePath, 'r');
        try {
          bounds.signal?.throwIfAborted();
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          checkWork();
          return buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    },
  };
}

/** Native decoding/semantic selection stays with the plugin; bodies are not retained. */
export async function searchExternalSessionContent(params: Readonly<{
  query: string;
  paths?: readonly string[];
  ripgrep?: AgentExternalSessionsInvocation['ripgrep'];
  control: ExternalSessionContentSearchControl;
  decode: (matchText: (text: string) => string | null) => Promise<Readonly<{
    records: readonly Readonly<{ id: string; snippet?: string }>[];
    partial: boolean;
  }>>;
}>): Promise<Readonly<{ match?: Readonly<{ snippet: string; sourceItemId: string; messageIndex: number }>; partial: boolean }>> {
  params.control.checkWork();
  if (!params.query) return { partial: false };
  if (params.paths) {
    if (params.paths.length === 0) return { partial: false };
    if (!params.ripgrep) throw new Error('File content search requires host ripgrep.');
    // JavaScript folding owns matching. rg can exclude only process-safe ASCII
    // queries (NUL cannot be passed in argv).
    if (!/[^\x01-\x7F]/.test(params.query.toLowerCase())) {
      const prefilter = await params.ripgrep.run({
        args: ['--no-config', '--files-with-matches', '--null', '--ignore-case', '--multiline', '--fixed-strings', '-e', params.query, '-e', '\\'],
        paths: params.paths,
        signal: params.control.signal,
      });
      // Process work and decode work have different costs, with one host budget.
      params.control.checkWork(true);
      if (!prefilter.stdoutTruncated && prefilter.exitCode !== 0 && prefilter.exitCode !== 1) throw new Error('Conversation content prefilter failed.');
      if (!prefilter.stdoutTruncated && !prefilter.stdout.split('\0').some(Boolean)) return { partial: false };
    }
  }
  const projection = await params.decode((text) => createExternalSessionContentMatchSnippet(text, params.query));
  params.control.checkWork();
  params.control.assertNotYielded();
  for (let messageIndex = 0; messageIndex < projection.records.length; messageIndex += 1) {
    params.control.checkWork();
    const item = projection.records[messageIndex]!;
    if (item.snippet !== undefined) return { match: { snippet: item.snippet, sourceItemId: item.id, messageIndex }, partial: projection.partial };
  }
  return { partial: projection.partial };
}
