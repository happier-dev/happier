import { isChangeTitleToolNameAlias } from '@happier-dev/plugin-sdk/sessions';
import { isRecord } from '@happier-dev/plugin-sdk';
import { readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
  createCodexExternalSessionJsonlScannerFileSystem,
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import { mapCodexRolloutEventToActions } from '../projection/actions.js';

const CODEX_TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const CODEX_TITLE_MAX_CHARS = 120;

/**
 * The largest single rollout record the reader will consider as a title.
 *
 * A session started through this harness opens with a preamble of very large
 * records — a `<recommended_plugins>` listing, a `# Session title` instruction
 * block, a world-state snapshot — measured at 49-89 KB each and ~395 KB in
 * total before the first genuine message. The reader rejects every one of them,
 * so charging their bytes to the budget spends it on records it was never going
 * to accept and stops the read short of the message it wants. A record this
 * large is a harness payload or a pasted dump, not a session title, so it is
 * traversed rather than considered: its bytes count against
 * `maxTraversedBytes` and never against `maxConsideredBytes`.
 */
const CODEX_TITLE_MAX_RECORD_BYTES = 32 * 1024;
const CODEX_TITLE_BOILERPLATE_PATTERNS = [
  '# session title',
  'at the start of the session',
  'change_title tool',
  '<environment_context>',
  '<instructions>',
  '<turn_aborted>',
  '# agents.md instructions',
] as const;

/**
 * How far into a rollout the single title reader may look. A session's title is
 * its first genuine message, so it is always near the head; the budget exists
 * only to bound the harness boilerplate a real rollout leads with.
 *
 * The two byte bounds are deliberately different quantities:
 * `maxConsideredBytes` is charged for the records the reader actually inspects
 * as a title, while `maxTraversedBytes` is the hard cost bound on the read and
 * covers everything in the way, including oversized records skipped
 * unconsidered. Charging one budget for both is what made a harness preamble
 * able to starve the read of the message it was looking for.
 */
export type CodexRolloutTitleReadBudget = Readonly<{
  maxConsideredBytes: number;
  maxConsideredItems: number;
  maxTraversedBytes: number;
}>;

/**
 * The selected-row budget: one bounded read for a candidate the caller already
 * decided to return.
 */
export const CODEX_ROLLOUT_TITLE_FULL_BUDGET: CodexRolloutTitleReadBudget = {
  maxConsideredBytes: 1024 * 1024,
  maxConsideredItems: 512,
  maxTraversedBytes: 4 * 1024 * 1024,
};

/**
 * The scan budget: one bounded head read. The bounded corpus scan performs this
 * for every row it returns, so its per-row cost has to stay a head read rather
 * than a walk toward the middle of a long transcript.
 *
 * Worst case for one row: 512 KB traversed, of which at most 128 KB across at
 * most 64 records is considered. A rollout whose first genuine message is past
 * that head — or whose head is a single record larger than the remaining
 * traversal budget — stays identifier-only rather than reading further.
 */
export const CODEX_ROLLOUT_TITLE_HEAD_BUDGET: CodexRolloutTitleReadBudget = {
  maxConsideredBytes: CODEX_TITLE_SCAN_CHUNK_MAX_BYTES,
  maxConsideredItems: CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS,
  maxTraversedBytes: 512 * 1024,
};

/**
 * The single normalization rule for a Codex candidate title: collapse
 * whitespace, clamp length, and reject harness boilerplate rather than
 * presenting it as a session title.
 */
export function readCodexExternalSessionTitleCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const title = normalized.length <= CODEX_TITLE_MAX_CHARS
    ? normalized
    : normalized.slice(0, CODEX_TITLE_MAX_CHARS - 3).trimEnd() + '...';
  const lowerTitle = title.toLowerCase();
  if (CODEX_TITLE_BOILERPLATE_PATTERNS.some((pattern) => lowerTitle.includes(pattern))) {
    return null;
  }
  return title;
}

function readTitleFromCodexTitleToolInput(input: unknown): string | null {
  return readCodexExternalSessionTitleCandidate(isRecord(input) ? input.title : null);
}

/**
 * The one Codex rollout title reader. Both the bounded corpus scan (which
 * carries the title on the row it emits) and the selected-candidate build use
 * it against the same earliest rollout file, so a row cannot change its title
 * by being served through a different route.
 */
export async function readCodexSessionTitleFromRollout(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds,
  budget: CodexRolloutTitleReadBudget = CODEX_ROLLOUT_TITLE_FULL_BUDGET,
): Promise<string | null> {
  const fileSystem = createCodexExternalSessionJsonlScannerFileSystem(bounds);
  let fallbackUserText: string | null = null;
  let offsetBytes = 0;
  let traversedBytes = 0;
  let consideredBytes = 0;
  let consideredItems = 0;

  while (
    traversedBytes < budget.maxTraversedBytes
    && consideredBytes < budget.maxConsideredBytes
    && consideredItems < budget.maxConsideredItems
  ) {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    const remainingTraversalBytes = budget.maxTraversedBytes - traversedBytes;
    const pageMaxBytes = Math.min(CODEX_TITLE_SCAN_CHUNK_MAX_BYTES, remainingTraversalBytes);
    const page = await readJsonlFileForwardLines({
      filePath,
      offsetBytes,
      maxBytes: pageMaxBytes,
      maxItems: CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS,
      // One read per page: the scanner opens the file once per chunk it pulls,
      // and this read is performed for every row a candidate chunk returns.
      chunkBytes: pageMaxBytes,
      // A single record may never cost more than what is left of the traversal
      // budget. Without this the scanner follows one multi-megabyte line for up
      // to its own 8 MB oversize allowance, which is the whole read's cost bound
      // escaping through one pathological record.
      maxOversizeLineBytes: remainingTraversalBytes,
      fileSystem,
    });
    throwIfCodexExternalSessionInvocationStopped(bounds);

    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      if (line.value === null) continue;
      if (
        consideredBytes >= budget.maxConsideredBytes
        || consideredItems >= budget.maxConsideredItems
      ) {
        break;
      }
      const recordBytes = line.endOffsetBytes - line.startOffsetBytes;
      // Traversed, not considered: see CODEX_TITLE_MAX_RECORD_BYTES.
      if (recordBytes > CODEX_TITLE_MAX_RECORD_BYTES) continue;
      consideredBytes += recordBytes;
      consideredItems += 1;
      for (const action of mapCodexRolloutEventToActions(line.value, { debug: false })) {
        if (action.type === 'tool-call' && isChangeTitleToolNameAlias(action.name)) {
          const title = readTitleFromCodexTitleToolInput(action.input);
          if (title) return title;
        }
        if (action.type === 'user-text' && fallbackUserText === null) {
          fallbackUserText = readCodexExternalSessionTitleCandidate(action.text);
        }
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    traversedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    offsetBytes = page.nextOffsetBytes;
  }

  return fallbackUserText;
}
