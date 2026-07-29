import { describe, expect, it } from 'vitest';

import { resolveProviderMessageMetaOverrides } from '@/sync/domains/messages/messageMetaProviders';

describe('resolveProviderMessageMetaOverrides', () => {
    it('applies provider-owned message-meta overrides for Claude', () => {
        const overrides = resolveProviderMessageMetaOverrides({
            agentId: 'claude',
            session: {
                metadata: {
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 12,
                        overrides: {
                            reasoning_effort: {
                                updatedAt: 12,
                                value: 'low',
                            },
                        },
                    },
                },
            },
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId: 's1', comments: [] },
                },
            },
        });

        expect((overrides as any)?.reasoningEffort).toBe('low');
        expect((overrides as any)?.happier?.kind).toBe('review_comments.v1');
    });

    it('passes through overrides for providers without message-meta override builders', () => {
        const passthrough = {
            happier: {
                kind: 'review_comments.v1',
                payload: { sessionId: 's1', comments: [] },
            },
        } as const;

        expect(resolveProviderMessageMetaOverrides({
            agentId: 'codex',
            session: { id: 's1' },
            metaOverrides: passthrough,
        })).toEqual(passthrough);
    });
});
