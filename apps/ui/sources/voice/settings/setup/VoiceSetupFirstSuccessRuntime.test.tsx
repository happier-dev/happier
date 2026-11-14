import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { z } from 'zod/mini';
import { readStoredSessionMessages, type Message } from '@happier-dev/session-core/messages';
import type { PartialOptions } from '@elevenlabs/client';
import { PendingLocalIdSchema } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { pendingDeliveryStatusV1ToPersistedFields, type PendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { VoiceAgentTurnV1Schema } from '@happier-dev/protocol/messages/structured/voiceAgentTurnV1';
import { UsageTimingBoundsV1Schema } from '@happier-dev/protocol/usage/usageWorkEvidence';

import { renderScreen, waitForTestEvent } from '@/dev/testkit';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { normalizeVoiceSettingsServerDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { CanonicalVoiceTranscriptAttempt } from '@/voice/transcript/canonicalProjector';

// The exercised SDK is the web transport; jsdom alone does not select the
// platform supplied by React Native's OS boundary.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'web' },
}));
// Install the Socket/network SDK before Sync and provider consumers retain it.
const network = await installSessionOpsNetworkBoundary();
const providerMessages: string[] = [];
vi.doMock('@elevenlabs/client/web', () => ({ Conversation: {
    async startSession(options: PartialOptions) {
        options.onConnect?.({ conversationId: 'first-success-provider-conversation' });
        return { getId: () => 'first-success-provider-conversation', endSession: async () => {},
            setVolume: (_input: { volume: number }) => {}, setMicMuted: (_muted: boolean) => {},
            sendUserMessage: (text: string) => { providerMessages.push(text); },
            sendContextualUpdate: (_text: string) => {} };
    },
} }));
await loadSyncSingletonForTests();
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
const { buildVoiceTranscriptHistorySessionMetadata } = await import('@/voice/persistence/voiceTranscriptHistorySession');
const { writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
const { getVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
const { voiceSessionManager } = await import('@/voice/session/voiceSession');
const { readVoiceSessionOwnerMetadataFromState } = await import('@/voice/shared/readVoiceSessionOwnerMetadata');
const { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } = await import('@/components/voice/attempt/useVoiceAttemptControl');
const { VoiceComposerPlanet } = await import('@/components/voice/composer/VoiceComposerPlanet');
const { VoiceMarkArt } = await import('@/components/voice/presence/VoiceMark');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { getVoiceSessionPresentedAttemptId, resetVoiceSessionRuntimeStateForTests, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { beginCanonicalVoiceTranscriptAttempt, projectCanonicalVoiceTranscriptEvent, releaseCanonicalVoiceTranscriptConversation } = await import('@/voice/transcript/voiceConversationTranscript');
const { deriveCanonicalVoiceTranscriptEntryId } = await import('@/voice/transcript/canonicalProjector');
const { sendVoiceSessionComposerText } = await import('@/voice/binding/sendVoiceSessionComposerText');
const { VoiceSetupFirstSuccessRuntime } = await import('./VoiceSetupFirstSuccessRuntime');
const { VoiceSetupPanel } = await import('./VoiceSetupPanel');
const { useVoiceSetupBlock } = await import('./VoiceSetupItem');
const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
const initialAdapters = getVoiceAdapterRegistry().list();
const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
let homeSequence = 0;
const pendingPostSchema = z.strictObject({ localId: PendingLocalIdSchema, content: StrictSessionStoredMessageContentEnvelopeSchema,
    messageRole: z.literal('user'), deliveryMode: z.optional(z.literal('external_handoff')),
    requestedAction: PendingRequestedActionV1Schema, targetMachineId: z.optional(z.string()),
    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)) });
const messagePostSchema = z.strictObject({ localId: z.string().check(z.minLength(1)),
    content: StrictSessionStoredMessageContentEnvelopeSchema, messageRole: SessionMessageRoleSchema,
    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)) });

it.each([
    { source: 'canonical', endBeforeReply: false, restartBeforeInput: false },
    { source: 'canonical', endBeforeReply: true, restartBeforeInput: false },
    { source: 'durable', endBeforeReply: false, restartBeforeInput: false },
    { source: 'durable', endBeforeReply: true, restartBeforeInput: false },
    { source: 'durable', endBeforeReply: false, restartBeforeInput: false, replyBeforeInput: true },
    { source: 'canonical', endBeforeReply: true, restartBeforeInput: true },
] as const)('publishes one observed $source completion to real setup and composer consumers (reply after End: $endBeforeReply, second Try: $restartBeforeInput, reply persisted first: $replyBeforeInput)', async (scenario) => {
    const { source, endBeforeReply, restartBeforeInput } = scenario;
    const replyBeforeInput = 'replyBeforeInput' in scenario && scenario.replyBeforeInput;
    const initial = storage.getState();
    const locks = installWebLockManagerMock();
    network.resetRequests();
    providerMessages.length = 0;
    const artifact = createHomeHubArtifactHttpBoundary('completion-account');
    const metadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const prompts = createPromptLibraryCatalogBoundary({ settingsVersion: 1 });
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.pendingInput = { protocolVersion: 1 };
    features.features.voice.enabled = true;
    features.features.voice.happierVoice.enabled = true;
    const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'completion-account' });
    const settings = voiceSettingsParse({ providerId, executionMachine: { mode: 'fixed', machineId: machine.id },
        providers: { [providerId]: { schemaVersion: 1, config: { billingMode: 'happier' } } } });
    let pending: z.infer<typeof pendingPostSchema> | null = null;
    let deliveryStatus: PendingDeliveryStatusV1 | null = null;
    let messageSequence = 10;
    const transcriptWrites: z.infer<typeof messagePostSchema>[] = [];
    const httpEvents: string[] = [];
    const connection = await restoreServerAccountForTest({ serverUrl: `https://voice-completion-${++homeSequence}.example.test`,
        accountId: 'completion-account', credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain',
                v: normalizeVoiceSettingsServerDelta({ voice: settings }) }, version: 1 });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` && init?.method === 'POST') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v1/machines') return Response.json([machine]);
            if (path === '/v1/machines/machine-1') return Response.json({ machine });
            if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'completion-token', leaseId: 'completion-lease',
                bindingNonce: 'completion-binding', expiresAtMs: Date.now() + 60_000 } satisfies import('@/sync/api/voice/apiVoice').VoiceTokenResponse);
            if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ success: true });
            if (path.endsWith('/messages')) {
                if (init?.method === 'POST') {
                    const message = messagePostSchema.parse(JSON.parse(String(init.body)));
                    transcriptWrites.push(message);
                    return Response.json({ didWrite: true, message: { id: `completion-message-${++messageSequence}`,
                        localId: message.localId, seq: messageSequence, createdAt: 1 } });
                }
                return Response.json({ messages: [], hasMore: false });
            }
            const promptResponse = await prompts.handle(path, init);
            if (promptResponse) return promptResponse;
            const pendingPath = '/v2/sessions/conversation/pending';
            if (path === pendingPath && init?.method === 'POST') {
                pending = pendingPostSchema.parse(JSON.parse(String(init.body)));
                expect(pending.deliveryMode).toBe('external_handoff');
                deliveryStatus = { status: 'external_handoff' };
                httpEvents.push(`enqueue:${pending.localId}`);
                return Response.json({ didWrite: true, requestedAction: pending.requestedAction,
                    pending: { localId: pending.localId, deliveryStatus } });
            }
            if (path === `${pendingPath}/durable-current-input/delivery/handled`) {
                httpEvents.push('handled:durable-current-input');
                deliveryStatus = null;
                return Response.json({ success: true });
            }
            if (path === pendingPath) {
                if (!pending || !deliveryStatus) return Response.json({ pending: [] });
                const fields = pendingDeliveryStatusV1ToPersistedFields(deliveryStatus);
                return Response.json({ pending: [{ localId: pending.localId, messageRole: pending.messageRole, content: pending.content,
                    requestedAction: pending.requestedAction, status: fields.status, deliveryStatus,
                    ...(fields.deliveryState ? { deliveryState: fields.deliveryState } : {}),
                    position: 1, createdAt: 1, updatedAt: 1, discardedAt: null, discardedReason: fields.discardedReason,
                    authorAccountId: 'completion-account', accountActor: null }] });
            }
            const response = await artifact.request(input, init);
            return response.status === 404 ? await metadata.handle(input, init)
                ?? createEmptyAccountBootstrapHttpResponse(path, init) : response;
        }) });
    const scope = { serverId: connection.home.id, accountId: 'completion-account' };
    const conversation = { serverId: connection.home.id, sessionId: 'conversation' };
    const binding = { adapterId: 'local_conversation', controlSessionId: 'control', conversationSessionId: conversation.sessionId,
        conversationSessionAddress: conversation, transcriptMode: 'synthetic' as const, lifetime: 'runtime_attempt' as const,
        targetSessionAddress: null, updatedAt: 1 };
    const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
        conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
    let messages: readonly Message[] = [
        { kind: 'user-text', id: 'input', localId: 'voice-realtime:current:user:input', seq: 11, createdAt: 1, text: 'hello', meta },
        { kind: 'agent-text', id: 'reply', localId: 'voice-realtime:current:assistant:reply', seq: 12, createdAt: 2, text: 'Hi', meta },
    ];
    let canonicalAttempt: CanonicalVoiceTranscriptAttempt | null = null;
    const publish = (rows: readonly Message[]) => storage.setState((state) => ({
        sessionMessages: { ...state.sessionMessages, conversation: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: rows.map((row) => row.id), messagesById: Object.fromEntries(rows.map((row) => [row.id, row])) }) },
    }));
    function Scene() {
        const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
        const setup = useVoiceSetupBlock({ layout: 'wide', inPlace: true,
            attemptTarget: { kind: 'session', sessionAddress: conversation } });
        return <>
            {source === 'durable' ? <VoiceSessionRuntime /> : <VoiceSetupFirstSuccessRuntime />}
            {setup?.renderPanel?.({ close() {} })}
            <VoiceComposerPlanet pose="ready" muted={false} markEvent={control.markEvent}
                accessibilityLabel="Voice" accessibilityHint="Voice" onPress={() => {}} />
        </>;
    }
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    const carrierDelivery = observeStorageSubscriptionDeliveries((paths, origin) =>
        origin.includes('/voice/session/VoiceSessionRuntime.tsx') && paths.some(path => path[1] === 'sessions'));
    try {
        const session = createSessionFixture({ id: 'conversation', serverId: scope.serverId, seq: 10 });
        if (!session.metadata) throw new Error('Conversation Session metadata missing');
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope,
            sessions: { conversation: { ...session, metadata: writeVoiceConversationScopeMetadata(
                { ...session.metadata, ...buildVoiceTranscriptHistorySessionMetadata() }, { kind: 'voice_home' }) } } });
        publish([]);
        if (source === 'canonical') canonicalAttempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: conversation.sessionId });
        else await sync.refreshAccountSettingsFromServer(1, scope);
        setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
        screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}><Scene /></InjectedAuthProvider>);
        let starting: Promise<void> | undefined;
        if (source === 'durable') await act(async () => { starting = voiceSessionManager.toggle(conversation); });
        await act(async () => {
            if (source === 'durable') {
                await starting;
                const adapter = getVoiceAdapterRegistry().get(providerId);
                if (!adapter) throw new Error('Expected the actual provider adapter');
                expect(adapter.getSnapshot()).toMatchObject({ status: 'connected' });
                expect(getVoiceSessionPresentedAttemptId()).not.toBeNull();
            } else {
                voiceSessionBindingStore.getState().bind(binding);
                setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId,
                    status: 'connected', mode: 'listening', canStop: true }, binding, { accountScope: scope, conversationScope: { kind: 'voice_home' } });
            }
        });
        if (source === 'durable') {
            // The mounted runtime publishes the continuation from an effect.
            // Let the Start act flush that effect before awaiting its HTTP ACK.
            await waitForTestEvent(storage.subscribe,
                () => readStoredSessionMessages(storage.getState(), conversation.sessionId),
                rows => rows.some(row => row.localId === transcriptWrites[0]?.localId
                    && row.realID === 'completion-message-11' && row.seq === 11));
            expect(readStoredSessionMessages(storage.getState(), conversation.sessionId))
                .toEqual(expect.arrayContaining([expect.objectContaining({
                    localId: transcriptWrites[0]?.localId, realID: 'completion-message-11', seq: 11,
                })]));
            expect(transcriptWrites).toEqual([expect.objectContaining({ messageRole: 'agent',
                content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
                    happier: expect.objectContaining({ kind: 'voice_note.v1' }),
                }) }) } })]);
        }
        if (restartBeforeInput) await act(async () => {
            setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            if (!canonicalAttempt) throw new Error('Expected canonical attempt');
            await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: conversation.sessionId,
                attemptIdentity: canonicalAttempt.attemptIdentity });
            canonicalAttempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: conversation.sessionId });
            setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId,
                status: 'connected', mode: 'listening', canStop: true }, binding, { accountScope: scope, conversationScope: { kind: 'voice_home' } });
        });
        await act(async () => {
            if (source === 'canonical') {
                if (!canonicalAttempt) throw new Error('Expected canonical attempt');
                messages = messages.map((message) => ({ ...message, localId: deriveCanonicalVoiceTranscriptEntryId({
                    attemptIdentity: canonicalAttempt!.attemptIdentity, role: message.kind === 'user-text' ? 'user' : 'assistant',
                    itemId: message.kind === 'user-text' ? 'input' : 'reply',
                }) }));
                expect(projectCanonicalVoiceTranscriptEvent({ conversationSessionId: conversation.sessionId,
                    event: { v: 1, type: 'voice.transcript.updated', epoch: canonicalAttempt.epoch, sequence: 1,
                        revision: 1, eventId: 'input-live', itemId: 'input', role: 'user', text: 'hello', provenance: 'live' } })?.status).toBe('applied');
            } else {
                messages = messages.map((message) => ({ ...message,
                    seq: message.kind === 'user-text' ? messageSequence + (replyBeforeInput ? 2 : 1) : messageSequence + (replyBeforeInput ? 1 : 2),
                    localId: message.kind === 'user-text' ? 'durable-current-input' : 'durable-current-reply',
                    // Local capture's retained input and the daemon reply have
                    // different envelopes, as observed in the composed ship journey.
                    meta: message.kind === 'user-text' ? meta : { happier: { kind: 'voice_agent_turn.v1',
                        payload: VoiceAgentTurnV1Schema.parse({ v: 1, epoch: 1, voiceAgentId: 'current-agent',
                            role: 'assistant', ts: message.createdAt }) } },
                }));
                expect(await sendVoiceSessionComposerText({ conversationSessionId: conversation.sessionId, text: 'hello',
                    localId: 'durable-current-input', getAdapter: getVoiceAdapterRegistry().get,
                    sessionMetadata: readVoiceSessionOwnerMetadataFromState(storage.getState(), conversation) }))
                    .toEqual({ ok: true, localId: 'durable-current-input', disposition: 'settled' });
                // The same vendor SDK also carries the real session-context
                // update emitted after the continuation note was acknowledged.
                // Observe the submitted turn, not unrelated valid context sends.
                expect(providerMessages.filter(text => text === 'hello')).toEqual(['hello']);
                expect(httpEvents).toEqual(['enqueue:durable-current-input', 'handled:durable-current-input']);
                expect(storage.getState().sessionPending.conversation?.messages ?? []).toEqual([]);
            }
        });
        if (!restartBeforeInput) await act(async () => publish([messages[0]!]));
        const events = () => screen!.findAllByType(VoiceMarkArt).map((mark) => mark.props.event);
        expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)).toBeNull();
        expect(screen.findByType(VoiceSetupPanel).props.model.facts.firstTurnComplete).toBe(false);
        expect(events()).toEqual([null, null]);
        const attemptId = getVoiceSessionPresentedAttemptId();
        if (endBeforeReply) await act(async () => {
            if (source === 'durable') await voiceSessionManager.stop(conversation.sessionId);
            else {
                setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
                voiceSessionBindingStore.getState().unbind(conversation.sessionId);
            }
            if (canonicalAttempt) await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: conversation.sessionId,
                attemptIdentity: canonicalAttempt.attemptIdentity });
        });
        await act(async () => publish(messages));
        expect(screen.findByType(VoiceSetupPanel).props.model.facts.firstTurnComplete).toBe(true);
        const completed = events();
        expect(completed).toEqual([{ kind: 'gather', id: `${attemptId}:first-success` }, { kind: 'gather', id: `${attemptId}:first-success` }]);
        await act(async () => publish([...messages]));
        expect(events()[0]).toBe(completed[0]);
        expect(events()[1]).toBe(completed[1]);
        if (source === 'durable' && !endBeforeReply && !replyBeforeInput) {
            carrierDelivery.reset();
            for (let index = 0; index < 5; index++) await act(async () => {
                storage.setState(state => ({ sessions: { ...state.sessions,
                    unrelated: createSessionFixture({ id: 'unrelated', serverId: scope.serverId, seq: index }),
                } }));
            });
            expect(carrierDelivery.count).toBe(0);
            const admitted = voiceSessionBindingStore.getState().getByControlSessionId(conversation.sessionId);
            if (!admitted) throw new Error('Expected the actual mounted runtime binding');
            const nextConversation = { serverId: scope.serverId, sessionId: 'next-conversation' };
            await act(async () => {
                storage.setState(state => ({ sessions: { ...state.sessions,
                    [nextConversation.sessionId]: createSessionFixture({ id: nextConversation.sessionId, serverId: scope.serverId, seq: 20 }),
                } }));
                voiceSessionBindingStore.getState().bind({ ...admitted, conversationSessionId: nextConversation.sessionId,
                    conversationSessionAddress: nextConversation, updatedAt: admitted.updatedAt + 1 });
            });
            const { getVoiceSessionPresentedBinding } = await import('@/voice/session/voiceSessionStore');
            expect(getVoiceSessionPresentedBinding()?.conversationSessionAddress).toEqual(nextConversation);
            await waitForTestEvent(storage.subscribe,
                () => readStoredSessionMessages(storage.getState(), nextConversation.sessionId),
                rows => rows.some(row => row.localId === transcriptWrites.at(-1)?.localId && row.realID !== undefined));
            carrierDelivery.reset();
            await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
                [conversation.sessionId]: { ...state.sessions[conversation.sessionId]!, seq: 30 },
            } })); });
            expect(carrierDelivery.count).toBe(0);
            await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
                [nextConversation.sessionId]: { ...state.sessions[nextConversation.sessionId]!, seq: 31 },
            } })); });
            expect(carrierDelivery.count).toBeGreaterThan(0);
        }
    } finally {
        const lifecycle = source === 'durable' ? getVoiceSessionLifecycleController() : null;
        await screen?.unmount();
        await lifecycle?.dispose();
        if (lifecycle) await waitForTestEvent(getVoiceAdapterRegistry().subscribe!, () => expect(getVoiceSessionLifecycleController()).not.toBe(lifecycle));
        registerVoiceAdapters(initialAdapters);
        if (canonicalAttempt) await releaseCanonicalVoiceTranscriptConversation({
            conversationSessionId: conversation.sessionId, attemptIdentity: canonicalAttempt.attemptIdentity,
        });
        voiceSessionBindingStore.getState().unbind(conversation.sessionId);
        voiceSessionBindingStore.getState().unbind('next-conversation');
        carrierDelivery.restore();
        await resetVoiceSessionRuntimeStateForTests();
        await connection.dispose();
        locks.restore();
        storage.setState(initial, true);
    }
});
