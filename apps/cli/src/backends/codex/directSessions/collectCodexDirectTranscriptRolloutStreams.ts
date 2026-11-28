import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import { mapCodexRolloutEventToActions } from '../localControl/rolloutMapper';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import type { CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import type { CodexDirectTranscriptRolloutStream } from './codexDirectTranscriptProjection';

const CHILD_DISCOVERY_MAX_BYTES = 1024 * 1024;
const CHILD_DISCOVERY_MAX_ITEMS = 512;

async function discoverSpawnedThreadIdsFromFilesBounded(files: readonly CodexRolloutFile[]): Promise<readonly string[]> {
  const discovered = new Set<string>();
  const semanticTracker = createCodexRolloutSemanticTracker();
  for (const file of files) {
    let offsetBytes = 0;
    let scannedBytes = 0;
    let scannedItems = 0;
    while (scannedBytes < CHILD_DISCOVERY_MAX_BYTES && scannedItems < CHILD_DISCOVERY_MAX_ITEMS) {
      const page = await readJsonlFileForward({
        filePath: file.filePath,
        offsetBytes,
        maxBytes: Math.min(128 * 1024, CHILD_DISCOVERY_MAX_BYTES - scannedBytes),
        maxItems: Math.min(64, CHILD_DISCOVERY_MAX_ITEMS - scannedItems),
      });
      for (const line of page.items) {
        const normalizedActions = mapCodexRolloutEventToActions(line.value, { debug: true })
          .flatMap((action) => semanticTracker.consume(action));
        for (const action of normalizedActions) {
          if (action.type === 'subagent-spawn') {
            discovered.add(action.threadId);
          }
        }
      }
      if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
      scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
      scannedItems += page.items.length;
      offsetBytes = page.nextOffsetBytes;
    }
  }
  return [...discovered];
}

export async function collectCodexDirectTranscriptRolloutStreams(params: Readonly<{
  collectFiles: (threadId: string) => Promise<CodexRolloutFile[]>;
  remoteSessionId: string;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<readonly CodexDirectTranscriptRolloutStream[]> {
  const queue = [{ threadId: params.remoteSessionId, sidechainId: null as string | null }];
  const seenThreadIds = new Set<string>();
  const streams: CodexDirectTranscriptRolloutStream[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seenThreadIds.has(current.threadId)) continue;
    seenThreadIds.add(current.threadId);

    const files = current.threadId === params.remoteSessionId && current.sidechainId === null && params.initialRolloutFiles
      ? [...params.initialRolloutFiles]
      : await params.collectFiles(current.threadId);
    if (files.length === 0) continue;

    streams.push(...files.map((file) => ({
      ...file,
      threadId: current.threadId,
      sidechainId: current.sidechainId,
    })));

    const discoveredChildThreadIds = await discoverSpawnedThreadIdsFromFilesBounded(files);
    for (const threadId of discoveredChildThreadIds) {
      if (!seenThreadIds.has(threadId)) {
        queue.push({ threadId, sidechainId: threadId });
      }
    }
  }

  streams.sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
  return streams;
}
