import { beforeEach, describe, expect, it } from 'vitest';

import {
    __resetDefaultTranscriptItemHeightCacheForTests,
    buildTranscriptItemHeightSignatureKey,
    createTestTranscriptItemHeightCache,
    getDefaultTranscriptItemHeightCache,
    type TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';

function stableSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent',
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

describe('transcriptItemHeightCache', () => {
    beforeEach(() => {
        __resetDefaultTranscriptItemHeightCacheForTests();
    });

    it('keys entries by the full validity signature', () => {
        const cache = createTestTranscriptItemHeightCache();
        const original = stableSignature();
        const differentWidth = stableSignature({ widthBucket: 'width:640' });

        cache.set(original, { heightPx: 144 });

        expect(buildTranscriptItemHeightSignatureKey(original)).not.toBe(
            buildTranscriptItemHeightSignatureKey(differentWidth),
        );
        expect(cache.get(original)?.heightPx).toBe(144);
        expect(cache.get(differentWidth)).toBeUndefined();
    });

    it('keeps signature keys unambiguous when fields contain separators', () => {
        const first = stableSignature({
            itemId: 'message:1',
            kind: 'agent|text',
            structuralKey: 'revision:1|width:400',
        });
        const second = stableSignature({
            itemId: 'message',
            kind: '1|agent',
            structuralKey: 'text:revision|1:width:400',
        });

        expect(buildTranscriptItemHeightSignatureKey(first)).not.toBe(
            buildTranscriptItemHeightSignatureKey(second),
        );
    });

    it('does not store active rows as stable height entries', () => {
        const cache = createTestTranscriptItemHeightCache();
        const unstableStates: ReadonlyArray<TranscriptItemHeightValiditySignature['rowState']> = [
            'streaming',
            'thinking',
            'pending-action',
            'tool-progress',
        ];

        for (const rowState of unstableStates) {
            const signature = stableSignature({ itemId: `message-${rowState}`, rowState });
            expect(cache.set(signature, { heightPx: 120 })).toBe(false);
            expect(cache.get(signature)).toBeUndefined();
        }
    });

    it('evicts the least recently used entry when the cache exceeds its cap', () => {
        const cache = createTestTranscriptItemHeightCache({ maxEntries: 2 });
        const a = stableSignature({ itemId: 'a', structuralKey: 'a:v1' });
        const b = stableSignature({ itemId: 'b', structuralKey: 'b:v1' });
        const c = stableSignature({ itemId: 'c', structuralKey: 'c:v1' });

        cache.set(a, { heightPx: 100 });
        cache.set(b, { heightPx: 110 });
        expect(cache.get(a)?.heightPx).toBe(100);
        cache.set(c, { heightPx: 120 });

        expect(cache.get(b)).toBeUndefined();
        expect(cache.get(a)?.heightPx).toBe(100);
        expect(cache.get(c)?.heightPx).toBe(120);
    });

    it('resets the default singleton for tests', () => {
        const first = getDefaultTranscriptItemHeightCache({ maxEntries: 8 });
        first.set(stableSignature(), { heightPx: 192 });

        __resetDefaultTranscriptItemHeightCacheForTests();
        const second = getDefaultTranscriptItemHeightCache({ maxEntries: 8 });

        expect(second).not.toBe(first);
        expect(second.get(stableSignature())).toBeUndefined();
    });
});
