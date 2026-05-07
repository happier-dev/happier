import { describe, expect, it } from 'vitest';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createClaudeRemoteStreamedTranscriptSession } from './createClaudeRemoteStreamedTranscriptSession';

describe('createClaudeRemoteStreamedTranscriptSession', () => {
    it('proxies optional ephemeral agent messages when the session client supports them', () => {
        const ephemeralCalls: Array<{
            provider: ACPProvider;
            body: ACPMessageData;
            opts: {
                localId: string;
                createdAt: number;
                updatedAt?: number;
                meta?: Record<string, unknown>;
            };
        }> = [];

        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: () => {},
            sendAgentMessageCommitted: async () => {},
            sendAgentMessageEphemeral: (provider, body, opts) => {
                ephemeralCalls.push({ provider, body, opts });
            },
        });

        expect(session.sendAgentMessageEphemeral).toBeTypeOf('function');

        session.sendAgentMessageEphemeral?.(
            'claude',
            { type: 'message', message: 'Hello' },
            {
                localId: 'segment-1',
                createdAt: 10,
                updatedAt: 20,
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'segment-1',
                        segmentState: 'streaming',
                        updatedAtMs: 20,
                    },
                },
            },
        );

        expect(ephemeralCalls).toEqual([
            {
                provider: 'claude',
                body: { type: 'message', message: 'Hello' },
                opts: {
                    localId: 'segment-1',
                    createdAt: 10,
                    updatedAt: 20,
                    meta: {
                        happierStreamSegmentV1: {
                            v: 1,
                            segmentKind: 'assistant',
                            segmentLocalId: 'segment-1',
                            segmentState: 'streaming',
                            updatedAtMs: 20,
                        },
                    },
                },
            },
        ]);
    });

    it('keeps ephemeral sends unavailable when the session client does not support them', () => {
        const session = createClaudeRemoteStreamedTranscriptSession({
            sendAgentMessage: () => {},
            sendAgentMessageCommitted: async () => {},
        });

        expect(session.sendAgentMessageEphemeral).toBeUndefined();
    });
});
