import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { z } from 'zod/mini';
import { createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import type { VoiceAdapterController } from '@/voice/session/types';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';
import { SESSION_RPC_METHODS, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
    ExecutionRunTurnStreamReadResponseSchema, ExecutionRunTurnStreamCancelResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { PendingLocalIdSchema } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { parsePendingDeliveryStatusV1, pendingDeliveryStatusV1ToPersistedFields, type PendingDeliveryStatusV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { PartialOptions } from '@elevenlabs/client';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { UsageTimingBoundsV1Schema } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ExecutionRunEnsureOrStartRequestSchema, ExecutionRunEnsureOrStartResponseSchema, ExecutionRunEnsureResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import type { ExternalActionRequesterInvocationBaseV1 } from '@happier-dev/protocol/sessions/creation/externalActionRequesterInvocationBaseV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));

// Install transport before any consumer can retain the real Sync/Socket singleton.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { removePendingOutboxMessage, markPendingOutboxMessageCancelRequested, loadPendingOutboxForSession } = await import('@/sync/domains/state/pendingOutboxPersistence');
const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { buildVoiceTranscriptHistorySessionMetadata } = await import('@/voice/persistence/voiceTranscriptHistorySession');
const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');

const initialStorageState = getStorage().getState();
const initialRegisteredAdapters = getVoiceAdapterRegistry().list();
const composerVoiceSettings = voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 1, config: { billingMode: 'happier' } } },
});

// These are HTTP payloads, not a second Pending owner. The actual Sync codecs,
// durable outbox and row projections consume the response below.
const pendingPostSchema = z.strictObject({
    localId: PendingLocalIdSchema,
    content: StrictSessionStoredMessageContentEnvelopeSchema,
    messageRole: z.literal('user'),
    deliveryMode: z.optional(z.literal('external_handoff')),
    requestedAction: PendingRequestedActionV1Schema,
    targetMachineId: z.optional(z.string()),
    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
});
type PendingPost = z.infer<typeof pendingPostSchema>;
let enqueued: PendingPost | null = null;
let deliveryStatus: PendingDeliveryStatusV1 | null = null;
const retainedInputs: { post: PendingPost; deliveryStatus: PendingDeliveryStatusV1 }[] = [];
let terminalResponse: 'reject' | 'missing_handoff' | null = null;
let handledResponse: (() => Promise<Response>) | null = null;
let cancelAfterEnqueue = false;
let settleAfterEnqueue = false;
let enqueueNetworkFailure = false;
let refreshBeforeEnqueueAck = false;
let changeControlBeforeEnqueueAck = false;
let rejectBlock = false;
let providerSendFailure: Error | null = null;
let composerAssembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>> | null = null;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const currentnessHttpStatuses: number[] = [];
const httpEvents: string[] = [];
let homeSequence = 0;
const providerMessages: string[] = [];
let actionBoundaries: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>[] = [];

// ElevenLabs' network/media SDK is the system boundary; the real plugin codecs,
// SDK handle, host controller, adapter, binding and Sync custody stay in use.
vi.doMock('@elevenlabs/client/web', () => ({ Conversation: {
    async startSession(options: PartialOptions) {
        options.onConnect?.({ conversationId: 'composer-provider-conversation' });
        return {
            getId: () => 'composer-provider-conversation',
            endSession: async () => {},
            setVolume: (_input: { volume: number }) => {},
            setMicMuted: (_muted: boolean) => {},
            sendUserMessage(text: string) {
                providerMessages.push(text);
                httpEvents.push(`provider:${text}`);
                if (providerSendFailure) throw providerSendFailure;
            },
            sendContextualUpdate: (_text: string) => {},
        };
    },
} }));

async function restorePendingHttpAccount() {
    actionBoundaries = [];
    network.resetRequests();
    enqueued = null;
    deliveryStatus = null;
    retainedInputs.length = 0;
    terminalResponse = null;
    handledResponse = null;
    cancelAfterEnqueue = false;
    settleAfterEnqueue = false;
    enqueueNetworkFailure = false;
    refreshBeforeEnqueueAck = false;
    changeControlBeforeEnqueueAck = false;
    rejectBlock = false;
    providerSendFailure = null;
    httpEvents.length = 0;
    providerMessages.length = 0;
    currentnessHttpStatuses.length = 0;
    const metadata = createSessionMetadataHttpBoundary(() => getStorage().getState().sessions);
    const promptCatalog = createPromptLibraryCatalogBoundary({ settingsVersion: 1 });
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    const kv = createAccountKvHttpFixture();
    const features = createRootLayoutFeaturesResponse();
    const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'composer-account' });
    features.capabilities.session.pendingInput = { protocolVersion: 1 };
    features.features.voice.enabled = true;
    features.features.voice.happierVoice.enabled = true;
    account = await restoreServerAccountForTest({
        // Distinct real Home lifetimes keep outstanding bootstrap reads from a
        // preceding case from becoming this case's HTTP snapshot.
        serverUrl: `https://voice-composer-${++homeSequence}.example.test`, accountId: 'composer-account', credentialScope: 'restored-home',
        serverIdentityId: `srv_voice_composer_${homeSequence}`,
        credentials: { token: createAccountTokenForTests('composer-account', { currentAccount: true }) },
        request: createSessionReadBatchFetchBoundary(async (input, init) => {
            for (const boundary of actionBoundaries) {
                const response = await boundary.handle(new URL(String(input)), init);
                if (response) return response;
            }
            const path = new URL(String(input)).pathname;
            const kvResponse = await kv.handleFetch(input, init);
            if (kvResponse) return kvResponse;
            const purposeResponse = await purposes.handle(input, init);
            if (purposeResponse) return purposeResponse;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'composer-account' }));
            if (path === '/v1/account/encryption/currentness') {
                currentnessHttpStatuses.push(200);
                return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
            }
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { voice: composerVoiceSettings } }, version: 1 });
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v1/machines') return Response.json([machine]);
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
              id => id === machine.id ? machine : null);
            if (path === '/v1/machines/machine-1') return Response.json({ machine });
            if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
            const promptResponse = await promptCatalog.handle(path, init);
            if (promptResponse) return promptResponse;
            if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'composer-token', leaseId: 'composer-lease',
                bindingNonce: 'composer-binding', expiresAtMs: Date.now() + 60_000 } satisfies import('@/sync/api/voice/apiVoice').VoiceTokenResponse);
            if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ success: true });
            const pending = '/v2/sessions/carrier-s1/pending';
            if (path === pending && init?.method === 'POST') {
                enqueued = pendingPostSchema.parse(JSON.parse(String(init.body)));
                httpEvents.push(`enqueue:${enqueued.localId}`);
                if (enqueueNetworkFailure) throw new TypeError('fetch failed');
                const acknowledgedStatus: PendingDeliveryStatusV1 = enqueued.deliveryMode === 'external_handoff'
                    ? { status: 'external_handoff' } : { status: 'queued' };
                deliveryStatus = acknowledgedStatus;
                if (changeControlBeforeEnqueueAck) {
                    const adapter = getVoiceAdapterRegistry().get('happier.voice.elevenlabs/realtime-elevenlabs');
                    if (!adapter || !account) throw new Error('Actual lifecycle owner is unavailable');
                    getStorage().getState().applySessions([createSessionFixture({ id: 'other-s2', serverId: account.serverId })]);
                    await adapter.stop({ sessionId: 'carrier-s1' });
                    await adapter.start({ sessionId: 'other-s2', requestedTargetSessionAddress: { serverId: account.serverId, sessionId: 'other-s2' },
                        initialContext: '', textOnly: true });
                }
                if (refreshBeforeEnqueueAck) {
                    await sync.fetchPendingMessages('carrier-s1');
                    expect(pendingRows()).toEqual([expect.objectContaining({ localId: enqueued.localId,
                        pendingDeliveryStatus: 'external_handoff', source: 'server_pending' })]);
                    httpEvents.push(`snapshot-applied:${enqueued.localId}`);
                }
                if (cancelAfterEnqueue) {
                    if (!account) throw new Error('HTTP fixture requires its restored Account');
                    await markPendingOutboxMessageCancelRequested('carrier-s1', enqueued.localId,
                        { serverId: account.serverId, accountId: 'composer-account' });
                }
                if (settleAfterEnqueue) {
                    if (!account) throw new Error('HTTP fixture requires its restored Account');
                    await sync.markPendingDeliveryHandled('carrier-s1', enqueued.localId);
                    await removePendingOutboxMessage('carrier-s1', enqueued.localId,
                        { serverId: account.serverId, accountId: 'composer-account' });
                }
                if (terminalResponse === 'reject') return Response.json({ error: 'invalid-params' }, { status: 400 });
                if (refreshBeforeEnqueueAck) httpEvents.push(`ack:${enqueued.localId}`);
                return Response.json({ didWrite: true, requestedAction: enqueued.requestedAction,
                    pending: { localId: enqueued.localId,
                        deliveryStatus: terminalResponse === 'missing_handoff' ? { status: 'queued' } : acknowledgedStatus } });
            }
            if (path.endsWith('/delivery/handled')) {
                httpEvents.push(`settle:${decodeURIComponent(path.split('/').at(-3)!)}`);
                if (handledResponse) return await handledResponse();
                deliveryStatus = null;
                return Response.json({ success: true });
            }
            if (path.endsWith('/delivery/block')) {
                if (rejectBlock) return Response.json({ error: 'internal-server-error' }, { status: 500 });
                const { reason } = z.strictObject({ reason: z.string() }).parse(JSON.parse(String(init?.body)));
                deliveryStatus = parsePendingDeliveryStatusV1({ status: 'blocked', reason });
                if (!deliveryStatus) throw new Error('Invalid HTTP blocked-delivery fixture');
                return Response.json({ success: true });
            }
            if (path === pending) {
                const inputs = [...retainedInputs, ...(deliveryStatus && enqueued ? [{ post: enqueued, deliveryStatus }] : [])];
                // Match pendingRoutes.toPendingJson, including its omitted null
                // delivery fields. Domain status conversion stays protocol-owned.
                return Response.json({ pending: inputs.map(({ post, deliveryStatus }, index) => {
                  const persisted = pendingDeliveryStatusV1ToPersistedFields(deliveryStatus);
                  return {
                    localId: post.localId, messageRole: post.messageRole, content: post.content,
                    requestedAction: post.requestedAction, status: persisted.status, deliveryStatus,
                    ...(persisted.deliveryState ? { deliveryState: persisted.deliveryState } : {}),
                    ...(persisted.deliveryBlockedReason ? { deliveryBlockedReason: persisted.deliveryBlockedReason } : {}),
                    position: index + 1, createdAt: 1, updatedAt: 1, discardedAt: null,
                    discardedReason: persisted.discardedReason, authorAccountId: 'composer-account', accountActor: null,
                  };
                }) });
            }
            if (path.startsWith(`${pending}/`) && init?.method === 'DELETE') {
                deliveryStatus = null;
                return Response.json({ success: true });
            }
            return metadata.handle(input, init);
        }),
    });
    const session = createSessionFixture({ id: 'carrier-s1', serverId: account.serverId });
    if (!session.metadata) throw new Error('Expected canonical Session fixture metadata');
    getStorage().getState().applySessions([{ ...session, metadata: { ...session.metadata, ...buildVoiceTranscriptHistorySessionMetadata() } }]);
}

function pendingRows() { return getStorage().getState().sessionPending['carrier-s1']?.messages ?? []; }

function hasTextTurn(adapter: VoiceAdapterController): adapter is VoiceAdapterController & Required<Pick<VoiceAdapterController, 'sendTextTurn'>> {
    return typeof adapter.sendTextTurn === 'function';
}

describe('Voice composer through Sync HTTP custody', () => {
    beforeEach(async () => {
        await restorePendingHttpAccount();
        if (!account) throw new Error('Actual composer Account fixture is unavailable');
        const settingsScope = getStorage().getState().settingsScope;
        if (!settingsScope || settingsScope.accountId !== 'composer-account') throw new Error('Restored composer settings Account is unavailable');
        await sync.refreshAccountSettingsFromServer(1, settingsScope);
        composerAssembly = (await createBuiltinVoiceAdapterAssembly());
        registerVoiceAdapters(composerAssembly.adapters);
        const adapter = getVoiceAdapterRegistry().get('happier.voice.elevenlabs/realtime-elevenlabs');
        if (!adapter || !account) throw new Error('Actual composer provider fixture is unavailable');
        // Admission and opaque binding ownership are produced by the public
        // adapter/host, not by a test-only dispatch or registry replacement.
        await adapter.start({ sessionId: 'carrier-s1',
            requestedTargetSessionAddress: { serverId: account.serverId, sessionId: 'carrier-s1' },
            initialContext: '', textOnly: true });
        expect(adapter.getSnapshot()).toMatchObject({ status: 'connected' });
    });
    afterEach(async () => {
        await composerAssembly?.dispose();
        composerAssembly = null;
        registerVoiceAdapters(initialRegisteredAdapters);
        if (account && enqueued) await removePendingOutboxMessage('carrier-s1', enqueued.localId,
            { serverId: account.serverId, accountId: 'composer-account' });
        await account?.dispose();
        account = null;
        getStorage().setState(initialStorageState, true);
    });

    it('VI-LIFE starts another call and sends a new message while exact blocked and uncertain inputs stay held', async () => {
        const adapter = getVoiceAdapterRegistry().get('happier.voice.elevenlabs/realtime-elevenlabs');
        if (!adapter || !account) throw new Error('Actual Voice fixture unavailable');
        providerSendFailure = new Error('network response unavailable');
        expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'held input', localId: 'held-uncertain',
            getAdapter: getVoiceAdapterRegistry().get })).toMatchObject({ ok: true, disposition: 'ambiguous' });
        if (!enqueued || !deliveryStatus) throw new Error('Real enqueue/block producer did not retain custody');
        retainedInputs.push({ post: enqueued, deliveryStatus });
        retainedInputs.push({ post: { ...enqueued, localId: 'held-blocked' },
            deliveryStatus: { status: 'blocked', reason: 'provider_unavailable_before_acceptance' } });
        deliveryStatus = null;
        await sync.fetchPendingMessages('carrier-s1');
        const before = pendingRows().map(row => ({ localId: row.localId, reason: row.pendingDeliveryBlockedReason }));
        expect(before).toEqual([
            { localId: 'held-uncertain', reason: 'delivery_outcome_uncertain' },
            { localId: 'held-blocked', reason: 'provider_unavailable_before_acceptance' },
        ]);
        providerSendFailure = null;
        await adapter.stop({ sessionId: 'carrier-s1' });
        await adapter.start({ sessionId: 'carrier-s1', requestedTargetSessionAddress: { serverId: account.serverId, sessionId: 'carrier-s1' },
            initialContext: '', textOnly: true });
        expect(adapter.getSnapshot().status).toBe('connected');
        expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'new input', localId: 'fresh-after-held',
            getAdapter: getVoiceAdapterRegistry().get })).toEqual({ ok: true, localId: 'fresh-after-held', disposition: 'settled' });
        expect(providerMessages).toEqual(['held input', 'new input']);
        expect(pendingRows().map(row => ({ localId: row.localId, reason: row.pendingDeliveryBlockedReason }))).toEqual(before);
        expect(httpEvents.filter(event => event.startsWith('settle:'))).toEqual(['settle:fresh-after-held']);
    });

    it.each(['healthy', 'explicit-reconnect', 'reconfigure'] as const)(
        'keeps the exact row in external handoff until provider acceptance and removes it only after settlement (%s)', async transition => {
        if (!account) throw new Error('Expected restored Account');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const previous = apiSocket.getAccountEncryptionObservationBinding(account.credentials);
        expect(previous?.isCurrent()).toBe(true);
        await previous!.read();
        const beforeTransition = currentnessHttpStatuses.length;
        if (transition === 'explicit-reconnect') {
            apiSocket.disconnect();
            expect(previous!.isCurrent()).toBe(false);
            expect(apiSocket.getAccountEncryptionObservationBinding(account.credentials)).toBeNull();
            apiSocket.connect();
        } else if (transition === 'reconfigure') {
            apiSocket.initialize({ endpoint: account.home.serverUrl, serverId: account.serverId,
                generation: getActiveServerSnapshot().generation, token: account.credentials.token, credentials: account.credentials,
                request: createServerFetchAtEndpoint({ endpointUrl: account.home.serverUrl,
                    serverId: account.serverId, credentials: account.credentials }), isCurrent: () => true }, null);
        }
        await vi.waitFor(() => expect(apiSocket.getAccountEncryptionObservationBinding(account!.credentials)?.isCurrent()).toBe(true));
        if (transition !== 'healthy') expect(previous!.isCurrent()).toBe(false);
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'voice-http-1',
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId: 'voice-http-1', disposition: 'settled' });
        expect(providerMessages).toEqual(['hello']);
        expect(httpEvents).toEqual(['enqueue:voice-http-1', 'provider:hello', 'settle:voice-http-1']);
        expect(pendingRows()).toEqual([]);
        expect(currentnessHttpStatuses.slice(beforeTransition)).toEqual(transition === 'healthy' ? [] : [200]);
        expect(enqueued).toMatchObject({ localId: 'voice-http-1', deliveryMode: 'external_handoff', requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' }, meta: {
                happierProvenanceV1: { v: 1, kind: 'voice' },
                happierInputRequestV1: { v: 1, producer: 'voiceInput', caller: { kind: 'host' }, permission: {} },
                happier: {
                kind: 'conversation_turn.v1', payload: { v: 1 },
                conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' },
            } } } } });
    });

    it('continues the accepted provider dispatch while joining exact-row HTTP settlement before returning its durable result', async () => {
        const adapter = getVoiceAdapterRegistry().get('happier.voice.elevenlabs/realtime-elevenlabs');
        if (!adapter || !hasTextTurn(adapter)) throw new Error('Actual text-turn adapter is unavailable');
        // Observation only: the original controller/SDK dispatch runs unchanged.
        const dispatch = vi.spyOn(adapter, 'sendTextTurn');
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const handling = new Promise<void>((resolve) => { entered = resolve; });
        handledResponse = async () => {
            entered();
            await gate;
            deliveryStatus = null;
            return Response.json({ success: true });
        };
        const submission = sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'awaited-acceptance',
            getAdapter: getVoiceAdapterRegistry().get });
        try {
            await handling;
            expect(providerMessages).toEqual(['hello']);
            expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'awaited-acceptance', pendingDeliveryStatus: 'external_handoff' })]);
            // VOICE-LATENCY-1114: handled bookkeeping must not hold an
            // already accepted reply. Durable submission still joins it below.
            await vi.waitFor(() => expect(dispatch.mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]));
            release();
            expect(await submission).toEqual({ ok: true, localId: 'awaited-acceptance', disposition: 'settled' });
            expect(dispatch.mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]);
            expect(httpEvents).toEqual(['enqueue:awaited-acceptance', 'provider:hello', 'settle:awaited-acceptance']);
            expect(pendingRows()).toEqual([]);
        } finally {
            release();
            await submission;
            dispatch.mockRestore();
        }
    });

    it('blocks a typed before-effect rejection when the public provider lifecycle changes carrier during enqueue HTTP', async () => {
        changeControlBeforeEnqueueAck = true;
        expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'carrier-changed',
            getAdapter: getVoiceAdapterRegistry().get })).toEqual({ ok: false, reason: 'terminal_rejected', localId: 'carrier-changed',
                errorCode: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT', message: 'voice_transcript_carrier_changed' });
        expect(providerMessages).toEqual([]);
        expect(deliveryStatus).toEqual({ status: 'blocked', reason: 'provider_rejected_before_acceptance' });
        expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'carrier-changed', pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance' })]);
    });

    it('keeps the real typed before-effect failure visible when its HTTP block write fails', async () => {
        changeControlBeforeEnqueueAck = true;
        rejectBlock = true;
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'carrier-changed-block-failed',
            getAdapter: getVoiceAdapterRegistry().get });
        expect(result).toMatchObject({ ok: false, reason: 'terminal_rejected', localId: 'carrier-changed-block-failed',
            message: expect.stringContaining('voice_transcript_carrier_changed') });
        expect(result).toMatchObject({ message: expect.stringContaining('Failed to block pending delivery') });
        expect(providerMessages).toEqual([]);
        expect(deliveryStatus).toEqual({ status: 'external_handoff' });
    });

    it('keeps the accepted row settled when the provider stops while handled bookkeeping is pending', async () => {
        const adapter = getVoiceAdapterRegistry().get('happier.voice.elevenlabs/realtime-elevenlabs');
        if (!adapter || !hasTextTurn(adapter)) throw new Error('Actual accepted lifecycle owner is unavailable');
        const dispatch = vi.spyOn(adapter, 'sendTextTurn');
        let entered!: () => void;
        let release!: () => void;
        const handling = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        handledResponse = async () => {
            entered();
            await gate;
            deliveryStatus = null;
            return Response.json({ success: true });
        };
        const submission = sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'accepted-carrier-change',
            getAdapter: getVoiceAdapterRegistry().get });
        let stopping: Promise<void> | null = null;
        try {
            await handling;
            await vi.waitFor(() => expect(dispatch.mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]));
            // A genuine user Stop is independent of the delayed server response.
            // Release the ACK without waiting for the client lifecycle to drain.
            stopping = adapter.stop({ sessionId: 'carrier-s1' });
            release();
            expect(await submission).toEqual({ ok: true, disposition: 'settled', localId: 'accepted-carrier-change' });
            expect(providerMessages).toEqual(['hello']);
            expect(httpEvents).toEqual(['enqueue:accepted-carrier-change', 'provider:hello', 'settle:accepted-carrier-change']);
            expect(deliveryStatus).toBeNull();
            expect(pendingRows()).toEqual([]);
        } finally { release(); await submission; await stopping; dispatch.mockRestore(); }
    });

    it('does not mistake an external-handoff snapshot before the enqueue acknowledgement for provider acceptance', async () => {
        refreshBeforeEnqueueAck = true;
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'snapshot-before-ack',
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId: 'snapshot-before-ack', disposition: 'settled' });
        expect(httpEvents.slice(0, 3)).toEqual(['enqueue:snapshot-before-ack', 'snapshot-applied:snapshot-before-ack', 'ack:snapshot-before-ack']);
        expect(providerMessages).toEqual(['hello']);
        expect(pendingRows()).toEqual([]);
    });

    it('preserves an opaque pending identity through the HTTP route and provider dispatch', async () => {
        const localId = ' opaque-local-id ';
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId,
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId, disposition: 'settled' });
        expect(enqueued?.localId).toBe(localId);
        expect(httpEvents).toEqual([`enqueue:${localId}`, 'provider:hello', `settle:${localId}`]);
        expect(providerMessages).toEqual(['hello']);
        expect(pendingRows()).toEqual([]);
    });

    it('redacts a native provider failure while retaining ambiguous custody without repeating dispatch', async () => {
        providerSendFailure = new Error('send_failed at /Users/private/transcript');
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'provider-failed',
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId: 'provider-failed', disposition: 'ambiguous', message: 'voice_service_unavailable' });
        expect(providerMessages).toEqual(['hello']);
        expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'provider-failed', pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'delivery_outcome_uncertain' })]);
    });

    it('keeps provider acceptance distinct from an HTTP settlement failure without blocking or redispatching', async () => {
        handledResponse = async () => Response.json({ error: 'settlement_failed' }, { status: 500 });
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'method-unavailable',
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId: 'method-unavailable', disposition: 'accepted_unsettled',
            errorCode: 'voice_pending_settlement_failed', message: 'pending settlement failed: Failed to mark pending delivery handled (500)' });
        expect(providerMessages).toEqual(['hello']);
        expect(httpEvents).toEqual(['enqueue:method-unavailable', 'provider:hello', 'settle:method-unavailable']);
        expect(deliveryStatus).toEqual({ status: 'external_handoff' });
        expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'method-unavailable', pendingDeliveryStatus: 'external_handoff' })]);
    });

    describe.each([
        { producer: 'voice', groupingMode: 'linear' },
        { producer: 'voice', groupingMode: 'turns' },
        { producer: 'ordinary', groupingMode: 'linear' },
        { producer: 'queued', groupingMode: 'linear' },
    ] as const)('Voice input crossover from $producer in the rendered $groupingMode list', ({ producer, groupingMode }) => {
        it.each(['commit-before-echo', 'commit-after-echo', 'reconnect-replay'] as const)(
            'renders only the committed identity before a later final (%s)', async (arrival) => {
                // Load render consumers after the network/Sync singleton boundary above.
                const { buildChatListItemsCached } = await import('@/components/sessions/chatListItems');
                const { buildTranscriptTurnsCached } = await import('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns');
                const { buildTranscriptTurnUnits } = await import('@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits');
                const { projectPendingTranscriptItems } = await import('@/components/sessions/transcript/items/projectPendingTranscriptItems');
                const { buildRealtimeConversationTurnMeta } = await import('@/voice/transcript/voiceConversationTranscript');
                const localId = 'run114-france';
                const text = 'WHAT IS THE CAPITAL OF FRANCE';
                const committed: NormalizedMessage = {
                    id: 'run114-france-committed', localId, role: 'user', isSidechain: false,
                    createdAt: 1794328999618, seq: 1, content: { type: 'text', text },
                    meta: buildRealtimeConversationTurnMeta(),
                };
                const laterFinal: NormalizedMessage = {
                    id: 'later-final', localId: 'later-final-local', role: 'agent', isSidechain: false,
                    createdAt: committed.createdAt + 1_000, seq: 2,
                    content: [{ type: 'text', text: 'Should I allow it? Say “Yes” or “No”.', uuid: 'later-final', parentUUID: null }],
                };
                const store = getStorage();
                let linearCache: Parameters<typeof buildChatListItemsCached>[0]['cache'] = null;
                let turnsCache: Parameters<typeof buildTranscriptTurnsCached>[0]['cache'] = null;
                const rendered = () => {
                    const state = store.getState();
                    const transcript = state.sessionMessages['carrier-s1'];
                    const input = { messageIdsOldestFirst: transcript?.messageIdsOldestFirst ?? [],
                        messagesById: transcript?.messagesById ?? {}, pendingMessages: pendingRows() };
                    if (groupingMode === 'linear') {
                        const result = buildChatListItemsCached({ ...input, cache: linearCache });
                        linearCache = result.cache;
                        return result.items;
                    }
                    turnsCache = buildTranscriptTurnsCached({ ...input, cache: turnsCache,
                        groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools' });
                    return buildTranscriptTurnUnits({ items: projectPendingTranscriptItems({ ...input,
                        items: turnsCache.turns.map(turn => ({ kind: 'turn' as const, id: turn.id, turn })) }),
                        getMessageById: id => input.messagesById[id] ?? null,
                        collapsedPreviewCount: 0, isGroupExpanded: () => false });
                };
                if (arrival === 'commit-before-echo') {
                    store.getState().applyMessages('carrier-s1', [committed, laterFinal]);
                    rendered(); // warm the actual list cache before the local echo arrives
                }
                if (producer === 'voice') {
                    handledResponse = async () => Response.json({ error: 'settlement_failed' }, { status: 500 });
                    expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text, localId,
                        getAdapter: getVoiceAdapterRegistry().get })).toMatchObject({ ok: true, localId, disposition: 'accepted_unsettled' });
                } else {
                    expect(await sync.enqueuePendingMessage('carrier-s1', text, undefined, undefined, {
                        localId, requestedAction: { v: 1, kind: producer === 'ordinary' ? 'send_now' : 'enqueue' },
                    })).toMatchObject({ accepted: true, localId });
                    // Runtime delivery is an HTTP boundary: queued input later enters delivery.
                    deliveryStatus = { status: 'delivering' };
                    await sync.fetchPendingMessages('carrier-s1');
                }
                expect(enqueued).toMatchObject({ localId });
                if (arrival !== 'commit-before-echo') {
                    expect(pendingRows()).toEqual([expect.objectContaining({ localId,
                        pendingDeliveryStatus: producer === 'voice' ? 'external_handoff' : 'server_delivering' })]);
                }
                rendered(); // warm Pending, then hydrate a later final before its earlier user input
                if (arrival !== 'commit-before-echo') {
                    store.getState().applyMessages('carrier-s1', [laterFinal]);
                    rendered();
                    store.getState().applyMessages('carrier-s1', [committed]);
                }
                const expectCommittedOnly = () => {
                    const rows = rendered();
                    const transcript = store.getState().sessionMessages['carrier-s1'];
                    const messages = rows.flatMap(row => row.kind === 'message' && transcript?.messagesById[row.messageId]
                        ? [transcript.messagesById[row.messageId]!] : []);
                    expect(rows.flatMap(row => row.kind === 'pending-queue' ? row.pendingMessages : [])
                        .filter(message => message.localId === localId)).toEqual([]);
                    // The reducer owns stable block ids; realID is the committed sync identity.
                    expect(messages.filter(message => message.localId === localId))
                        .toMatchObject([{ kind: 'user-text', realID: committed.id }]);
                    expect(messages.filter(message => message.realID === committed.id || message.realID === laterFinal.id)
                        .map(message => message.realID)).toEqual([committed.id, laterFinal.id]);
                };
                expectCommittedOnly();
                if (arrival === 'reconnect-replay') {
                    const { apiSocket } = await import('@/sync/api/session/apiSocket');
                    apiSocket.disconnect();
                    apiSocket.connect();
                    await sync.fetchPendingMessages('carrier-s1');
                    store.getState().applyMessages('carrier-s1', [laterFinal, committed]);
                    expectCommittedOnly();
                    linearCache = null;
                    turnsCache = null;
                    expectCommittedOnly(); // reopening has no list cache from the previous view
                }
            });
    });

    it('keeps an untyped native method-unavailable failure uncertain rather than inferring definite rejection', async () => {
        providerSendFailure = new Error('RPC method not available');
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'untyped-error',
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId: 'untyped-error', disposition: 'ambiguous', message: 'voice_service_unavailable' });
        await sync.fetchPendingMessages('carrier-s1');
        expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'untyped-error', pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'delivery_outcome_uncertain' })]);
    });

    it('never dispatches an HTTP enqueue rejected before custody', async () => {
        terminalResponse = 'reject';
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'http-rejected',
            getAdapter: getVoiceAdapterRegistry().get });
        expect(result).toMatchObject({ ok: false, reason: 'send_failed', localId: 'http-rejected' });
        expect(providerMessages).toEqual([]);
        expect(pendingRows()).toEqual([]);
    });

    it('retains an unconfirmed row and never dispatches a malformed external-handoff acknowledgement', async () => {
        terminalResponse = 'missing_handoff';
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'handoff-unclaimed',
            getAdapter: getVoiceAdapterRegistry().get });
        expect(result).toEqual({ ok: true, disposition: 'pending', localId: 'handoff-unclaimed', effectAttempted: false,
            failureCause: { phase: 'voice.pending.enqueue', errorClass: 'Error', errorCode: null, httpStatus: null } });
        expect(providerMessages).toEqual([]);
        expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'handoff-unclaimed', sendState: 'unconfirmed' })]);
    });

    it('fails closed when a reused opaque id belongs to a durable ordinary enqueue without external handoff', async () => {
        enqueueNetworkFailure = true;
        expect(await sync.enqueuePendingMessage('carrier-s1', 'ordinary input', undefined, undefined,
            { localId: 'ordinary-before-voice', requestedAction: { v: 1, kind: 'send_now' } }))
            .toMatchObject({ accepted: false, localId: 'ordinary-before-voice' });
        expect(await loadPendingOutboxForSession('carrier-s1', { serverId: account!.serverId, accountId: 'composer-account' }))
            .toEqual([expect.objectContaining({ localId: 'ordinary-before-voice', operation: 'enqueue' })]);
        enqueueNetworkFailure = false;
        expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'new voice input', localId: 'ordinary-before-voice',
            getAdapter: getVoiceAdapterRegistry().get }))
            .toEqual({ ok: false, reason: 'send_failed', localId: 'ordinary-before-voice', message: 'voice_pending_external_handoff_not_claimed' });
        expect(providerMessages).toEqual([]);
        expect(enqueued).toMatchObject({ localId: 'ordinary-before-voice', content: { t: 'plain', v: { content: { text: 'ordinary input' } } } });
        expect(enqueued?.deliveryMode).toBeUndefined();
        await sync.fetchPendingMessages('carrier-s1');
        expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'ordinary-before-voice', pendingDeliveryStatus: 'server_queued' })]);
    });

    it('keeps unconfirmed synthetic composer input pending through the real adapter assembly', async () => {
        terminalResponse = 'missing_handoff';
        const assembly = (await createBuiltinVoiceAdapterAssembly());
        registerVoiceAdapters(assembly.adapters);
        const adapterId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const store = createVoiceSessionBindingStore();
        store.getState().bind({ adapterId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'carrier-s1',
            conversationSessionAddress: { serverId: account!.serverId, sessionId: 'carrier-s1' }, lifetime: 'runtime_attempt',
            transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 123 });
        try {
            const adapter = getVoiceAdapterRegistry().get(adapterId);
            expect(adapter).toBeDefined();
            expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'synthetic-unconfirmed',
                store, getAdapter: getVoiceAdapterRegistry().get,
            })).toEqual({ ok: true, localId: 'synthetic-unconfirmed', disposition: 'pending', effectAttempted: false,
                failureCause: { phase: 'voice.pending.enqueue', errorClass: 'Error', errorCode: null, httpStatus: null } });
            expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'synthetic-unconfirmed', sendState: 'unconfirmed' })]);
            expect(providerMessages).toEqual([]);
        } finally { await assembly.dispose(); registerVoiceAdapters(initialRegisteredAdapters); }
    });

    it('returns typed cancellation without dispatching a native composer row whose durable outbox cancellation wins', async () => {
        cancelAfterEnqueue = true;
        const assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [] }));
        registerVoiceAdapters(assembly.adapters);
        const store = createVoiceSessionBindingStore();
        store.getState().bind({ adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'carrier-s1',
            conversationSessionAddress: { serverId: account!.serverId, sessionId: 'carrier-s1' },
            transcriptMode: 'native_session', targetSessionAddress: null, updatedAt: 123 });
        try {
            expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'native-cancelled',
                store, getAdapter: getVoiceAdapterRegistry().get,
            })).toEqual({ ok: false, localId: 'native-cancelled', reason: 'cancelled' });
            expect(httpEvents).toEqual(['enqueue:native-cancelled']);
            expect(deliveryStatus).toBeNull();
            // A handoff row stays visible until its provider owner retires it;
            // cancellation must never silently resend that same identity.
            expect(pendingRows()).toEqual([expect.objectContaining({ localId: 'native-cancelled', pendingDeliveryStatus: 'external_handoff' })]);
        } finally { await assembly.dispose(); registerVoiceAdapters(initialRegisteredAdapters); }
    });

    it('does not repeat dispatch when durable outbox settlement wins before the enqueue acknowledgement returns', async () => {
        settleAfterEnqueue = true;
        expect(await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello', localId: 'already-settled',
            getAdapter: getVoiceAdapterRegistry().get }))
            .toEqual({ ok: true, disposition: 'settled', localId: 'already-settled' });
        expect(providerMessages).toEqual([]);
        expect(httpEvents).toEqual(['enqueue:already-settled', 'settle:already-settled']);
        expect(deliveryStatus).toBeNull();
    });

    it('sends synthetic composer text through the real provider adapter and controller before exact-row settlement', async () => {
        const adapterId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const adapter = getVoiceAdapterRegistry().get(adapterId);
        if (!adapter || !hasTextTurn(adapter)) throw new Error('Bundled ElevenLabs adapter is unavailable');
        expect(adapter.getSnapshot()).toMatchObject({ status: 'connected' });
        const dispatch = vi.spyOn(adapter, 'sendTextTurn');
        const result = await sendVoiceSessionComposerText({ conversationSessionId: 'carrier-s1', text: 'hello',
            getAdapter: getVoiceAdapterRegistry().get,
        });
        expect(result).toEqual({ ok: true, localId: expect.any(String), disposition: 'settled' });
        if (!('localId' in result)) throw new Error('Accepted composer input must retain its generated identity');
        expect(result.localId.length).toBeGreaterThan(0);
        expect(dispatch.mock.calls).toEqual([[expect.objectContaining({ controlSessionId: 'carrier-s1',
            conversationSessionId: 'carrier-s1', text: 'hello', localId: result.localId,
            deliveryCommand: 'interrupt_and_send', onAccepted: expect.any(Function) })]]);
        dispatch.mockRestore();
        expect(providerMessages).toEqual(['hello']);
        expect(httpEvents).toEqual([`enqueue:${result.localId}`, 'provider:hello', `settle:${result.localId}`]);
        expect(pendingRows()).toEqual([]);
        expect(enqueued).toMatchObject({ content: { t: 'plain', v: { meta: { happier: {
            conversationTurnOriginV1: { source: { pluginId: 'happier.voice.elevenlabs', contributionId: 'realtime-elevenlabs' } },
        } } } } });
    });

    it.each(['accepted', 'accepted-after-reconnect', 'accepted-after-reconfigure', 'unacknowledged', 'aborted-settled', 'aborted-settlement-failed', 'switched-to-direct-session', 'selection-unavailable', 'target-offline'] as const)('routes native composer text through the actual local controller and daemon RPC with %s delivery', async (outcome) => {
        if (!account) throw new Error('Native composer Account is unavailable');
        await getVoiceAdapterRegistry().get('happier.voice.elevenlabs/realtime-elevenlabs')!.stop({ sessionId: 'carrier-s1' });
        const { writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
        const { writeVoiceProviderSettingsConfig, readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
        const { ensureDefaultLocalVoiceQaBinding } = await import('@/voice/qa/ensureDefaultLocalVoiceQaBinding');
        const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
        const { readVoiceSessionOwnerMetadataFromState } = await import('@/voice/shared/readVoiceSessionOwnerMetadata');
        const local = readLocalConversationVoiceSettings(getStorage().getState().settings.voice);
        getStorage().getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ experiments: true, featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
            voice: { ...writeVoiceProviderSettingsConfig(getStorage().getState().settings.voice, 'local_conversation', {
                ...local, conversationMode: 'agent', streaming: { ...local.streaming, enabled: false },
                agent: { ...local.agent, agentSource: 'agent', agentId: 'claude', prewarmOnConnect: false },
            }), providerId: 'local_conversation', welcome: { ...getStorage().getState().settings.voice.welcome, enabled: false } } }, getStorage().getState().settings));
        expect(readLocalConversationVoiceSettings(getStorage().getState().settings.voice).conversationMode).toBe('agent');
        const root = createSessionFixture({ id: `native-target-${outcome}`, serverId: account.serverId, active: true, activeAt: Date.now(),
            metadata: { path: '/voice/native', host: 'tester.local', machineId: 'machine-1',
                ...(outcome === 'selection-unavailable' ? {} : { flavor: 'claude' }),
                agentRuntimeCapabilitiesV1: { localControl: { supported: true } } } });
        const carrier = createSessionFixture({ id: 'carrier-s1', serverId: account.serverId, active: true, activeAt: Date.now(),
            metadata: writeVoiceConversationScopeMetadata({ path: '/voice/native', host: 'tester.local', machineId: 'machine-1', flavor: 'claude',
                permissionMode: local.agent.permissionIntent, connectedServices: { v: 2, bindingsByServiceId: {} },
                ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) }, { kind: 'session_root', sessionRootId: root.id }) });
        getStorage().getState().applySessions([root, carrier]);
        await sync.refreshMachines();
        for (const session of [root, carrier]) {
            const activity = EphemeralUpdateSchema.parse({ type: 'activity', id: session.id, active: true, activeAt: Date.now(), thinking: false });
            for (const boundary of network.socketBoundaries.filter(value => value.serverUrl === account!.home.serverUrl)) boundary.trigger('ephemeral', activity);
        }
        await waitForTestEvent(getStorage().subscribe,
            () => getStorage().getState().sessions[root.id]?.presence, presence => presence === 'online');
        expect(getStorage().getState().sessions[root.id]?.presence).toBe('online');
        let daemonCommittedOuterInput = false;
        let currentnessBeforeReplacement: number | undefined;
        const daemon = await createRetainedVoiceAgentRpcBoundary({ handleOtherRpc: async (method, input) => {
            if (method === RPC_METHODS.SPAWN_HAPPY_SESSION || method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                const request = SessionResumeRequestV1Schema.parse(input);
                expect(request.sessionId).toBe(carrier.id);
                return { type: 'success', sessionId: carrier.id } satisfies import('@happier-dev/protocol/spawnSession').SpawnSessionResult;
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
                const request = ExecutionRunTurnStreamStartV2RequestSchema.parse(input);
                // The real payload owner may prepend admitted target context,
                // but the daemon must receive this exact final user input.
                expect(request.message).toMatch(/(?:^|\nUser said:\n)hello$/);
                expect(request).toMatchObject({ runId: 'local-agent-run', userTranscript: { localId: enqueued?.localId } });
                daemonCommittedOuterInput = request.userTranscript?.mode === 'persist';
                expect(pendingRows()).toEqual([expect.objectContaining({ localId: enqueued?.localId, pendingDeliveryStatus: 'external_handoff' })]);
                providerMessages.push(request.message);
                httpEvents.push('native-provider');
                if (outcome === 'unacknowledged') throw new Error('send_failed');
                return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'native-real-stream' });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
                if (outcome.startsWith('aborted-')) await gate;
                return ExecutionRunTurnStreamReadResponseSchema.parse({
                    streamId: 'native-real-stream', events: [{ t: 'done', assistantText: '', actions: [] }], nextCursor: 1, done: true });
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return ExecutionRunTurnStreamCancelResponseSchema.parse({ ok: true });
            throw new Error(`Unexpected native daemon method: ${method}`);
        } });
        network.setRpcAckResponder(async request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }
            : { ok: true, result: await daemon.dispatch(request.method, request.payload) });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const actionAccount = await captureLazyActionAccountContext(account.serverId);
        try {
            const serverIdentityId = actionAccount.serverIdentityId;
            if (!serverIdentityId) throw new Error('Native composer requires its restored Action Home identity');
            const admittedInvocations = new Map<string, ExternalActionRequesterInvocationBaseV1>();
            actionBoundaries = await Promise.all((['execution.run.start', 'execution.run.ensure'] as const).map(actionId =>
                createExternalActionAccountHttpBoundary({ serverUrl: actionAccount.endpointUrl,
                    serverIdentityId, accountId: actionAccount.accountId, machineId: 'machine-1', actionId, tokenEpoch: 0,
                    execute: async (input, context) => {
                        if (!input || typeof input !== 'object' || Array.isArray(input) || !('sessionId' in input)) {
                            throw new Error('Expected the native Run Action request');
                        }
                        const { sessionId: _sessionId, ...runInput } = input;
                        const request = ExecutionRunEnsureOrStartRequestSchema.parse(actionId === 'execution.run.start'
                            ? { start: runInput } : runInput);
                        const result = ExecutionRunEnsureOrStartResponseSchema.parse(await daemon.dispatch(
                            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, request));
                        if (!result.ok) throw new Error('Native fixture daemon rejected Run admission');
                        const { caller, surface, authority } = context.invocation;
                        const actionInvocation = actionId === 'execution.run.start'
                            ? { caller, surface, authority } : admittedInvocations.get(result.runId);
                        if (actionId === 'execution.run.ensure') {
                            return ExecutionRunEnsureResponseSchema.parse({ ok: true, actionInvocation });
                        }
                        admittedInvocations.set(result.runId, { caller, surface, authority });
                        return { runId: result.runId, callId: 'local-call', sidechainId: 'local-sidechain', actionInvocation };
                    },
                })));
        } finally { actionAccount.dispose(); }
        const binding = await ensureDefaultLocalVoiceQaBinding({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionAddress: { serverId: account.serverId, sessionId: root.id } });
        expect(binding).toMatchObject({ conversationSessionId: carrier.id, transcriptMode: 'native_session' });
        const adapter = getVoiceAdapterRegistry().get('local_conversation');
        if (!adapter || !hasTextTurn(adapter)) throw new Error('Actual native text-turn adapter is unavailable');
        const dispatch = vi.spyOn(adapter, 'sendTextTurn');
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const handling = new Promise<void>((resolve) => { entered = resolve; });
        const acceptsTranscript = outcome.startsWith('accepted') || outcome.startsWith('aborted-');
        if (acceptsTranscript) handledResponse = async () => {
            entered();
            await gate;
            // The server joins by exact content and sidechain, not just localId.
            // A native Voice user row has its own meta/sidechain and conflicts
            // with the original Pending envelope (live-3's HTTP 409).
            if (daemonCommittedOuterInput) return Response.json({ error: 'transcript-conflict' }, { status: 409 });
            if (outcome === 'aborted-settlement-failed') return Response.json({ error: 'internal-server-error' }, { status: 500 });
            deliveryStatus = null;
            return Response.json({ success: true });
        };
        try {
            if (outcome === 'target-offline') {
                await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
                // Unknown Session presence permits admission. Publish the
                // actual daemon's offline transition through its Socket ingress.
                // Current Homes own transition-driven presence; legacy rows
                // without this fact intentionally retain heartbeat grace.
                for (const boundary of actionBoundaries) boundary.machine.presenceProtocolVersion = 1;
                await sync.refreshMachines();
                const offline = EphemeralUpdateSchema.parse({ type: 'machine-activity', id: 'machine-1',
                    active: false, activeAt: Date.now() });
                for (const boundary of network.socketBoundaries.filter(value => value.serverUrl === account!.home.serverUrl)) {
                    boundary.trigger('ephemeral', offline);
                }
                const { resolveMachineForActiveServerFromState } = await import('@/sync/store/domains/machines/resolveMachinesForActiveServerFromState');
                const { resolveMachineReachability } = await import('@/sync/domains/machines/reachability/machineReachability');
                await vi.waitFor(() => {
                    const state = getStorage().getState();
                    const machine = resolveMachineForActiveServerFromState(state, 'machine-1');
                    expect(machine && resolveMachineReachability(state.profileScope, machine)).toBe('unreachable');
                });
                expect(getStorage().getState().sessions[root.id]).toMatchObject({ active: true });
            } else if (outcome === 'selection-unavailable') {
                // This case starts a new turn admission. An already admitted
                // run correctly retains its captured Agent despite edits.
                await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
                expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
                const voice = getStorage().getState().settings.voice;
                const config = readLocalConversationVoiceSettings(voice);
                getStorage().getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
                    voice: writeVoiceProviderSettingsConfig(voice, 'local_conversation', { ...config,
                        agent: { ...config.agent, agentSource: 'session' } }),
                }, getStorage().getState().settings));
                // Home hydration reads the same initially unreadable identity;
                // no earlier readable root projection may be retained here.
                expect(resolveAgentIdFromSessionMetadata(readVoiceSessionOwnerMetadataFromState(getStorage().getState(), {
                    serverId: account.serverId, sessionId: root.id,
                }))).toBeNull();
            } else {
                await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
            }
            if (outcome === 'accepted-after-reconnect' || outcome === 'accepted-after-reconfigure') {
                const { apiSocket } = await import('@/sync/api/session/apiSocket');
                const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
                const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
                const previous = apiSocket.getAccountEncryptionObservationBinding(account.credentials);
                expect(previous?.isCurrent()).toBe(true);
                await previous!.read();
                currentnessBeforeReplacement = currentnessHttpStatuses.length;
                if (outcome === 'accepted-after-reconnect') {
                    apiSocket.disconnect();
                    expect(previous!.isCurrent()).toBe(false);
                    apiSocket.connect();
                } else {
                    apiSocket.initialize({ endpoint: account.home.serverUrl, serverId: account.serverId,
                        generation: getActiveServerSnapshot().generation, token: account.credentials.token, credentials: account.credentials,
                        request: createServerFetchAtEndpoint({ endpointUrl: account.home.serverUrl,
                            serverId: account.serverId, credentials: account.credentials }), isCurrent: () => true }, null);
                }
                await vi.waitFor(() => expect(apiSocket.getAccountEncryptionObservationBinding(account!.credentials)?.isCurrent()).toBe(true));
                expect(previous!.isCurrent()).toBe(false);
                // Reconnect withdraws presence independently of Account mode.
                // Feed the next real activity through the external Socket boundary.
                for (const session of [root, carrier]) {
                    const activity = EphemeralUpdateSchema.parse({ type: 'activity', id: session.id,
                        active: true, activeAt: Date.now(), thinking: false });
                    for (const boundary of network.socketBoundaries.filter(value => value.serverUrl === account!.home.serverUrl)) boundary.trigger('ephemeral', activity);
                }
            }
            if (outcome === 'switched-to-direct-session') {
                // A real preference change does not fabricate a new binding or
                // dispatcher. The persisted native carrier still routes through
                // its registered local controller, now in direct-session mode.
                const voice = getStorage().getState().settings.voice;
                const config = readLocalConversationVoiceSettings(voice);
                getStorage().getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
                    voice: writeVoiceProviderSettingsConfig(voice, 'local_conversation', { ...config,
                        conversationMode: 'direct_session', tts: { ...config.tts, autoSpeakReplies: false } }),
                }, getStorage().getState().settings));
                expect(readLocalConversationVoiceSettings(getStorage().getState().settings.voice).conversationMode).toBe('direct_session');
            }
            const submission = sendVoiceSessionComposerText({ conversationSessionId: carrier.id, text: 'hello',
                ...(!outcome.startsWith('accepted') ? { localId: 'native-real-turn' } : {}),
                sessionMetadata: readVoiceSessionOwnerMetadataFromState(getStorage().getState(), { serverId: account.serverId, sessionId: carrier.id }),
                getAdapter: getVoiceAdapterRegistry().get });
            if (acceptsTranscript) {
                // An early admission failure must settle this test before the
                // transcript acceptance gate rather than waiting indefinitely.
                await Promise.race([handling, submission]);
                expect(providerMessages).toHaveLength(1);
                // VOICE-LATENCY-1114: admission already owns Pending custody.
                // A held handled write must not hold the admitted output reader.
                await vi.waitFor(() => expect(daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ)).toHaveLength(1));
                expect(deliveryStatus).toEqual({ status: 'external_handoff' });
                if (outcome.startsWith('aborted-')) {
                    await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
                    await dispatch.mock.results[0]?.value;
                    expect(dispatch.mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }]);
                    expect(deliveryStatus).toEqual({ status: 'external_handoff' });
                }
                release();
            }
            const result = await submission;
            if (currentnessBeforeReplacement !== undefined) {
                const statuses = currentnessHttpStatuses.slice(currentnessBeforeReplacement);
                expect(statuses.length).toBeGreaterThan(0);
                expect(statuses.every(status => status === 200)).toBe(true);
            }
            const localId = enqueued?.localId;
            expect(localId).toEqual(expect.any(String));
            expect(localId?.length).toBeGreaterThan(0);
            expect(dispatch.mock.calls).toEqual([[{ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: carrier.id,
                text: 'hello', localId, deliveryCommand: 'interrupt_and_send', onAccepted: expect.any(Function) }]]);
            if (outcome === 'switched-to-direct-session') {
                const failure = dispatch.mock.settledResults[0];
                expect(failure?.type).toBe('rejected');
                if (failure?.type !== 'rejected' || !(failure.value instanceof Error)) throw new Error('Actual native direct-session failure was not observable');
                expect(result).toEqual({ ok: true, localId, disposition: 'ambiguous', message: failure.value.message });
            } else if (outcome === 'selection-unavailable' || outcome === 'target-offline') expect(result).toMatchObject({ ok: false, localId,
                reason: 'terminal_rejected', message: outcome === 'selection-unavailable' ? 'voice_agent_selection_unavailable' : expect.any(String) });
            else if (outcome === 'aborted-settlement-failed') expect(result).toMatchObject({ ok: true, localId,
                disposition: 'accepted_unsettled', message: expect.stringContaining('pending settlement failed:') });
            else expect(result).toEqual(outcome === 'unacknowledged'
                ? { ok: true, localId, disposition: 'ambiguous', message: 'send_failed' }
                : { ok: true, localId, disposition: 'settled' });
            expect(httpEvents.filter(event => event.startsWith('settle:'))).toEqual(acceptsTranscript ? [`settle:${localId}`] : []);
            const noDispatch = outcome === 'switched-to-direct-session' || outcome === 'selection-unavailable' || outcome === 'target-offline';
            const blockedReason = outcome === 'selection-unavailable' || outcome === 'target-offline' ? 'provider_unavailable_before_acceptance' : 'delivery_outcome_uncertain';
            expect(providerMessages).toHaveLength(noDispatch ? 0 : 1);
            expect(daemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2)).toHaveLength(noDispatch ? 0 : 1);
            expect(deliveryStatus).toEqual(!acceptsTranscript ? { status: 'blocked', reason: blockedReason }
                : outcome === 'aborted-settlement-failed' ? { status: 'external_handoff' } : null);
            expect(pendingRows()).toEqual(!acceptsTranscript ? [expect.objectContaining({ localId: 'native-real-turn',
                pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: blockedReason })]
                : outcome === 'aborted-settlement-failed' ? [expect.objectContaining({ localId: 'native-real-turn', pendingDeliveryStatus: 'external_handoff' })] : []);
        } finally { release(); dispatch.mockRestore(); await voiceAgentSessions.stop(VOICE_AGENT_GLOBAL_SESSION_ID); }
    });
});
