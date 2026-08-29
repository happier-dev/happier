import { ProtocolComposerReferenceResolutionV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { describe, expect, it } from 'vitest';

import { fitComposerReferenceResolutionPrefixV1 } from './composerReferenceResolution.js';

describe('fitComposerReferenceResolutionPrefixV1', () => {
  it('admits a whole-item prefix through the canonical Composer schema', () => {
    const items = Array.from(
      { length: 80 },
      (_, index) => `item-${String(index + 1)}:${'\\"'.repeat(192)}`,
    );
    const fitted = fitComposerReferenceResolutionPrefixV1({
      identity: { id: 'candidate-1', label: 'Selected evidence' },
      itemCount: items.length,
      contextForPrefix: (includedCount) => [
        ...items.slice(0, includedCount),
        `Omitted ${String(items.length - includedCount)} item(s).`,
      ].join('\n'),
    });

    expect(fitted).not.toBeNull();
    expect(ProtocolComposerReferenceResolutionV1Schema.safeParse(fitted).success).toBe(true);
    expect(fitted?.context).toContain(items[0]);
    expect(fitted?.context).not.toContain(items.at(-1));
    expect(fitted?.context.split('\n').slice(0, -1).every((item) => items.includes(item))).toBe(true);
  });

  it('returns null when the fixed candidate identity cannot satisfy the schema', () => {
    expect(fitComposerReferenceResolutionPrefixV1({
      identity: { id: '', label: '' },
      itemCount: 0,
      contextForPrefix: () => 'evidence',
    })).toBeNull();
  });
});
