import { describe, expect, it } from 'vitest';

import { buildSendMessageMeta } from './buildSendMessageMeta';

describe('buildSendMessageMeta metaOverrides', () => {
    it('preserves nested metaOverrides while adding Claude reasoningEffort from session override metadata', () => {
        const meta = buildSendMessageMeta({
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: '',
            displayText: 'Review comments (1)',
            agentId: 'claude',
            settings: {},
            session: {
                id: 's1',
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

        expect((meta as any).happier?.kind).toBe('review_comments.v1');
        expect((meta as any).reasoningEffort).toBe('low');
        expect((meta as any).displayText).toBe('Review comments (1)');
        expect((meta as any).sentFrom).toBe('e2e');
    });
});
