import { describe, expect, it, vi } from 'vitest';

import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { importDirectSessionTranscript } from './importDirectSessionTranscript';

function createItem(id: string): DirectTranscriptRawMessageV1 {
  return {
    id,
    createdAtMs: 1_700_000_000_000,
    raw: { id },
  };
}

describe('importDirectSessionTranscript', () => {
  it('drains transcript pages in order and reports truncation', async () => {
    const loadPage = vi.fn(async (cursor: string | null) => {
      if (cursor === null) {
        return { items: [createItem('1')], nextCursor: 'page-2', hasMore: true, truncated: false };
      }
      return { items: [createItem('2'), createItem('3')], nextCursor: null, hasMore: false, truncated: true };
    });
    const importedIds: string[] = [];
    const onItem = vi.fn(async (item: DirectTranscriptRawMessageV1) => {
      importedIds.push(item.id);
    });

    const result = await importDirectSessionTranscript({ loadPage, onItem });

    expect(loadPage).toHaveBeenCalledWith(null);
    expect(loadPage).toHaveBeenCalledWith('page-2');
    expect(importedIds).toEqual(['1', '2', '3']);
    expect(result).toEqual({ importedCount: 3, truncated: true });
  });
});
