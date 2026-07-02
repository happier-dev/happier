import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';

import {
    clearSessionInitialPromptV1,
    readSessionInitialPromptV1,
    writeSessionInitialPromptV1,
} from './sessionInitialPromptV1';

describe('sessionInitialPromptV1', () => {
    it('round-trips replace prompts with source context', () => {
        const metadata = writeSessionInitialPromptV1({
            metadata: MetadataSchema.parse({}),
            text: '  first line\nsecond line  ',
            mode: 'replace',
            createdAtMs: 1,
            sourceMessageIds: ['m1', 'm2'],
            sourceSessionId: 'source-session',
        });

        expect(readSessionInitialPromptV1(metadata)).toEqual({
            v: 1,
            text: '  first line\nsecond line  ',
            mode: 'replace',
            createdAtMs: 1,
            sourceMessageIds: ['m1', 'm2'],
            sourceSessionId: 'source-session',
        });
    });

    it('round-trips append prompts', () => {
        const metadata = writeSessionInitialPromptV1({
            metadata: MetadataSchema.parse({}),
            text: 'append me',
            mode: 'append',
            createdAtMs: 2,
        });

        expect(readSessionInitialPromptV1(metadata)?.mode).toBe('append');
    });

    it('preserves metadata when writing blank prompts', () => {
        const metadata = MetadataSchema.parse({ other: 'value' });

        expect(writeSessionInitialPromptV1({
            metadata,
            text: '  \n\t ',
            mode: 'append',
            createdAtMs: 3,
        })).toBe(metadata);
    });

    it('clears the stored prompt without disturbing other metadata', () => {
        const metadata = MetadataSchema.parse({
            other: 'value',
            sessionInitialPromptV1: {
                v: 1,
                text: 'hello',
                mode: 'replace',
                createdAtMs: 1,
            },
        });

        expect(clearSessionInitialPromptV1({ metadata })).toEqual({
            path: '',
            host: '',
            other: 'value',
        });
    });

    it('returns the same metadata reference when there is no stored prompt to clear', () => {
        const metadata = MetadataSchema.parse({ other: 'value' });

        expect(clearSessionInitialPromptV1({ metadata })).toBe(metadata);
    });

    it('returns null for malformed metadata', () => {
        expect(readSessionInitialPromptV1(MetadataSchema.parse({ sessionInitialPromptV1: 'nope' }))).toBeNull();
        expect(readSessionInitialPromptV1(MetadataSchema.parse({
            sessionInitialPromptV1: { v: 1, text: 'valid text', mode: 'invalid', createdAtMs: 1 },
        }))).toBeNull();
        expect(readSessionInitialPromptV1(MetadataSchema.parse({
            sessionInitialPromptV1: { v: 1, text: '   ', mode: 'append', createdAtMs: 1 },
        }))).toBeNull();
    });
});
