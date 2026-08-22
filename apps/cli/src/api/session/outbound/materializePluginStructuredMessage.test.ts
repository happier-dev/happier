import { describe, expect, it } from 'vitest';

import { materializeCommittedPluginStructuredMessageContent } from './materializePluginStructuredMessage';

describe('materializeCommittedPluginStructuredMessageContent', () => {
    it('leaves generic metadata untouched rather than materializing a pluginTranscriptV1 snapshot', async () => {
        const content = {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: { type: 'message', message: 'preview ready' },
            },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
                happier: {
                    kind: 'acme.preview/preview-card.v1',
                    payload: { previewId: 'preview-1' },
                },
            },
        };

        const result = await materializeCommittedPluginStructuredMessageContent({
            sessionId: 'session-1',
            content,
        });

        expect(result).toBe(content);
        expect(result).not.toMatchObject({ profile: 'pluginTranscriptV1' });
    });
});
