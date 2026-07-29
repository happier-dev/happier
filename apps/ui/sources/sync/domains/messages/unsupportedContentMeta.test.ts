import { describe, it, expect } from 'vitest';
import { markUnsupportedContentMeta, readUnsupportedContentMeta } from './unsupportedContentMeta';

describe('markUnsupportedContentMeta / readUnsupportedContentMeta', () => {
    it('round-trips a kind', () => {
        const meta = markUnsupportedContentMeta(undefined, 'unparsed-user-message');
        expect(readUnsupportedContentMeta(meta)).toBe('unparsed-user-message');
    });

    it('preserves unrelated existing meta fields', () => {
        const meta = markUnsupportedContentMeta({ source: 'cli' }, 'unsupported-transcript-record');
        expect(meta.source).toBe('cli');
        expect(readUnsupportedContentMeta(meta)).toBe('unsupported-transcript-record');
    });

    it.each([
        ['unparsed-user-message'],
        ['unparsed-agent-message'],
        ['unsupported-agent-output'],
        ['unsupported-transcript-record'],
    ] as const)('supports kind=%s', (kind) => {
        const meta = markUnsupportedContentMeta(undefined, kind);
        expect(readUnsupportedContentMeta(meta)).toBe(kind);
    });

    it('returns null for undefined/null meta', () => {
        expect(readUnsupportedContentMeta(undefined)).toBeNull();
        expect(readUnsupportedContentMeta(null)).toBeNull();
    });

    it('returns null when the meta key is absent', () => {
        expect(readUnsupportedContentMeta({ source: 'ui' })).toBeNull();
    });

    it('returns null for an unknown kind value', () => {
        expect(readUnsupportedContentMeta({ happierUnsupportedContentV1: 'not-a-real-kind' })).toBeNull();
        expect(readUnsupportedContentMeta({ happierUnsupportedContentV1: 42 })).toBeNull();
    });
});
