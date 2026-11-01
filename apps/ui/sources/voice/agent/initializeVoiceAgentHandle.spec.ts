import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentModelConfig } from '@happier-dev/agents';
import { FeaturesResponseSchema, ExecutionRunEnsureOrStartRequestSchema, type ExecutionRunEnsureOrStartRequest, buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunVoiceAgentIntentInputV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionRunnerRuntimeStatusFixture } from '@/dev/testkit/fixtures/sessionRunnerRuntimeFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { SessionExecutionRunGetResult, SessionExecutionRunListResult } from '@/sync/ops/sessionExecutionRuns';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { SessionAppliedModelV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionActiveModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createDeferred } from '@/dev/testkit';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { VOICE_TRANSCRIPT_MEMORY_KEY } from '@/voice/persistence/voiceTranscriptMemory';

// Synthetic daemon ACKs only; the client, Run operations and installable owners stay real.
const start = vi.fn(async (_request: ExecutionRunEnsureOrStartRequest) => ({ ok: true as const, runId: 'voice-agent-1', created: true }));
const rpcTargets: Array<{ sessionId: string; method: string }> = [];
const transcriptMemory = createAccountKvHttpFixture();
let rootRunnerPid = 123;
let stallRootRunnerStatus = false;
let rootRunnerStatusEntered = createDeferred<void>();
function admittedStart() {
    const request = start.mock.calls.at(-1)?.[0];
    if (!request?.start) throw new Error('Expected the real daemon start admission');
    return request.start;
}
function admittedPolicy() {
    return ExecutionRunVoiceAgentIntentInputV1Schema.parse(admittedStart().intentInput).voicePolicy;
}
const sessionExecutionRunList = vi.fn(async (_sessionId: string, _params?: any): Promise<SessionExecutionRunListResult> => ({ runs: [] }));
const sessionExecutionRunGet = vi.fn(async (_sessionId: string, _params?: any): Promise<SessionExecutionRunGetResult> => ({
    ok: false as const,
    error: 'Execution run not found',
    errorCode: 'execution_run_not_found',
}));
const sessionExecutionRunStop = vi.fn(async (_sessionId: string, _params?: any) => ({ ok: true }));
let state: any = {
    settings: {
        voice: {
            providerId: 'local_conversation',
            providers: {
                local_conversation: { schemaVersion: 1, config: {
                    agent: {
                        agentSource: 'session',
                        chatModelSource: 'custom',
                        chatModelId: 'default',
                        commitModelSource: 'chat',
                        commitModelId: 'default',
                        transcript: { persistenceMode: 'ephemeral', epoch: 0 },
                    },
                    networkTimeoutMs: 15_000,
                } },
            },
        },
    },
    sessions: {
        s1: {
            id: 's1',
            active: true,
            presence: 'online',
            modelMode: 'default',
            metadata: {
                flavor: 'claude',
                profileId: 'raw-profile',
            },
        },
    },
    sessionListRowsByServerId: {
        'server-a': {
            s1: {
                id: 's1',
                active: true,
                presence: 'online',
                modelMode: 'default',
                metadata: {
                    flavor: 'codex',
                    profileId: 'cached-profile',
                },
            },
        },
    },
    ordinarySessionListMembershipByServerId: { 'server-a': ['s1'] },
    sessionListIndexByServerId: {
        'server-a': [
            {
                type: 'session',
                sessionId: 's1',
                serverId: 'server-a',
                serverName: 'Server A',
            },
        ],
    },
    concurrentSessionListCacheByServerId: {},
    machines: {},
    machineListByServerId: {},
    sessionMessages: {},
};
let sessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;

// Greeting, cancellation and Provider-choice contracts do not depend on an
// Account Profile. Keep the three Profile-owner contracts' exact fixtures below.
function omitIncidentalProfile() {
    const current = storage.getState();
    const serverId = current.profileScope!.serverId;
    const session = current.sessions.s1;
    const row = current.sessionListRowsByServerId[serverId].s1;
    const metadata = readVoiceSessionOwnerMetadataFromState(current, { serverId, sessionId: 's1' });
    if (!metadata) throw new Error('Target Session metadata missing');
    storage.setState({ sessions: { ...current.sessions,
        s1: createSessionFixture({ ...session, metadataLayoutVersion: 0, ownerMetadataView: undefined,
            metadata: { ...metadata, profileId: undefined } }),
    }, sessionListRowsByServerId: { ...current.sessionListRowsByServerId,
        [serverId]: { ...current.sessionListRowsByServerId[serverId],
            s1: createSessionFixture({ ...row, metadataLayoutVersion: 0, ownerMetadataView: undefined,
                metadata: { ...metadata, profileId: undefined } }),
        },
    } });
    state = storage.getState();
    sessionHttp.replaceSession('s1');
}

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, envelope) => {
        if (event !== 'rpc-call') throw new Error(`Unexpected Socket ACK: ${event}`);
        const request = envelope as { method: string; params: unknown };
        const separator = request.method.indexOf(':');
        const sessionId = request.method.slice(0, separator);
        const method = request.method.slice(separator + 1);
        rpcTargets.push({ sessionId, method });
        let result: unknown;
        if (method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET) {
            rootRunnerStatusEntered.resolve();
            if (stallRootRunnerStatus) return await new Promise(() => {});
            const params = request.params as { sessionId: string };
            result = createSessionRunnerRuntimeStatusFixture({ sessionId: params.sessionId, machineId: sessionId, pid: rootRunnerPid, wrapperPid: 122 });
        } else if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) result = await sessionExecutionRunList(sessionId, request.params);
        else if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) result = await sessionExecutionRunGet(sessionId, request.params);
        else if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) result = await sessionExecutionRunStop(sessionId, request.params);
        else if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1) {
            result = await start(ExecutionRunEnsureOrStartRequestSchema.parse(request.params));
        } else throw new Error(`Unexpected daemon method: ${method}`);
        return { ok: true, result };
    });
});
await loadSyncSingletonForTests();
const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
const { buildAgentUniverseBackendTargetKey } = await import('@/agents/catalog/agentUniverse');


describe('initializeVoiceAgentHandle', () => {
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let unsubscribeStorage: (() => void) | undefined;
    beforeAll(loadSyncSingletonForTests, 60_000);
    afterEach(async () => {
        unsubscribeStorage?.();
        await connection?.dispose();
        vi.restoreAllMocks();
    });
    beforeEach(async () => {
        transcriptMemory.reset();
        const previousServerId = state.profileScope?.serverId ?? 'server-a';
        sessionHttp = createSessionMetadataHttpBoundary(() => Object.fromEntries(
            Object.entries(storage.getState().sessions).map(([id, session]) => [id, createSessionFixture({ ...session, id,
                metadata: readVoiceSessionOwnerMetadataFromState(storage.getState(), id) ?? null,
            })]),
        ));
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://voice-initialize.example.test',
            credentialScope: 'restored-home',
            // Session HTTP is a genuine boundary. Retained-run adoption writes
            // its pointer through the real metadata tuple owner, not a stub.
            request: createSessionReadBatchFetchBoundary(async (url, init) => {
                const memoryResponse = await transcriptMemory.handleFetch(url, init);
                if (memoryResponse) return memoryResponse;
                const path = new URL(String(url)).pathname;
                const respond = (body: unknown) => Response.json(body);
                if (path === '/health') return respond({ status: 'ok' });
                if (path === '/v2/cursor') return respond({ cursor: 0, changesFloor: 0 });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return respond(FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }));
                if (path === '/v1/account/encryption') return respond({ mode: 'plain', updatedAt: 0 });
                if (path === '/v2/account/settings') return respond({ content: { t: 'plain', v: state.settings }, version: 1 });
                if (path === '/v1/machines') return respond([createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' })]);
                if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === 'machine-1' ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
                if (path === '/v1/machines/machine-1') return respond({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) });
                if (path.endsWith('/messages')) return respond({ messages: [], hasMore: false });
                if (path === '/v1/account/encryption/currentness') return respond(createPlainAccountEncryptionCurrentnessFixture());
                const sessionResponse = sessionHttp.handle(url, init);
                if (sessionResponse) return sessionResponse;
                return new Response('{}', { status: 404 });
            }),
        });
        const { home } = connection;
        const normalizeSessions = (sessions: Record<string, Parameters<typeof createSessionFixture>[0]>) =>
            Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id,
                createSessionFixture({ ...session, id, serverId: home.id }),
            ]));
        storage.setState({
            ...state,
            settings: settingsParse({ experiments: true,
                featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true }, ...state.settings }),
            profileScope: { serverId: home.id, accountId: 'account-a' },
            sessions: normalizeSessions(state.sessions),
            sessionListRowsByServerId: { [home.id]: normalizeSessions(state.sessionListRowsByServerId[previousServerId]) },
            ordinarySessionListMembershipByServerId: { [home.id]: ['s1'] },
            sessionListIndexByServerId: { [home.id]: [{ type: 'session', sessionId: 's1', serverId: home.id, serverName: 'Voice' }] },
        });
        state = storage.getState();
        state.sessions.s1.active = true;
        state.sessions.s1.presence = 'online';
        state.sessions.s1.encryptionMode = 'plain';
        start.mockClear();
        rootRunnerPid = 123;
        stallRootRunnerStatus = false;
        rootRunnerStatusEntered = createDeferred<void>();
        rpcTargets.length = 0;
        sessionExecutionRunList.mockClear();
        sessionExecutionRunGet.mockClear();
        sessionExecutionRunStop.mockClear();
        state.sessions.s1.metadataLayoutVersion = 0;
        delete state.sessions.s1.ownerMetadataView;
        state.sessions.s1.metadata = {
            flavor: 'claude',
            profileId: 'raw-profile',
            agentRuntimeCapabilitiesV1: {
                localControl: { supported: true },
            },
        };
        state.sessionListRowsByServerId[home.id].s1.metadataLayoutVersion = 0;
        state.sessionListRowsByServerId[home.id].s1.active = true;
        state.sessionListRowsByServerId[home.id].s1.presence = 'online';
        delete state.sessionListRowsByServerId[home.id].s1.ownerMetadataView;
        state.sessionListRowsByServerId[home.id].s1.metadata = {
            flavor: 'codex',
            profileId: 'cached-profile',
            agentRuntimeCapabilitiesV1: {
                localControl: { supported: true },
            },
        };
        // Account restoration can have started discovery before fixture data
        // was published. Refresh through the real feature HTTP reader.
        const { flushActivityUpdates } = await import('@/sync/engine/socket/socket');
        unsubscribeStorage = storage.subscribe(current => {
            const session = current.sessions.s1;
            const row = current.sessionListRowsByServerId[home.id]?.s1;
            if (session?.active !== true || (session.presence === 'online' && row?.presence === 'online')) return;
            const activeAt = Math.max(Date.now(), (session.activeAt ?? 0) + 1, (row?.activeAt ?? 0) + 1);
            flushActivityUpdates({ updates: new Map([['s1', { type: 'activity', id: 's1', active: true, activeAt, thinking: false }]]),
                applySessions: current.applySessions, sourceServerId: home.id });
        });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ serverId: home.id, force: true });
    });

    it('takes the transcript epoch from Account memory when starting a different carrier', async () => {
        omitIncidentalProfile();
        await transcriptMemory.handleFetch('https://voice-initialize.example.test/v1/kv', { method: 'POST',
            body: JSON.stringify({ mutations: [{ key: VOICE_TRANSCRIPT_MEMORY_KEY, version: -1,
                value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, epoch: 7, futureField: true } }),
            }] }),
        });
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        await initializeVoiceAgentHandle({ sessionId: 's1', getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
            setDeferredTargetSessionContext: () => {} });
        expect(admittedStart().transcript)
            .toEqual({ persistenceMode: 'persistent', epoch: 7 });
    });

    it('prefers visible lookup session metadata when deriving daemon startup models and profile data', async () => {
        expect(readLocalConversationSettingsFromAccountSettings(storage.getState().settings).agent.transcript.persistenceMode).toBe('ephemeral');
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');

        const handle = await initializeVoiceAgentHandle({
            sessionId: 's1',
            getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
            setDeferredTargetSessionContext: vi.fn(),
        });

        expect(handle.backend).toBe('daemon');
        expect(handle.rpcSessionId).toBe('s1');
        expect(handle.agentBackendId).toBe('codex');
        expect(buildBackendTargetKeyV2(admittedStart().backendTarget)).toBe(buildAgentUniverseBackendTargetKey('codex'));
        expect(admittedStart()).toMatchObject({
                launchProfileId: 'cached-profile',
                modelSelection: null,
                commitModelId: getAgentModelConfig('codex')?.defaultMode,
                transcript: { persistenceMode: 'persistent', epoch: 0 },
                retentionPolicy: 'resumable',
            });
        expect(admittedStart().chatModelId).toBeUndefined();
    });

    it.each(['current', 'missing', 'stale', 'cancelled', 'team', 'team_stale'])('starts on a hidden carrier with the bound root Agent, model and Launch Profile only when applied model is known (%s)', async applied => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        const carrierId = 'hidden-selection-carrier';
        const current = storage.getState();
        const previousSettings = current.settings;
        const previousRoot = current.sessions.s1;
        if (!previousRoot.metadata) throw new Error('The coding root requires owner metadata');
        const localSettings = readLocalConversationSettingsFromAccountSettings(previousSettings);
        if (applied === 'stale' || applied === 'team_stale') rootRunnerPid = 124;
        const targetAddress = { serverId: connection.home.id, sessionId: 's1' };
        const rootMetadata = { ...previousRoot.metadata, flavor: 'claude', profileId: 'root-launch-profile',
            modelOverrideV1: { v: 1 as const, modelId: 'pending-unapplied-model', updatedAt: 20 },
            machineId: 'machine-1',
            connectedServices: {
                v: 2 as const,
                bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': {
                        source: 'connected' as const,
                        selection: 'profile' as const,
                        profileId: 'root-claude-profile',
                    },
                },
            },
            sessionModelsV1: { v: 1 as const, agentId: 'claude', updatedAt: 30, currentModelId: 'claude-haiku-4-5',
                availableModels: [{ id: 'claude-haiku-4-5', name: 'Haiku' }],
                ...(applied !== 'missing' ? { activeSelectionV1: SessionActiveModelSelectionSchema.parse({
                    v: applied.startsWith('team') ? 2 : 1, source: 'runtime_apply',
                    selection: { agentTargetKey: buildAgentUniverseBackendTargetKey('claude'), providerConnectionId: null, modelId: 'claude-haiku-4-5' },
                    runner: { pid: 123, processStartTimeMs: 1000 },
                    ...(applied.startsWith('team') ? { teamCredentialModel: {
                        kind: 'team_credential_provider_model', resourceId: 'team-resource', teamId: 'team-1',
                        expectedResourceRevision: 0, deliveryMode: 'brokered',
                        agentTargetKey: buildAgentUniverseBackendTargetKey('claude'), modelId: 'claude-haiku-4-5',
                    } } : {}),
                }) } : {}),
            },
            sessionAppliedModelV1: SessionAppliedModelV1Schema.parse({ v: 1, provider: 'claude', modelId: 'last-accepted-model', updatedAt: 10,
                selection: { agentTargetKey: buildAgentUniverseBackendTargetKey('claude'),
                    providerConnectionId: null, modelId: 'last-accepted-model' } }) };
        storage.setState({ sessions: { ...current.sessions,
            s1: createSessionFixture({ ...previousRoot, metadataLayoutVersion: 1,
                metadata: { path: previousRoot.metadata.path, host: previousRoot.metadata.host,
                    summary: { text: 'Coding root', updatedAt: 1 } }, ownerMetadataView: rootMetadata }),
            [carrierId]: createSessionFixture({ id: carrierId, serverId: connection.home.id, active: true,
                presence: 'online', encryptionMode: 'plain', metadata: { ...rootMetadata,
                    flavor: 'unknown-agent', profileId: 'carrier-is-not-a-profile', modelOverrideV1: undefined, machineId: undefined } }),
        }, machines: { ...current.machines, 'machine-1': createMachineFixture({ id: 'machine-1', storageMode: 'plain', activeAt: Date.now() }) },
        settings: { ...previousSettings, voice: voiceSettingsParse({ ...previousSettings.voice,
            providers: { ...previousSettings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...localSettings, agent: {
                    ...localSettings.agent,
                    agentSource: 'session', chatModelSource: 'session', commitModelSource: 'session',
                },
            } } },
        }) } });
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: carrierId,
            conversationSessionAddress: { serverId: connection.home.id, sessionId: carrierId },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic', targetSessionAddress: targetAddress, updatedAt: 1 });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            const lifetime = new AbortController();
            stallRootRunnerStatus = applied === 'cancelled';
            const initializing = initializeVoiceAgentHandle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                signal: lifetime.signal,
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn() });
            if (applied === 'cancelled') {
                let outcome = 'pending';
                const settled = initializing.then(() => { outcome = 'resolved'; }, () => { outcome = 'cancelled'; });
                await rootRunnerStatusEntered.promise;
                expect(rpcTargets.some(request => request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET)).toBe(true);
                lifetime.abort();
                await settled;
                expect(outcome).toBe('cancelled');
                expect(start).not.toHaveBeenCalled();
                return;
            }
            if (applied !== 'current') {
                await expect(initializing).rejects.toMatchObject({ code: applied === 'team'
                    ? 'VOICE_AGENT_TEAM_MODEL_UNSUPPORTED' : 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
                expect(start).not.toHaveBeenCalled();
                return;
            }
            const handle = await initializing;
            expect(handle.rpcSessionId).toBe(carrierId);
            expect(handle.agentBackendId).toBe('claude');
            expect(admittedStart()).toMatchObject({ launchProfileId: 'root-launch-profile',
                modelSelection: { agentTargetKey: buildAgentUniverseBackendTargetKey('claude'),
                    providerConnectionId: null, modelId: 'claude-haiku-4-5' },
                connectedServices: {
                    v: 2,
                    bindingsByServiceId: {
                        'happier.agent.claude/claude-subscription': {
                            source: 'connected', selection: 'profile', profileId: 'root-claude-profile',
                        },
                    },
                } });
            expect(ExecutionRunVoiceAgentIntentInputV1Schema.parse(admittedStart().intentInput).commitModelSelection)
                .toMatchObject({ modelId: 'claude-haiku-4-5' });
        } finally {
            stallRootRunnerStatus = false;
            voiceSessionBindingStore.getState().unbind(carrierId);
            const sessions: typeof current.sessions = { ...storage.getState().sessions, s1: previousRoot };
            delete sessions[carrierId];
            storage.setState({ sessions, settings: previousSettings });
            state = storage.getState();
        }
    });

    it.each(['connected', 'native', 'ordinary', 'other_agent'] as const)(
        'R41 preserves the fixed Agent carrier credential choice only for its exact Voice target (%s)', async scenario => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        const carrierId = 'fixed-credential-carrier';
        const current = storage.getState();
        const previousSettings = current.settings;
        const local = readLocalConversationSettingsFromAccountSettings(previousSettings);
        const connectedServices: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: scenario === 'native' ? {} : {
            'happier.agent.claude/claude-subscription': {
                source: 'connected' as const, selection: 'profile' as const, profileId: 'carrier-account',
            },
        } };
        storage.setState({ sessions: { ...current.sessions,
            [carrierId]: createSessionFixture({ id: carrierId, serverId: connection.home.id, active: true,
                presence: 'online', encryptionMode: 'plain', metadata: {
                    path: '/voice', host: 'voice.test', flavor: scenario === 'other_agent' ? 'codex' : 'claude',
                    connectedServices,
                    ...(scenario === 'ordinary' ? {} : buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true })),
                } }),
        }, settings: { ...previousSettings, voice: voiceSettingsParse({ ...previousSettings.voice,
            providers: { ...previousSettings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...local, agent: { ...local.agent, agentSource: 'agent', agentId: 'claude',
                    chatModelSource: 'custom', chatModelId: 'claude-haiku-4-5' },
            } } },
        }) } });
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: carrierId,
            conversationSessionAddress: { serverId: connection.home.id, sessionId: carrierId },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' }, updatedAt: 1 });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            const handle = await initializeVoiceAgentHandle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn() });
            expect(handle.rpcSessionId).toBe(carrierId);
            if (scenario === 'connected' || scenario === 'native') {
                expect(admittedStart().connectedServices).toEqual(connectedServices);
            } else {
                expect(admittedStart().connectedServices).toBeUndefined();
            }
        } finally {
            voiceSessionBindingStore.getState().unbind(carrierId);
            const sessions = { ...storage.getState().sessions };
            delete sessions[carrierId];
            const rows = { ...storage.getState().sessionListRowsByServerId[connection.home.id] };
            delete rows[carrierId];
            storage.setState({ sessions, settings: previousSettings,
                sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId, [connection.home.id]: rows } });
            state = storage.getState();
        }
    });

    it('admits the exact Session default greeting into the run policy before the daemon starts', async () => {
        omitIncidentalProfile();
        const previousSettings = state.settings;
        state.settings = {
            ...previousSettings,
            voice: { ...previousSettings.voice, assistantLanguage: 'en',
                welcome: { enabled: true, mode: 'immediate', templateId: null } },
        };
        storage.setState({ settings: state.settings });
        const { readSessionDisplayTitle } = await import('@/utils/sessions/sessionDisplayTitle');
        const targetName = readSessionDisplayTitle({ serverId: connection.home.id, sessionId: 's1' });
        expect(targetName).toBeTruthy();
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            const handle = await initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn(),
            });
            expect(handle.voicePolicy?.welcome?.text).toContain(targetName);
            expect(admittedPolicy()?.welcome?.text).toContain(targetName);
        } finally {
            storage.setState({ settings: previousSettings });
            state = storage.getState();
        }
    });

    it('retires a started run when its admitted target binding changes during the daemon await', async () => {
        omitIncidentalProfile();
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: 's1',
            conversationSessionId: 's1', conversationSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' }, updatedAt: 1 });
        const stop = vi.fn(async (_request: unknown) => ({ ok: true }));
        sessionExecutionRunStop.mockImplementationOnce(async (_sessionId, request) => stop(request));
        start.mockImplementationOnce(async () => {
            voiceSessionBindingStore.getState().unbind('s1');
            return { ok: true as const, runId: 'voice-agent-1', created: true };
        });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            await expect(initializeVoiceAgentHandle({ sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn() })).rejects.toThrow('voice_agent_binding_changed');
            expect(stop).toHaveBeenCalledWith({ runId: 'voice-agent-1' });
        } finally {
            voiceSessionBindingStore.getState().unbind('s1');
            start.mockReset().mockResolvedValue({ ok: true, runId: 'voice-agent-1', created: true });
        }
    });

    it('cancels the retired initializer cleanup wait when its caller leaves', async () => {
        omitIncidentalProfile();
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: 's1',
            conversationSessionId: 's1', conversationSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionAddress: { serverId: connection.home.id, sessionId: 's1' }, updatedAt: 1 });
        let entered!: () => void;
        const entering = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        const acknowledgement = new Promise<void>(resolve => { release = resolve; });
        sessionExecutionRunStop.mockImplementationOnce(async () => { entered(); await acknowledgement; return { ok: true }; });
        start.mockImplementationOnce(async () => {
            voiceSessionBindingStore.getState().unbind('s1');
            return { ok: true as const, runId: 'voice-agent-1', created: true };
        });
        const caller = new AbortController();
        let settled = false;
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const initializing = initializeVoiceAgentHandle({ sessionId: 's1', signal: caller.signal,
            getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
            setDeferredTargetSessionContext: vi.fn() }).catch(error => error).finally(() => { settled = true; });
        try {
            await entering;
            caller.abort();
            expect(await initializing).toMatchObject({ message: 'voice_agent_binding_changed' });
            expect(settled).toBe(true);
        } finally {
            release();
            await initializing;
            voiceSessionBindingStore.getState().unbind('s1');
        }
    });

    it('reconnects with retained greeting bytes without re-reading an unavailable current selection', async () => {
        omitIncidentalProfile();
        const previousSettings = state.settings;
        storage.setState({ settings: { ...previousSettings,
            voice: { ...previousSettings.voice, assistantLanguage: 'en',
                welcome: { enabled: true, mode: 'immediate', templateId: 'deleted-after-admission' } },
        } });
        const voicePolicy = { assistantLanguage: 'fr', welcome: { enabled: true, mode: 'on_first_turn', text: '  Retained.\n ' } };
        const retainedAdmission = ExecutionRunPublicStateSchema.safeParse({ runId: 'voice-agent-1', callId: 'call', sidechainId: 'sidechain',
            intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read-only',
            retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
            voicePolicy });
        expect(retainedAdmission.success).toBe(true);
        if (!retainedAdmission.success) throw retainedAdmission.error;
        const run = retainedAdmission.data;
        sessionExecutionRunList.mockResolvedValueOnce({ runs: [run] });
        sessionExecutionRunGet.mockResolvedValueOnce({ run }).mockResolvedValueOnce({ run });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            const handle = await initializeVoiceAgentHandle({ sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn() });
            expect(handle.voicePolicy).toEqual(voicePolicy);
            expect(admittedPolicy()).toEqual(voicePolicy);
        } finally {
            sessionExecutionRunList.mockReset().mockResolvedValue({ runs: [] });
            sessionExecutionRunGet.mockReset().mockResolvedValue({ ok: false, error: 'Execution run not found', errorCode: 'execution_run_not_found' });
            storage.setState({ settings: previousSettings });
            state = storage.getState();
        }
    });

    it.each([false, true])('starts R40 with its configured ACP Session Agent despite a saved Codex tuple (bound=%s)', async bound => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const previousSettings = storage.getState().settings;
        const carrierId = 'r40-global-configured-acp';
        const local = readLocalConversationSettingsFromAccountSettings(previousSettings);
        storage.setState({ sessions: { ...storage.getState().sessions,
            [carrierId]: createSessionFixture({ id: carrierId, serverId: connection.home.id, active: true,
                presence: 'online', encryptionMode: 'plain', metadataLayoutVersion: 1,
                metadata: { path: '/voice', host: 'voice.test' },
                ownerMetadataView: { path: '/voice', host: 'voice.test', flavor: 'custom-acp',
                    acpConfiguredBackendV1: { v: 1, backendId: 'qa-c-exact-args', title: 'QA configured ACP', updatedAt: 1 } },
            }),
        }, settings: { ...previousSettings, voice: voiceSettingsParse({ ...previousSettings.voice,
            providers: { ...previousSettings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...local, agent: { ...local.agent, agentSource: 'session', agentId: 'codex',
                    agentTargetKey: 'agent:happier.agent.codex/codex', agentIdentity: null,
                    chatModelSource: 'custom', chatModelId: 'gpt-6-luna' },
            } } },
        }) } });
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: carrierId, conversationSessionAddress: { serverId: connection.home.id, sessionId: carrierId },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionAddress: bound ? { serverId: connection.home.id, sessionId: carrierId } : null, updatedAt: 1 });
        try {
            await expect(initializeVoiceAgentHandle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn() })).resolves.toMatchObject({ rpcSessionId: carrierId });
            expect(admittedStart()).toMatchObject({ backendTarget: { kind: 'backend', backendId: 'qa-c-exact-args',
                configuredBackendId: 'qa-c-exact-args', sourceKind: 'configured' },
                modelSelection: { agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:qa-c-exact-args',
                    providerConnectionId: null, modelId: 'gpt-6-luna' } });
        } finally {
            voiceSessionBindingStore.getState().unbind(carrierId);
            const sessions = { ...storage.getState().sessions };
            delete sessions[carrierId];
            storage.setState({ sessions, settings: previousSettings });
            state = storage.getState();
        }
    });

    it.each([true, false])('keeps hidden history separate from the bound/global persona (bound=%s)', async bound => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        const previousSettings = state.settings;
        const history = 'hidden-welcome-history';
        const targetAddress = { serverId: connection.home.id, sessionId: 's1' };
        storage.setState({ sessions: { ...storage.getState().sessions,
            [history]: { ...state.sessions.s1, id: history, serverId: connection.home.id,
                metadata: { ...state.sessions.s1.metadata, profileId: 'history-is-not-a-persona' } },
        }, settings: { ...previousSettings, voice: { ...previousSettings.voice, assistantLanguage: 'en',
            welcome: { enabled: true, mode: 'immediate', templateId: null } } } });
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: history, conversationSessionAddress: { serverId: connection.home.id, sessionId: history },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic', targetSessionAddress: bound ? targetAddress : null, updatedAt: 1 });
        try {
            const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
            await initializeVoiceAgentHandle({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn() });
            expect(rpcTargets.filter(target => target.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
                || target.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1).at(-1)?.sessionId).toBe(history);
            expect(admittedStart().launchProfileId).toBe(bound ? 'cached-profile' : undefined);
            expect(admittedStart().profileId).toBeUndefined();
            expect(admittedStart().profileSourceCustody).toBeUndefined();
            const { resolveVoiceWelcomeText } = await import('./voiceWelcomeText');
            if (!bound) expect(admittedPolicy()?.welcome?.text).toBe(resolveVoiceWelcomeText('en'));
        } finally {
            voiceSessionBindingStore.getState().unbind(history);
            const sessions = { ...storage.getState().sessions };
            delete sessions[history];
            storage.setState({ sessions, settings: previousSettings });
            state = storage.getState();
        }
    });

    it('uses hydrated layout-1 owner facts with the current list-selected session model', async () => {
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        state = storage.getState();
        const previousSettings = state.settings;
        const previousSession = state.sessions.s1;
        const rows = state.sessionListRowsByServerId[state.profileScope.serverId];
        const previousRow = rows.s1;
        try {
            state.settings = {
                ...previousSettings,
                voice: {
                    ...previousSettings.voice,
                    providers: {
                        ...previousSettings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...previousSettings.voice.providers.local_conversation.config,
                            agent: {
                                ...previousSettings.voice.providers.local_conversation.config.agent,
                                agentSource: 'agent', agentId: 'claude',
                                chatModelSource: 'session', commitModelSource: 'session',
                            },
                        } },
                    },
                },
            };
            state.sessions.s1 = {
                ...previousSession, metadataLayoutVersion: 1, modelMode: 'stale-session-model',
                metadata: { summaryText: 'Shared presentation' },
                ownerMetadataView: previousSession.metadata,
            };
            rows.s1 = {
                ...previousRow, metadataLayoutVersion: 1, modelMode: 'current-session-model',
                metadata: { summaryText: 'Current shared presentation' }, ownerMetadataView: null,
            };
            // Publish fixture replacement through the real store: Sync may have
            // replaced its root while the asynchronous module import settled.
            storage.setState({
                settings: state.settings,
                sessions: state.sessions,
                sessionListRowsByServerId: state.sessionListRowsByServerId,
            });
            await initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn(),
            });
            expect(buildBackendTargetKeyV2(admittedStart().backendTarget)).toBe(buildAgentUniverseBackendTargetKey('claude'));
            expect(admittedStart()).toMatchObject({ launchProfileId: 'raw-profile' });
            expect(admittedStart().chatModelId).toBeUndefined();
            expect(admittedStart().commitModelId).toBeUndefined();
        } finally {
            state.settings = previousSettings;
            state.sessions.s1 = previousSession;
            rows.s1 = previousRow;
            storage.setState({
                settings: previousSettings,
                sessions: state.sessions,
                sessionListRowsByServerId: state.sessionListRowsByServerId,
            });
            state = storage.getState();
        }
    });

    it('consumes the Session Agent admitted before capture without re-deciding it at first Send', async () => {
        state.sessions.s1.metadata = null;
        state.sessionListRowsByServerId[state.profileScope.serverId].s1.metadata = null;
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        await initializeVoiceAgentHandle({ sessionId: 's1',
            admittedSessionAgentTarget: { kind: 'builtInAgent', agentId: 'codex' },
            getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
            setDeferredTargetSessionContext: vi.fn(),
        });
        expect(admittedStart()).toMatchObject({ backendTarget: { kind: 'backend', backendId: 'codex' } });
    });

    it('admits the bound coding Session Agent once for Start and delayed Send', async () => {
        const { createVoiceExecutionTransport } = await import('@/voice/runtime/execution/VoiceExecutionTransport');
        const transport = createVoiceExecutionTransport();
        await transport.prepareAgentSelection('s1', new AbortController().signal);
        state.sessions.s1.metadata = null;
        state.sessionListRowsByServerId[state.profileScope.serverId].s1.metadata = null;
        await transport.prepareAgentSelection('s1', new AbortController().signal);
        await transport.ensureRunning('s1');
        expect(admittedStart()).toMatchObject({ backendTarget: { kind: 'backend', backendId: 'codex' } });
        await transport.stop('s1');
    });

    it('refuses a retained unreadable coding root at capture preparation despite a healthy carrier', async () => {
        const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
        const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
        voiceSessionBindingStore.getState().bind({ adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 's1',
            conversationSessionAddress: { serverId: connection.home.id, sessionId: 's1' },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic',
            targetSessionAddress: { serverId: connection.home.id, sessionId: 'missing-coding-root' }, updatedAt: 1 });
        try {
            const { createVoiceExecutionTransport } = await import('@/voice/runtime/execution/VoiceExecutionTransport');
            const transport = createVoiceExecutionTransport();
            await expect(transport.prepareAgentSelection(VOICE_AGENT_GLOBAL_SESSION_ID, new AbortController().signal))
                .rejects.toMatchObject({ code: 'VOICE_AGENT_SELECTION_UNAVAILABLE', message: 'voice_agent_selection_unavailable' });
            expect(start).not.toHaveBeenCalled();
        } finally {
            voiceSessionBindingStore.getState().unbind('s1');
        }
    });

    it.each<[string, () => void]>([
        ['visible session metadata', () => {
            state.sessions.s1.metadataLayoutVersion = 1;
            state.sessions.s1.ownerMetadataView = null;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.metadataLayoutVersion = 1;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.ownerMetadataView = null;
        }],
        ['cached session metadata', () => {
            state.sessions.s1.metadata = null;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.metadataLayoutVersion = 1;
            state.sessionListRowsByServerId[state.profileScope.serverId].s1.ownerMetadataView = null;
        }],
    ])('fails closed without RPC when the %s Agent is unreadable', async (_case, arrange) => {
        arrange();
        const getDaemonVoiceAgentClient = vi.fn((scope: ServerAccountScope) => new DaemonVoiceAgentClient(scope));
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');

        await expect(initializeVoiceAgentHandle({
            sessionId: 's1',
            getDaemonVoiceAgentClient,
            setDeferredTargetSessionContext: vi.fn(),
        })).rejects.toMatchObject({
            message: 'voice_agent_selection_unavailable',
            code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
        });

        expect(getDaemonVoiceAgentClient).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });

    it('routes migrated OpenAI-compatible Chat through the daemon with exact Provider selections', async () => {
        omitIncidentalProfile();
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const originalAgent = state.settings.voice.providers.local_conversation.config.agent;
        state.settings.voice.providers.local_conversation.config.agent = {
            ...originalAgent,
            agentSource: 'agent',
            agentId: 'opencode',
            providerChat: {
                status: 'configured',
                chat: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'chat-model',
                },
                commit: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'commit-model',
                },
            },
        };

        try {
            const handle = await initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn(),
            });

            expect(handle.backend).toBe('daemon');
            expect(admittedStart()).not.toHaveProperty('bootstrapTimeoutMs');
            expect(buildBackendTargetKeyV2(admittedStart().backendTarget)).toBe(buildAgentUniverseBackendTargetKey('opencode'));
            expect(admittedStart()).toMatchObject({
                chatModelId: 'chat-model',
                commitModelId: 'commit-model',
                modelSelection: expect.objectContaining({ providerConnectionId: 'voice-openai-compatible-chat' }),
                intentInput: { commitModelSelection: expect.objectContaining({ providerConnectionId: 'voice-openai-compatible-chat' }) },
            });
            expect(admittedStart()).not.toHaveProperty('sessionConfigOptionOverrides');
        } finally {
            state.settings.voice.providers.local_conversation.config.agent = originalAgent;
        }
    });

    it('requires explicit Provider import before starting with retained OpenAI-compatible settings', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const originalSettings = state.settings;
        const legacySecret = {
            id: 'voice:openai_compat:chat_api_key',
            name: 'Voice: openai_compat',
            kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'sk-existing' },
            createdAt: 0,
            updatedAt: 0,
        };
        state.settings = settingsParse({
            secrets: [legacySecret],
            voice: {
                providerId: 'local_conversation',
                adapters: {
                    local_conversation: {
                        conversationMode: 'agent',
                        agent: {
                            backend: 'openai_compat',
                            agentSource: 'agent',
                            agentId: 'opencode',
                            permissionPolicy: 'read_only',
                            openaiCompat: {
                                chatBaseUrl: 'http://127.0.0.1:11434/v1',
                                chatApiKey: legacySecret.encryptedValue,
                                chatModel: 'qwen-chat',
                                commitModel: 'qwen-commit',
                                temperature: 0.25,
                            },
                        },
                    },
                },
            },
        });

        // Publish the parsed Account settings through the real store. Async
        // Account restoration may have replaced the previously captured root.
        storage.setState({ settings: state.settings });

        try {
            await expect(initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn(),
            })).rejects.toMatchObject({
                code: 'VOICE_AGENT_PROVIDER_CHAT_MIGRATION_REQUIRED',
            });
            expect(start).not.toHaveBeenCalled();
            expect(storage.getState().settings).toBe(state.settings);
        } finally {
            state.settings = originalSettings;
            storage.setState({ settings: originalSettings });
        }
    });

    it.each([
        ['different', 'agent:happier.agent.codex/codex'],
        ['malformed', 'not-a-target-key'],
    ])('fails closed when the configured commit target is %s', async (_case, commitTargetKey) => {
        const { initializeVoiceAgentHandle } = await import('./initializeVoiceAgentHandle');
        const originalAgent = state.settings.voice.providers.local_conversation.config.agent;
        state.settings.voice.providers.local_conversation.config.agent = {
            ...originalAgent,
            agentSource: 'agent',
            agentId: 'opencode',
            providerChat: {
                status: 'configured',
                chat: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'chat-model',
                },
                commit: {
                    agentTargetKey: commitTargetKey,
                    providerConnectionId: 'voice-openai-compatible-chat',
                    modelId: 'commit-model',
                },
            },
        };

        try {
            await expect(initializeVoiceAgentHandle({
                sessionId: 's1',
                getDaemonVoiceAgentClient: scope => new DaemonVoiceAgentClient(scope),
                setDeferredTargetSessionContext: vi.fn(),
            })).rejects.toMatchObject({ code: 'VOICE_AGENT_PROVIDER_SELECTION_MISMATCH' });
            expect(start).not.toHaveBeenCalled();
        } finally {
            state.settings.voice.providers.local_conversation.config.agent = originalAgent;
        }
    });
});
