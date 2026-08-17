import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createReducer } from '@/sync/reducer/reducer';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import type { SessionMessages } from '@/sync/store/domains/messages';

function isCanonicalSessionTranscriptActionOutput(value: unknown): boolean {
    const spec = getActionSpec('session.transcript.get');
    if (!spec?.outputSchema) throw new Error('session.transcript.get output schema is unavailable');
    return spec.outputSchema.safeParse(value).success;
}

function createTestSessionMessages(messages: ReadonlyArray<Message>): SessionMessages {
    const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    return {
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        messagesVersion: 0,
        isLoaded: true,
    };
}

describe('getSessionRecentMessagesForVoiceTool', () => {
    beforeEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: {
                ...settingsDefaults,
                voice: {
                    ...settingsDefaults.voice,
                    privacy: {
                        ...settingsDefaults.voice.privacy,
                        shareRecentMessages: true,
                    },
                },
            },
            sessionMessages: {
                s1: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'hello', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'assistant reply', createdAt: 2 },
                ]),
            },
        }));
        useVoiceTargetStore.getState().setTrackedSessionIds(['s1']);
    });

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessionMessages: {},
        }));
        useVoiceTargetStore.getState().setTrackedSessionIds([]);
    });

    it('returns recent messages from normalized transcript state', async () => {
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({
                sessionId: 's1',
                defaultSessionId: 's1',
                limit: 10,
            }),
        ).resolves.toEqual({
            ok: true,
            sessionId: 's1',
            messages: [
                {
                    id: 'm1',
                    role: 'user',
                    text: 'hello',
                    createdAt: 1,
                },
                {
                    id: 'm2',
                    role: 'assistant',
                    text: 'assistant reply',
                    createdAt: 2,
                },
            ],
            nextCursor: '1:m1',
        });
    });

    it('fails closed for tool args and file paths when privacy fields are omitted', async () => {
        storage.setState((current) => ({
            ...current,
            settings: {
                ...current.settings,
                voice: {
                    ...current.settings.voice,
                    privacy: {
                        ...current.settings.voice.privacy,
                        shareRecentMessages: true,
                        shareToolNames: true,
                    },
                },
            },
            sessionMessages: {
                s1: createTestSessionMessages([
                    {
                        id: 'm_tool',
                        kind: 'tool-call',
                        localId: null,
                        createdAt: 3,
                        children: [],
                        tool: {
                            name: 'read',
                            description: 'Read a file',
                            state: 'completed',
                            input: { path: '/Users/alice/SecretRepo/README.md' },
                            createdAt: 3,
                            startedAt: 3,
                            completedAt: 4,
                        },
                    },
                ]),
            },
        }));

        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({
                sessionId: 's1',
                defaultSessionId: 's1',
                limit: 10,
            }),
        ).resolves.toEqual({
            ok: true,
            sessionId: 's1',
            messages: [
                {
                    id: 'm_tool',
                    role: 'tool',
                    text: 'Tool: read - Read a file',
                    createdAt: 3,
                },
            ],
            nextCursor: '3:m_tool',
        });
    });

    it('uses a stable cursor that does not skip same-timestamp siblings', async () => {
        storage.setState((current) => ({
            ...current,
            sessionMessages: {
                s1: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'oldest', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'same-ts-a', createdAt: 2 },
                    { id: 'm3', kind: 'agent-text', localId: null, text: 'same-ts-b', createdAt: 2 },
                    { id: 'm4', kind: 'agent-text', localId: null, text: 'newest', createdAt: 3 },
                ]),
            },
        }));

        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        const firstPage = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',
            defaultSessionId: 's1',
            limit: 2,
        });

        expect(firstPage).toMatchObject({
            ok: true,
            messages: [
                { id: 'm3', text: 'same-ts-b', createdAt: 2 },
                { id: 'm4', text: 'newest', createdAt: 3 },
            ],
        });

        const secondPage = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',
            defaultSessionId: 's1',
            limit: 2,
            cursor: (firstPage as { nextCursor: string | null }).nextCursor,
        });

        expect(secondPage).toMatchObject({
            ok: true,
            messages: [
                { id: 'm1', text: 'oldest', createdAt: 1 },
                { id: 'm2', text: 'same-ts-a', createdAt: 2 },
            ],
        });
    });

    it('projects the local semantic transcript through the canonical Action result contract', async () => {
        const { getSessionTranscriptForVoiceTool } = await import('./sessionRecentMessages');

        const result = await getSessionTranscriptForVoiceTool({
            sessionId: 's1',
            defaultSessionId: 's1',
            limit: 10,
        });

        expect(result).toEqual({
            ok: true,
            sessionId: 's1',
            items: [
                {
                    id: 'm1',
                    createdAt: 1,
                    semanticRole: 'user',
                    role: 'user',
                    kind: 'message',
                    text: 'hello',
                },
                {
                    id: 'm2',
                    createdAt: 2,
                    semanticRole: 'assistant',
                    role: 'assistant',
                    kind: 'message',
                    text: 'assistant reply',
                },
            ],
            nextCursor: '1:m1',
            hasMore: true,
            diagnostics: {
                rawRowsScanned: 2,
                pagesFetched: 0,
                scanLimitReached: false,
                payloadTruncations: 0,
            },
        });
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });

    it('fails closed when the local projection is asked for an external shareable transcript', async () => {
        const { getSessionTranscriptForVoiceTool } = await import('./sessionRecentMessages');

        const result = await getSessionTranscriptForVoiceTool({
            sessionId: 's1',
            defaultSessionId: 's1',
            projection: 'externalShareableV1',
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'external_shareable_projection_unavailable',
            errorMessage: 'external_shareable_projection_unavailable',
        });
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });
});
