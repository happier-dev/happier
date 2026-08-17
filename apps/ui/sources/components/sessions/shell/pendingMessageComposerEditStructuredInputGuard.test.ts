import { describe, expect, it } from 'vitest';

import { hasRawStructuredInputSemanticContentV1 } from '@happier-dev/protocol/runtime';

describe('pending message composer structured-input edit guard', () => {
    it.each([
        ['plain text metadata', { other: 'metadata' }, false],
        ['an empty structured-input envelope', { happierStructuredInputV1: { v: 1 } }, false],
        ['empty known semantic arrays', {
            happierStructuredInputV1: {
                v: 1,
                mentions: [],
                vendorPluginMentions: [],
                skillMentions: [],
                imageInputs: [],
                composerAttachments: [],
                attachments: [],
            },
        }, false],
        ['hidden structured mentions', {
            happierStructuredInputV1: {
                v: 1,
                mentions: [{ kind: 'file', ref: 'file:src/a.ts', token: '@src/a.ts', start: 0, end: 9 }],
            },
        }, true],
        ['hidden image input', {
            happierStructuredInputV1: {
                v: 1,
                imageInputs: [{ kind: 'image', url: 'https://example.test/image.png' }],
            },
        }, true],
        ['composer attachments', {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{ untrusted: 'attachment' }],
            },
        }, true],
        ['a malformed structured attachment field', {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: { malformed: true },
            },
        }, true],
        ['a malformed structured-input envelope', { happierStructuredInputV1: 'malformed' }, true],
        ['an unknown additive structured field', {
            happierStructuredInputV1: { v: 1, futureSemanticPayload: [] },
        }, true],
    ])('blocks %s only when the text-only editor cannot faithfully restore it', (_name, meta, expected) => {
        expect(hasRawStructuredInputSemanticContentV1(meta)).toBe(expected);
    });
});
