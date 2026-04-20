import { describe, expect, it } from 'vitest';

import { selectVoiceTranscriptEntriesForConversationSession } from './voiceTranscriptSelectors';

describe('voiceTranscriptSelectors', () => {
    it('does not classify assistant transcript text as a note solely because it starts with the legacy [Voice] prefix', () => {
        const entries = selectVoiceTranscriptEntriesForConversationSession(
            {
                sessionMessages: {
                    'carrier-s1': {
                        messages: [
                            {
                                id: 'm-assistant',
                                localId: 'm-assistant',
                                createdAt: 200,
                                isSidechain: false,
                                role: 'agent',
                                content: [{ type: 'text', text: '[Voice] legacy-looking assistant text', uuid: 'u2', parentUUID: null }],
                            },
                        ],
                    },
                },
            },
            'carrier-s1',
        );

        expect(entries).toEqual([
            { createdAt: 200, id: 'm-assistant', kind: 'assistant', text: '[Voice] legacy-looking assistant text' },
        ]);
    });
});
