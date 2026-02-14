import { describe, expect, it } from 'vitest';

import { buildSendMessageMeta } from './buildSendMessageMeta';

describe('buildSendMessageMeta metaOverrides', () => {
    it('shallow merges metaOverrides onto the outbound meta', () => {
        const meta = buildSendMessageMeta({
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: '',
            displayText: 'Review comments (1)',
            agentId: null,
            settings: {},
            session: { id: 's1' },
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId: 's1', comments: [] },
                },
            },
        });

        expect((meta as any).happier?.kind).toBe('review_comments.v1');
        expect((meta as any).displayText).toBe('Review comments (1)');
        expect((meta as any).sentFrom).toBe('e2e');
    });
});
