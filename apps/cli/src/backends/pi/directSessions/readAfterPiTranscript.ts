import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { mapPiSessionToDirectMessages } from './mapPiSessionToDirectMessages';
import { decodePiForwardCursor, encodePiForwardCursor, loadPiSessionEntries } from './pagePiTranscript';
import { resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';

/**
 * Read pi transcript items appended after a forward cursor (item count already delivered from the
 * start of the active branch). Used by the polling follow-lease to tail a live session. Because the
 * active branch is recomputed from the whole file each call, branch switches mid-follow are handled
 * approximately; the common steady-growth case (new entries appended to the same leaf) is exact.
 */
export async function readAfterPiTranscript(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  truncated: boolean;
}>> {
  const resolved = await resolvePiDirectSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) {
    return { items: [], nextCursor: null, truncated: false };
  }

  const entries = await loadPiSessionEntries(resolved.filePath);
  const items = mapPiSessionToDirectMessages({ entries, fileRelPath: resolved.fileRelPath });
  const total = items.length;

  const delivered = Math.min(Math.max(0, decodePiForwardCursor(params.cursor)), total);
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));

  const pageItems: DirectTranscriptRawMessageV1[] = [];
  let bytesUsed = 0;
  for (let i = delivered; i < total; i += 1) {
    const item = items[i]!;
    if (pageItems.length >= maxItems) break;
    const size = Buffer.byteLength(JSON.stringify(item.raw), 'utf8');
    if (pageItems.length > 0 && bytesUsed + size > maxBytes) break;
    pageItems.push(item);
    bytesUsed += size;
  }

  const newDelivered = delivered + pageItems.length;
  const truncated = newDelivered < total;
  const nextCursor = truncated ? encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: newDelivered }) : null;

  return { items: pageItems, nextCursor, truncated };
}
