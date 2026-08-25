import { describe, expect, it } from 'vitest';

import { buildPluginEventAutomationExistingSessionOptions } from './pluginEventAutomationExistingSessionOptions';

describe('buildPluginEventAutomationExistingSessionOptions', () => {
    it('omits a hidden Voice History carrier from the raw-session fallback while keeping normal sessions', () => {
        const options = buildPluginEventAutomationExistingSessionOptions({
            sessionListItems: [],
            sessionListRowRenderablesByKey: new Map(),
            sessions: [
                {
                    id: 'voice-history',
                    serverId: 'server-a',
                    metadata: {
                        systemSessionV1: {
                            v: 1,
                            key: 'voice_transcript_history',
                            hidden: true,
                        },
                    },
                },
                {
                    id: 'normal-session',
                    serverId: 'server-a',
                    metadata: {
                        summary: { text: 'Normal session' },
                    },
                },
            ],
        });

        expect(options.map((option) => option.sessionId)).toEqual(['normal-session']);
    });
});
