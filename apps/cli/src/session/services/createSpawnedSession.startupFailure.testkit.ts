import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogKeyV1Schema, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { SessionTurnMutationV1Schema, type SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '@/daemon/types';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createMachineSessionSpawnRpcHandler } from '@/session/actions/sessionLifecycleActions';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as sessionSockets from '@/api/session/sockets';
import { createSocketTransportAdapter, socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunch';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';

/** The existing startup-refusal composition. Native producers can supply their
 * actual host startup; its lifecycle publishes at the Session
 * persistence boundary before attestation, Action and strict CLI consumers. */
export async function assertStartupFailureThroughCli(input: Readonly<{
    preparationCode: string | null;
    settlementKind: 'returned' | 'nonce';
    sessionId?: string;
    agent?: Readonly<{ id: string; title?: string; identity: AgentExecutionTargetV1['identity'] }>;
    expectedFailureCause?: NonNullable<SessionRuntimeIssueV1['failureCause']>;
    expectedRetryable?: false;
    publishFailure?: (persist: (mutation: SessionTurnMutationV1) => Promise<void>) => Promise<void>;
}>) {
    const { preparationCode, settlementKind } = input;
    const agent = input.agent ?? { id: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const home = await mkdtemp(join(tmpdir(), 'happier-native-startup-failure-'));
    const sessionId = input.sessionId ?? 'c1234567890123456789012345';
    const machineId = 'machine-native-startup-failure';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64url')}.signature`, encryption: null } as const;
    let operationSequence = 0;
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => 'fixture-account',
        generateOperationId: () => `native-startup-${++operationSequence}` });
    let row: ReturnType<typeof createCurrentSessionProjectionRecordFixture> | null = null;
    const runners: ReturnType<typeof spawn>[] = [];
    const tracked = new Map<SessionTrackingKey, TrackedSession>();
    const sessionChanges = createSessionLiveWorkProducer({ readSessions: () => [...tracked.values()],
        readActivity: async () => ({ session: 'unknown', input: 'unknown' }) });
    let launches = 0;
    let nonceReads = 0;
    let admittedInputs = 0;
    const admittedLocalIds: unknown[] = [];
    let creationTag: string | undefined;
    let nativeStartupFailure: Extract<SpawnSessionResult, { type: 'error' }> | null = null;
    const unknownRequests: string[] = [];
    let publishedIssue: SessionRuntimeIssueV1 | null = null;
    let publicationFailure: unknown;
    const producerFetch = globalThis.fetch;
    const producerSocket = vi.isMockFunction(sessionSockets.createUserScopedSocketConnection)
        ? vi.mocked(sessionSockets.createUserScopedSocketConnection).getMockImplementation()
        : sessionSockets.createUserScopedSocketConnection;
    const producerServerHttpBaseUrl = resolveServerHttpBaseUrl();
    const producerGet = vi.isMockFunction(axios.get) ? vi.mocked(axios.get).getMockImplementation() : undefined;
    const producerPost = vi.isMockFunction(axios.post) ? vi.mocked(axios.post).getMockImplementation() : undefined;
    resetServerFeaturesClientForTests();
    // HTTP/authentication and the OS child process are the only replaced
    // boundaries; retained operation custody, native-open observation and
    // same-key creation/rejoin all run their production implementations.
    vi.stubGlobal('fetch', vi.fn(async (value: Parameters<typeof fetch>[0], init?: RequestInit) =>
        input.publishFailure && !String(value).startsWith('https://fixture.example.test')
        ? await producerFetch(value, init) : String(value).endsWith('/v1/features')
        ? Response.json({ features: {}, capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })
        : Response.json({ id: 'fixture-account' })));
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) =>
        input.publishFailure && producerGet && !String(url).startsWith('https://fixture.example.test')
        ? await producerGet(url, options) : String(url).includes('/v1/access-keys/')
        ? { status: 200, data: { accessKey: 'fixture-existing-binding' } }
        : String(url).endsWith('/v2/account/settings') ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } }
        : String(url).includes(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/`) ? { status: 200, data: {
            status: 'present', revision: 1, content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1(
                ConnectedAccountCatalogKeyV1Schema.parse(String(url).split('/').at(-1))) } } }
        : String(url).endsWith('/v1/machines/'+machineId) ? { status: 200, data: { machine: {
            id: machineId, active: true, installationId: 'fixture-installation', kind: 'persistent', storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
        } } }
        : String(url).includes('/v2/sessions/') ? { status: 200, data: { session: row } }
            : { status: 200, data: createAccountEncryptionCurrentnessFixture() });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
        if (input.publishFailure && producerPost && !String(url).startsWith('https://fixture.example.test')) {
            return await producerPost(url, body, options);
        }
        if (String(url).endsWith('/v1/home/governance/get')) return { status: 200, data: { homeDefaults: null } };
        if (String(url).endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: row ? [row] : [] } };
        if (String(url).endsWith(`/sessions/${sessionId}/pending`)) {
            admittedInputs += 1;
            admittedLocalIds.push(body && typeof body === 'object' ? Reflect.get(body, 'localId') : undefined);
            return { status: 200, data: { didWrite: true } };
        }
        unknownRequests.push(String(url));
        throw new Error(`Unexpected native startup HTTP request ${url}`);
    });
    const handler = createMachineSessionSpawnRpcHandler({ handlers: {
        spawnSession: async options => {
            launches += 1;
            creationTag = options.sessionCreationTag;
            tracked.clear();
            const child = preparationCode === 'opened'
                ? spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
                : spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
            runners.push(child);
            if (!child.pid) throw new Error('Missing fixture runner pid');
            child.once('exit', () => sessionChanges.notifySessionChanged(sessionId));
            tracked.set(legacyPidSessionTrackingKey(child.pid), { trackingKey: legacyPidSessionTrackingKey(child.pid), pid: child.pid, startedBy: 'daemon', happySessionId: sessionId,
                ...(preparationCode === 'opened' ? { agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/native-startup-authority' } : {}),
                childProcess: child, processStartTimeMs: Date.now() });
            sessionChanges.notifySessionChanged(sessionId);
            const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
                storedContentMode: 'plain', agentState: null, metadata: {
                    ...buildCommittedLaunchMetadata({ options, directory: home }), hostPid: child.pid,
                } });
            row = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture(sessionId),
                encryptionMode: 'plain', share: null, active: preparationCode === 'opened', archivedAt: null,
                runtimeActivityState: 'idle', runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 1, runtimeActivityRevision: 1,
                metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
                ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
            SessionLookupByTagsResponseV2Schema.parse({ sessions: [row] });
            const publishFailure = input.publishFailure;
            if (publishFailure) {
                await runWithServerHttpBaseUrl(producerServerHttpBaseUrl, () => publishFailure(async value => {
                    const mutation = SessionTurnMutationV1Schema.parse(value);
                    if (mutation.sessionId !== sessionId) throw new Error('Startup refusal belongs to another Session');
                    if (mutation.action === 'fail') {
                        publishedIssue = mutation.issue;
                        if (!row) throw new Error('Native refusal preceded Session custody');
                        row = { ...row, latestTurnStatus: 'failed', lastRuntimeIssue: mutation.issue };
                        sessionChanges.notifySessionChanged(sessionId);
                    }
                })).catch(error => {
                    publicationFailure = error;
                    throw error;
                });
                if (!publishedIssue) throw new Error('Real host startup catch did not publish the native refusal');
            }
            return { type: 'success', sessionId, ...(preparationCode === 'opened' || preparationCode === 'broker_unavailable' ? { sessionCreationOutcome: {
                disposition: 'created' as const,
                organizationPlacement: options.sessionCreationCorrespondence?.recipe.organization ?? { folderId: null, tagIds: [] },
            } } : {}) };
        },
        stopSession: async () => ({ status: 'not_found' }),
    }, awaitAgentSessionOpen: openInput => awaitTrackedRunnerAgentSessionOpen({ subscribeChanges: listener => sessionChanges.subscribe(listener, sessionId), ...openInput, getTrackedSessions: () => [...tracked.values()],
        readStartupFailure: async () => input.publishFailure ? row?.lastRuntimeIssue ?? null : preparationCode && preparationCode !== 'opened' ? classifyPrimarySessionRuntimeIssue({
            cause: 'session_error', ...(preparationCode === 'agent_cli_not_runnable' ? { provider: 'codex' } : {}), error: preparationCode === 'broker_unavailable'
                || preparationCode === 'connected_service_credential_reconnect_required'
                ? new SessionTeamCredentialLaunchUnavailableError(preparationCode) : { code: preparationCode }, occurredAt: Date.now(),
        }) : null,
    }) });
    const machineTransport: NonNullable<Parameters<typeof createCliActionDeps>[0]['machineActionDirectTargetTransport']> = { machineId, invoke: async (method, ...args) => {
            // This Machine RPC boundary reports the executable whose native
            // startup is exercised below; readiness and admission stay real.
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
                protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
                    [agent.id]: { ...agent, capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
                } },
            };
            if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: { [`cli.${agent.id}`]: {
                ok: true, checkedAt: 1, data: { installed: true, version: null, latestVersion: null,
                    update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'unsupported' },
                    platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] },
            } } };
            return await createLocalMachineActionTransportFixture(machineId).invoke(method, ...args);
        } };
    // Substitute the opened connection only for the CLI side of the composition.
    vi.spyOn(sessionSockets, 'createUserScopedSocketConnection').mockImplementation(options => {
        if (producerSocket && options.serverUrl !== 'https://fixture.example.test') return producerSocket(options);
        const socket = createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
            if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object'
                || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Unexpected Machine RPC envelope');
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
            const method = raw.method.slice(raw.method.indexOf(':') + 1);
            const result = await machineTransport.invoke(method, decoded.params);
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        } });
        return { socket, transport: createSocketTransportAdapter(socket, options) } as unknown as ReturnType<typeof sessionSockets.createUserScopedSocketConnection>;
    });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'fixture-home',
        serverHttpBaseUrl: 'https://fixture.example.test',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
        machineActionDirectTargetTransport: machineTransport,
        sessionSpawnDirectTargetTransport: { machineId,
            prepare: async () => ({ ok: true, directory: home, directoryKind: 'managed', directoryCreationRequired: false, checkout: null }),
            spawnedSession: { spawn: async (request, options) => {
                try {
                    const result = await handler(request, options);
                    if (settlementKind === 'nonce' && result.type === 'error') {
                        nativeStartupFailure = result;
                        return { success: true, status: 'pending', sessionIdStatus: 'pending', spawnNonce: request.spawnNonce };
                    }
                    return result;
                }
                catch (error) { expect(error).toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED }); throw error; }
            },
                // The physical launch nonce is already successful; the
                // subsequent native startup refusal belongs to the Action.
                resolveSpawnSessionByNonce: async () => {
                    nonceReads += 1;
                    if (settlementKind === 'returned') return { status: 'success', sessionId };
                    if (!nativeStartupFailure?.errorCode) throw new Error('Missing native startup settlement');
                    return { status: 'error', errorCode: nativeStartupFailure.errorCode,
                        errorMessage: nativeStartupFailure.errorMessage, agentId: nativeStartupFailure.agentId, errorDetail: nativeStartupFailure.errorDetail };
                } },
        } }));
    const actionInput = { creationKey: 'native-exit', executionTarget: { serverId: 'fixture-home', machineId },
        directory: { kind: 'managed' as const },
        agentTarget: { kind: 'agent' as const, identity: agent.identity },
        initialInput: { text: 'Must wait for a native runner' }, initialTriggers: [],
        connectedServices: { v: 2 as const, bindingsByServiceId: {} }, memoryEnabled: false };
    const invoke = (observeSessionCommit = false) => {
      const observedInput = { ...actionInput, ...(observeSessionCommit ? { observeSessionCommit: true } : {}) };
      return operations.observeExecution({ actionId: 'session.spawn_new', input: observedInput,
        actionRequestId: actionInput.creationKey, execute: context => runWithServerHttpBaseUrl('https://fixture.example.test', () => executor.execute('session.spawn_new', observedInput,
            { ...context, surface: observeSessionCommit ? 'ui' : 'cli', authority: 'present_user', serverId: 'fixture-home',
                presentUserConfirmation: { actionId: 'session.spawn_new' } })) });
    };
    try {
        const nonRetryableNativeFailure = input.expectedRetryable === false || preparationCode === 'agent_cli_not_runnable'
            || preparationCode === 'connected_service_credential_reconnect_required'
            || preparationCode === 'provider_compatibility_unverified';
        const observesCommit = (preparationCode === 'broker_unavailable' || preparationCode === 'opened'
            || nonRetryableNativeFailure) && settlementKind === 'returned';
        const initial = await invoke(observesCommit);
        // Fixture assertions are not native launch refusals. Preserve their
        // original evidence even when the real Action converts thrown errors.
        if (publicationFailure !== undefined) throw publicationFailure;
        if (observesCommit) {
            expect(initial).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted', sessionId } });
            expect(launches).toBe(1);
            expect(admittedInputs).toBe(0);
            if (preparationCode === 'opened' || preparationCode === 'broker_unavailable') {
                const terminal = invoke();
                const runner = [...tracked.values()][0];
                if (!runner || !creationTag) throw new Error('Missing committed runner identity');
                if (preparationCode === 'opened') {
                    runner.agentRuntimeDaemonServiceSessionOpenAttestation = {
                        request: { kind: 'create', sessionId, cwd: home }, providerSessionId: 'native-session',
                    };
                    sessionChanges.notifySessionChanged(sessionId);
                }
                const localId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: creationTag });
                const terminalResult = await terminal;
                expect(terminalResult, JSON.stringify(terminalResult)).toMatchObject({ ok: true, result: { type: 'success', sessionId,
                    initialInput: { status: 'accepted', localId } } });
                expect(admittedLocalIds).toEqual([localId]);
                expect(await invoke()).toMatchObject({ ok: true, result: { type: 'success', sessionId,
                    initialInput: { status: 'accepted', localId } } });
                expect(admittedInputs).toBe(1);
                expect(launches).toBe(1);
                if (preparationCode === 'broker_unavailable') {
                    expect(row).toMatchObject({ id: sessionId, active: false });
                    expect(runner.agentRuntimeDaemonServiceSessionOpenAttestation).toBeUndefined();
                }
                expect(unknownRequests).toEqual([]);
                return;
            }
            // Reconnect joins the exact invocation without offering its owned input again.
            expect(await invoke()).toMatchObject({ ok: false, errorCode: 'spawn_failed', details: { type: 'error', code: 'spawn_failed',
                ...(nonRetryableNativeFailure ? { retryable: false } : {}), launchError: { code: preparationCode } } });
            expect(launches).toBe(1);
            expect(admittedInputs).toBe(0);
        }
        const first = await operations.handlers.getV2({ operationId: 'native-startup-1', waitForTerminal: true });
        const launchError = { code: preparationCode ?? 'SPAWN_FAILED', message: readSessionStartupFailurePreview(preparationCode,
            preparationCode === 'agent_cli_not_runnable' ? resolveAgentDisplayTitle('codex') : null)
            ?? 'Agent runner exited before native Session startup completed',
            ...(input.expectedFailureCause ? { failureCause: input.expectedFailureCause } : {}),
        };
        expect(first).toMatchObject({ kind: 'found', operation: { result: { type: 'error', code: 'spawn_failed',
            launchError } } });
        if (first.kind !== 'found') throw new Error('Missing startup operation');
        expect(SessionSpawnNewResultV1Schema.parse(first.operation.result)).toMatchObject({
            type: 'error', code: 'spawn_failed', ...(nonRetryableNativeFailure ? { retryable: false } : {}), launchError,
        });
        expect(launches).toBe(1);
        const settledNonceReads = nonceReads;
        const repeated = await invoke();
        if (nonRetryableNativeFailure) {
            expect(repeated).toMatchObject({ ok: false, errorCode: 'spawn_failed', details: { type: 'error', code: 'spawn_failed',
                retryable: false, launchError } });
            expect(operationSequence).toBe(1);
            expect(nonceReads).toBe(settledNonceReads);
        }
        expect(await operations.handlers.getV2({ operationId: nonRetryableNativeFailure
            ? 'native-startup-1' : 'native-startup-2', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { result: { type: 'error', code: 'spawn_failed',
                ...(nonRetryableNativeFailure ? { retryable: false } : {}), launchError } } });
        expect(launches).toBe(1);
        expect(admittedInputs).toBe(0);
        expect(row).toMatchObject({ id: sessionId });
        expect(unknownRequests).toEqual([]);
    } finally {
        await Promise.all(runners.map(async child => {
            if (child.exitCode === null && child.signalCode === null) {
                if (preparationCode === 'opened') child.kill('SIGTERM');
                await once(child, 'exit');
            }
        }));
        vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
        await rm(home, { recursive: true, force: true });
    }
}

