import { describe, it, expect } from 'vitest';
import { markUnsupportedContentMeta, readUnsupportedContentMeta } from './unsupportedContentMeta';

describe('markUnsupportedContentMeta / readUnsupportedContentMeta', () => {
    it('round-trips a kind with no recordType', () => {
        const meta = markUnsupportedContentMeta(undefined, { kind: 'unparsed-user-message' });
        expect(readUnsupportedContentMeta(meta)).toEqual({ kind: 'unparsed-user-message' });
    });

    it('round-trips a kind with a recordType', () => {
        const meta = markUnsupportedContentMeta(undefined, { kind: 'unsupported-agent-output', recordType: 'weird_type' });
        expect(readUnsupportedContentMeta(meta)).toEqual({ kind: 'unsupported-agent-output', recordType: 'weird_type' });
    });

    it('preserves unrelated existing meta fields', () => {
        const meta = markUnsupportedContentMeta({ source: 'cli' } as any, { kind: 'unsupported-transcript-record' });
        expect((meta as any).source).toBe('cli');
        expect(readUnsupportedContentMeta(meta)).toEqual({ kind: 'unsupported-transcript-record' });
    });

    it.each([
        ['unparsed-user-message'],
        ['unparsed-agent-message'],
        ['unsupported-agent-output'],
        ['unsupported-transcript-record'],
    ] as const)('supports kind=%s', (kind) => {
        const meta = markUnsupportedContentMeta(undefined, { kind });
        expect(readUnsupportedContentMeta(meta)?.kind).toBe(kind);
    });

    it('returns null for undefined/null meta', () => {
        expect(readUnsupportedContentMeta(undefined)).toBeNull();
        expect(readUnsupportedContentMeta(null)).toBeNull();
    });

    it('returns null when the meta key is absent', () => {
        expect(readUnsupportedContentMeta({ source: 'ui' })).toBeNull();
    });

    it('returns null for a malformed marker value', () => {
        expect(readUnsupportedContentMeta({ happierUnsupportedContentV1: 'not-an-object' })).toBeNull();
        expect(readUnsupportedContentMeta({ happierUnsupportedContentV1: { kind: 'not-a-real-kind' } })).toBeNull();
        expect(readUnsupportedContentMeta({ happierUnsupportedContentV1: {} })).toBeNull();
    });

    it('ignores a non-string recordType', () => {
        expect(readUnsupportedContentMeta({
            happierUnsupportedContentV1: { kind: 'unsupported-agent-output', recordType: 42 },
        })).toEqual({ kind: 'unsupported-agent-output' });
    });

    it('ignores an empty-string recordType', () => {
        expect(readUnsupportedContentMeta({
            happierUnsupportedContentV1: { kind: 'unsupported-agent-output', recordType: '' },
        })).toEqual({ kind: 'unsupported-agent-output' });
    });
});
