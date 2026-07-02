import { describe, expect, it } from 'vitest';

import {
    createTestTranscriptItemHeightCache,
    type TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';
import { resolveTranscriptRowShellHeight } from './resolveTranscriptRowShellHeight';

function stableSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent-short',
        structuralKey: 'message-1:content-v1',
        widthBucket: 'width:400',
        fontScaleKey: 'font:100',
        groupingMode: 'turns',
        forkContextKey: 'fork:root',
        expansionKey: 'tools:collapsed',
        rowState: 'stable',
        ...overrides,
    };
}

describe('resolveTranscriptRowShellHeight', () => {
    it('returns a minHeight row-shell hint for a valid cached height', () => {
        const cache = createTestTranscriptItemHeightCache();
        const signature = stableSignature();
        cache.set(signature, { heightPx: 184 });

        expect(resolveTranscriptRowShellHeight({ cache, signature })).toEqual({ minHeight: 184 });
    });

    it('does not expose dead FlashList estimate props', () => {
        const cache = createTestTranscriptItemHeightCache();
        const signature = stableSignature();
        cache.set(signature, { heightPx: 184 });

        const hint = resolveTranscriptRowShellHeight({ cache, signature });

        expect(hint).not.toHaveProperty('estimatedItemSize');
        expect(hint).not.toHaveProperty('overrideItemLayout');
    });

    it('returns undefined for stale or unstable signatures', () => {
        const cache = createTestTranscriptItemHeightCache();
        cache.set(stableSignature({ structuralKey: 'message-1:content-v1' }), { heightPx: 184 });

        expect(resolveTranscriptRowShellHeight({
            cache,
            signature: stableSignature({ structuralKey: 'message-1:content-v2' }),
        })).toBeUndefined();
        expect(resolveTranscriptRowShellHeight({
            cache,
            signature: stableSignature({ rowState: 'streaming' }),
        })).toBeUndefined();
    });
});
