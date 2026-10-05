import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/**
 * The live Voice runtime is the only genuine boundary this projection sits above.
 * `resolveEffectiveVoiceTargetState` runs for real underneath it.
 */
const localVoiceAgentBinding = vi.hoisted(() => ({
    current: null as null | Readonly<{ binding: Readonly<{ targetSessionAddress: SessionAddress | null }> }>,
}));
vi.mock('@/voice/context/resolveActiveLocalVoiceAgentBinding', () => ({
    resolveActiveLocalVoiceAgentBinding: () => localVoiceAgentBinding.current,
}));

import type { Message } from "@happier-dev/session-core/messages";
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createReducer } from "@happier-dev/session-core/reducer";
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
            // A retained transcript is only readable through a stored Session row, which
            // supplies its Home provenance; here that Home is the loaded one.
            sessions: { s1: {
                id: 's1',
                serverId: getActiveServerSnapshot().serverId,
                viewer: { follow: { follows: true, notificationLevel: 'important', includeInVoice: true } },
            } },
            sessionMessages: {
                s1: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'hello', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'assistant reply', createdAt: 2 },
                ]),
            },
        }) as never);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: 'server-a', sessionId: 's1' },
        ]);
    });

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessions: {},
            sessionMessages: {},
        }) as never);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    });

    it('returns recent messages from normalized transcript state', async () => {
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({
                sessionId: 's1',                limit: 10,
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
                sessionId: 's1',                limit: 10,
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
            sessionId: 's1',            limit: 2,
        });

        expect(firstPage).toMatchObject({
            ok: true,
            messages: [
                { id: 'm3', text: 'same-ts-b', createdAt: 2 },
                { id: 'm4', text: 'newest', createdAt: 3 },
            ],
        });

        const secondPage = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',            limit: 2,
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
            sessionId: 's1',            limit: 10,
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
            sessionId: 's1',            projection: 'externalShareableV1',
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'external_shareable_projection_unavailable',
            errorMessage: 'external_shareable_projection_unavailable',
        });
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });
});

describe('voice recent-message and transcript projection Home identity', () => {
    const FOCUSED_HOME_ROWS: ReadonlyArray<Message> = [
        { id: 'm1', kind: 'user-text', localId: null, text: 'focused home secret', createdAt: 1 },
        { id: 'm2', kind: 'agent-text', localId: null, text: 'focused home reply', createdAt: 2 },
    ];

    function seedFocusedHomeTranscript(
        otherSessionsSnippetsMode: 'always' | 'never' | 'on_demand_only',
    ): string {
        const activeServerId = getActiveServerSnapshot().serverId;
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
                    ui: {
                        ...settingsDefaults.voice.ui,
                        updates: {
                            ...settingsDefaults.voice.ui.updates,
                            otherSessionsSnippetsMode,
                        },
                    },
                },
            },
            // The focused Home owns both the retained transcript and the live Voice context.
            sessions: { s1: { id: 's1', serverId: activeServerId } },
            sessionMessages: { s1: createTestSessionMessages(FOCUSED_HOME_ROWS) },
        }) as never);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: activeServerId, sessionId: 's1' },
        ]);
        return activeServerId;
    }

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessions: {},
            sessionMessages: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
        }) as never);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        localVoiceAgentBinding.current = null;
    });

    it('classifies an Action bound to another Home as a non-active target instead of matching the focused Home', async () => {
        seedFocusedHomeTranscript('never');
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: 'home-b', limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('never returns the focused Home transcript for a same-named Session on the requested Home', async () => {
        const activeServerId = seedFocusedHomeTranscript('always');
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: 'home-b', limit: 10 }),
        ).resolves.toEqual({ ok: true, sessionId: 's1', messages: [], nextCursor: null });

        const focused = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',
            serverId: activeServerId,
            limit: 10,
        });
        expect(focused).toMatchObject({
            ok: true,
            messages: [
                { id: 'm1', role: 'user', text: 'focused home secret' },
                { id: 'm2', role: 'assistant', text: 'focused home reply' },
            ],
        });
    });

    it('keeps the canonical transcript projection bound to the requested Home', async () => {
        seedFocusedHomeTranscript('always');
        const { getSessionTranscriptForVoiceTool } = await import('./sessionRecentMessages');

        const result = await getSessionTranscriptForVoiceTool({ sessionId: 's1', serverId: 'home-b', limit: 10 });

        expect(result).toMatchObject({
            ok: true,
            sessionId: 's1',
            items: [],
            nextCursor: null,
            hasMore: false,
            diagnostics: { rawRowsScanned: 0 },
        });
        expect(JSON.stringify(result)).not.toContain('focused home secret');
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });

    it('refuses an unqualified invocation when the session id exists on more than one known Home', async () => {
        seedFocusedHomeTranscript('always');
        storage.setState((current) => ({
            ...current,
            sessionListRowsByServerId: {
                'home-b': { s1: { id: 's1', updatedAt: 7 } },
            },
            ordinarySessionListMembershipByServerId: {
                'home-b': ['s1'],
            },
        }) as never);
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'session_ambiguous',
            errorMessage: 'session_ambiguous',
        });
    });

    it('refuses an unqualified invocation for a session id local state does not know', async () => {
        // The retained transcript survives, but nothing proves which Home owns it, so the
        // focused Home must not be substituted for the Home the Action host failed to bind.
        seedFocusedHomeTranscript('always');
        storage.setState((current) => ({ ...current, sessions: {} }) as never);
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'session_not_found',
            errorMessage: 'session_not_found',
        });
    });
});

describe('voice recent-message live-context qualification', () => {
    const ROWS: ReadonlyArray<Message> = [
        { id: 'm1', kind: 'user-text', localId: null, text: 'bound session text', createdAt: 1 },
    ];

    function seedBoundHomeTranscript(): string {
        const activeServerId = getActiveServerSnapshot().serverId;
        storage.setState((current) => ({
            ...current,
            settings: {
                ...settingsDefaults,
                voice: {
                    ...settingsDefaults.voice,
                    privacy: { ...settingsDefaults.voice.privacy, shareRecentMessages: true },
                    ui: {
                        ...settingsDefaults.voice.ui,
                        updates: { ...settingsDefaults.voice.ui.updates, otherSessionsSnippetsMode: 'never' },
                    },
                },
            },
            sessions: { s1: { id: 's1', serverId: activeServerId } },
            sessionMessages: { s1: createTestSessionMessages(ROWS) },
            sessionListRowsByServerId: {},
        }) as never);
        // Attempt-local context starts empty and cannot substitute for Account Follow consent.
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        return activeServerId;
    }

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessions: {},
            sessionMessages: {},
        }) as never);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        localVoiceAgentBinding.current = null;
    });

    it('uses the synchronized exact-Home Include in Voice projection as disclosure authority', async () => {
        const activeServerId = seedBoundHomeTranscript();
        storage.setState((current) => ({
            ...current,
            sessionListRowsByServerId: {
                ...current.sessionListRowsByServerId,
                [activeServerId]: {
                    s1: {
                        id: 's1',
                        viewer: {
                            follow: { follows: true, notificationLevel: 'important', includeInVoice: true },
                        },
                    },
                },
            },
        }) as never);
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toMatchObject({
            ok: true,
            messages: [{ id: 'm1', role: 'user', text: 'bound session text' }],
        });
    });

    it('does not treat an attempt-local live-context address as disclosure consent', async () => {
        const activeServerId = seedBoundHomeTranscript();
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: activeServerId, sessionId: 's1' },
        ]);
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('reflects an external Follow projection change without consulting stale attempt-local state', async () => {
        const activeServerId = seedBoundHomeTranscript();
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: activeServerId, sessionId: 's1' },
        ]);
        storage.setState((current) => ({
            ...current,
            sessionListRowsByServerId: {
                ...current.sessionListRowsByServerId,
                [activeServerId]: {
                    s1: {
                        id: 's1',
                        viewer: {
                            follow: { follows: true, notificationLevel: 'important', includeInVoice: false },
                        },
                    },
                },
            },
        }) as never);
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('still refuses a Session that is neither bound nor in the live context', async () => {
        const activeServerId = seedBoundHomeTranscript();
        localVoiceAgentBinding.current = {
            binding: { targetSessionAddress: { serverId: activeServerId, sessionId: 'other-session' } },
        };
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('does not treat the primary Action target as live-context disclosure consent', async () => {
        const activeServerId = seedBoundHomeTranscript();
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: activeServerId, sessionId: 's1' });
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });
});
