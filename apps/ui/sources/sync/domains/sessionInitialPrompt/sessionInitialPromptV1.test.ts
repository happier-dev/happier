import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@happier-dev/session-core/state';

import {
    clearSessionInitialPromptV1,
    readSessionInitialPromptV1,
} from './sessionInitialPromptV1';

describe('sessionInitialPromptV1', () => {
    // Predecessor ../0.2 at ba23ebf0b67e9e8260bfbcbbd3cec9e5f1d63323:
    // sessionInitialPromptV1.ts writes this shape. New source no longer writes it.
    it('reads predecessor replace prompts with source context', () => {
        const metadata = MetadataSchema.parse({ sessionInitialPromptV1: {
            v: 1,
            text: '  first line\nsecond line  ',
            mode: 'replace',
            createdAtMs: 1,
            sourceMessageIds: ['m1', 'm2'],
            sourceSessionId: 'source-session',
        } });

        expect(readSessionInitialPromptV1(metadata)).toEqual({
            v: 1,
            text: '  first line\nsecond line  ',
            mode: 'replace',
            createdAtMs: 1,
            sourceMessageIds: ['m1', 'm2'],
            sourceSessionId: 'source-session',
        });
    });

    it('reads predecessor append prompts', () => {
        const metadata = MetadataSchema.parse({ sessionInitialPromptV1: {
            v: 1,
            text: 'append me',
            mode: 'append',
            createdAtMs: 2,
        } });

        expect(readSessionInitialPromptV1(metadata)?.mode).toBe('append');
    });

    it('reads retained Discussion selection source without Run draft correlation', () => {
        const metadata = MetadataSchema.parse({ sessionInitialPromptV1: {
            v: 1,
            text: 'selected messages',
            mode: 'append',
            createdAtMs: 2,
            source: { kind: 'discussion', serverId: 'server-a', discussionId: 'discussion-a', messageIds: ['message-2', 'message-4'] },
        } });

        expect(readSessionInitialPromptV1(metadata)?.source).toEqual({
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-2', 'message-4'],
        });
        expect(readSessionInitialPromptV1(metadata)?.source).not.toHaveProperty('draftCorrelationId');
    });

    it('reads retained Discussion handoff source fields without restoring unknown draft correlation', () => {
        const metadata = {
            ...MetadataSchema.parse({}),
            sessionInitialPromptV1: {
                v: 1 as const,
                text: 'selected messages',
                mode: 'append' as const,
                createdAtMs: 2,
                source: {
                    kind: 'discussion' as const,
                    serverId: 'server-a',
                    discussionId: 'discussion-a',
                    messageIds: ['message-2'],
                    draftCorrelationId: 'draft-a',
                    retired: { enabled: true },
                },
            },
        };

        expect(readSessionInitialPromptV1(metadata)?.source).toEqual({
            kind: 'discussion', serverId: 'server-a', discussionId: 'discussion-a', messageIds: ['message-2'],
        });
        expect(readSessionInitialPromptV1(metadata)?.source).not.toHaveProperty('draftCorrelationId');
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
