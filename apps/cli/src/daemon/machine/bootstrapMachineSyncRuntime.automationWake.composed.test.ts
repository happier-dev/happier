import fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, AutomationEventSourcesListInputV1Schema, AutomationEventStoredDefinitionsReadResultV1Schema, DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE, FeaturesResponseSchema, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol';

import { ApiMachineClient } from '@/api/apiMachine';
import { createAutomationEventAdoptedDefinitionSetHostV1, createAutomationEventStoredDefinitionsHttpTransportV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { runCheckpointedPluginEventObserverV1 } from '@happier-dev/plugin-sdk/background-services';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { Machine } from '@/api/types';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readAccountChangesCursor, readSettings, updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bindApiMachineSocketSequenceMock, createApiMachineSocketFixture } from '@/testkit/apiMachineTransport';
import { createAccountEncryptionCurrentnessFixture, createSessionListResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { formatPluginWebhookEndpointIdV1, PluginWebhookHeartbeatReceiptEphemeralV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import { startAutomationWorker, type AutomationWorkerHandle } from '../automation/automationWorker';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { readOrCreateInstallationIdentity } from '../identity/store';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './bootstrapMachineSyncRuntime';

const socketIo = vi.hoisted(() => vi.fn());
// Home's Socket.IO transport is the boundary. Every owner beneath it stays real.
vi.mock('socket.io-client', () => ({ io: socketIo }));

it.each(['startup', 'reconnect', 'resume', 'automation changes', 'workflow-run changes', 'interrupted workflow-run changes', 'cursor-gone', 'heartbeat receipt', 'source invalidation'] as const)(
    'catches up queued work through the composed Machine transport with empty assignments (%s)', async mode => {
        await withConfiguredDaemonTestHome({ prefix: 'automation-wake-machine-' }, async ({ homeDir }) => {
            const previousSettings = getActiveAccountSettingsSnapshot();
            clearActiveAccountSettingsSnapshot();
            withdrawActiveProjectAccountRowsSnapshot();
            const token = randomUUID();
            const accountId = 'automation-wake-account';
            const machine: Machine = { id: 'automation-wake-machine', encryptionMode: 'plain', metadata: null,
                metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
            await writeStoredCredentialsForServerId(configuration.activeServerId, { token, encryption: null });
            await updateSettings(settings => ({ ...settings,
                machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: machine.id } }));
            await readOrCreateInstallationIdentity();
            const origin = new URL(resolveServerHttpBaseUrl()).origin;
            const requests: string[] = [];
            let feedCursor = 0;
            let cursorGone = false;
            let claims = 0;
            let workflowChanges = false;
            let automationChanges = false;
            let sourceStatusChange = false;
            let settingsVersion = 7;
            let sourceRevision = '1';
            let definitionsWithdrawn = false;
            let storedReads = 0;
            let refusedTail = false;
            const heldTail = createDeferred<void>();
            const app = fastify();
            app.addHook('onRequest', async request => { requests.push(`${request.method} ${new URL(request.url, origin).pathname}`); });
            app.get('/v1/account/profile', async () => ({ id: accountId, connectedServicesV2: [] }));
            app.get('/v1/account/security', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
            app.get('/v1/auth/ping', async () => ({}));
            app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
            app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: settingsVersion }));
            const materialization = { pluginId: 'com.example.events', machineId: machine.id, materializationId: 'source-installation' };
            app.post(AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, async () => {
                storedReads += 1;
                return AutomationEventStoredDefinitionsReadResultV1Schema.parse({ kind: 'page', revision: sourceRevision, eventDeclarationRelease: {
                    release: { pluginId: 'com.example.events', version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                }, definitions: definitionsWithdrawn ? [] : [{ automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: Number(sourceRevision),
                    eventRef: { pluginId: materialization.pluginId, localId: 'changed' }, sourceSelectorId: '00000000-0000-4000-8000-000000000001',
                    sourceContractVersion: 1, payloadSchema: { type: 'object' },
                    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
                    storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                        binding: { v: 1, automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: Number(sourceRevision), triggerKind: 'pluginEvent',
                            eventRef: { pluginId: materialization.pluginId, localId: 'changed' }, sourceSelectorId: '00000000-0000-4000-8000-000000000001' },
                        definition: { v: 1, sourceInstanceId: 'source-1', sourceConfig: { revision: sourceRevision }, displayLabel: 'Source',
                            filter: null, maximumObservationAgeMs: null } }),
                }], nextCursor: null });
            });
            app.get('/v3/automations/worker/assignments', async () => ({ assignments: [],
                settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } }));
            app.get('/v3/automations/worker/run-lifecycle', async () => ({ sources: [] }));
            app.get('/v1/machines/:machineId', async () => ({ machine }));
            app.get('/v2/sessions', async () => createSessionListResponseFixture([]));
            app.get('/v2/changes', async (request, reply) => {
                if (cursorGone) return reply.code(410).send({ error: 'cursor-gone', currentCursor: feedCursor });
                const after = Number(new URL(request.url, origin).searchParams.get('after'));
                if (mode === 'interrupted workflow-run changes' && workflowChanges && after >= 200) {
                    if (!refusedTail) {
                        refusedTail = true;
                        return reply.code(503).send({ error: 'tail-unavailable' });
                    }
                    await heldTail.promise;
                }
                const count = Math.min(200, feedCursor - after);
                return { changes: Array.from({ length: Math.max(0, count) }, (_, index) => ({
                    cursor: after + index + 1, changedAt: 1,
                    kind: automationChanges || (sourceStatusChange && index === 1) ? 'automation' : 'account',
                    entityId: sourceStatusChange && index === 1 ? 'automation-source-status'
                        : automationChanges ? 'automation-definition'
                        : workflowChanges ? `workflow-run:run-${after + index + 1}`
                        : mode === 'source invalidation' ? 'self' : 'unrelated-account-row',
                    ...(mode === 'source invalidation' && !automationChanges ? { hint: { settingsVersion } } : {}),
                })), nextCursor: count > 0 ? after + count : after };
            });
            app.post('/v1/account/project-rows/:operation', async request => projectAccountRowsReadHttpResponse([], request.url, request.body).data);
            app.post('/v3/automations/runs/claim', async () => { claims += 1; return { run: null, automation: null, accountCurrentness: null }; });
            const restoreHttp = installAxiosFastifyAdapter({ app, origin });
            const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
                const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
                if (!path.startsWith('/v1/features')) throw new Error(`Unexpected Automation wake Fetch route: ${path}`);
                return Response.json(FeaturesResponseSchema.parse({
                    features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
                }));
            });
            const socket = createApiMachineSocketFixture();
            const reconnectSocket = createApiMachineSocketFixture();
            bindApiMachineSocketSequenceMock(socketIo, [socket, reconnectSocket]);
            let activeSocket = socket;
            const client = new ApiMachineClient(token, machine);
            const phases: string[] = [];
            client.onConnectionStateChange(state => { phases.push(state.phase); });
            let control: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
            let bootstrap: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
            let admittedRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
            let sourceHintSubscription: { dispose(): void | Promise<void> } | undefined;
            const sourceHints: HostEventEnvelopeV1[] = [];
            const workerRef: { current: AutomationWorkerHandle | null } = { current: null };
            try {
                const settings = await bootstrapAccountSettingsContext({ credentials: { token, encryption: null }, mode: 'blocking', allowCacheFallback: false });
                expect(settings.source).toBe('network');
                control = await createRequesterSessionControlRuntimeFixture({
                    credentials: { token, encryption: null }, happyHomeDir: homeDir,
                    activeServerDir: configuration.activeServerDir, serverId: configuration.activeServerId,
                    serverHttpBaseUrl: resolveServerHttpBaseUrl(), machineId: machine.id, custodianAccountId: accountId,
                    connectedServicesMaterializationBaseDir: join(homeDir, 'materialized'),
                    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(),
                    getRequester: () => null, getApiMachineForSessions: () => client,
                    resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
                });
                if (mode === 'reconnect' || mode === 'heartbeat receipt' || mode === 'source invalidation') {
                    admittedRuntime = await createAdmittedPluginRuntimeFixture({
                        happyHomeDir: homeDir, controller: pluginReloadController, runtimeOptions: { pluginIds: [] },
                    });
                    const broker = admittedRuntime.registry.stableEventsBroker;
                    if (!broker) throw new Error('The admitted runtime must publish its Host Event broker');
                    sourceHintSubscription = broker.subscribeHost({
                        target: { eventId: mode === 'heartbeat receipt'
                            ? '@happier/health-check/heartbeat-received'
                            : '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } },
                        listener: event => { sourceHints.push(event); },
                        isCurrent: () => true,
                    });
                }
                bootstrap = await bootstrapMachineSyncRuntime({
                    token, cliVersion: '0.0.0-test', machineId: machine.id, machine,
                    preferredHost: 'host.local', happyHomeDir: homeDir, happyLibDir: homeDir,
                    filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
                    createConnectedApiMachine: () => client, attachTransferRuntimeStatePublisher: async () => {},
                    startAutomationWorkerForMachine: machineId => {
                        const worker = startAutomationWorker({ token, machineId, env: { NODE_ENV: 'test' } });
                        workerRef.current = worker;
                        return worker;
                    },
                    startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
                    spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
                    spawnSessionForInternalResume: async () => { throw new Error('Unexpected internal resume'); },
                    stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
                    loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
                    directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
                    connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
                    daemonServerWorkScheduler: createDaemonServerWorkScheduler({
                        budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
                    }),
                    reconcileConnectedServicesProjection: control.runtime.reconcileConnectedServicesProjection,
                });
                const activeWorker = bootstrap.automationWorker;
                if (!activeWorker) throw new Error('Automation worker was not started by Machine bootstrap');
                await vi.waitFor(() => expect(phases).toContain('online'));
                await vi.waitFor(() => expect(requests).toContain('GET /v3/automations/worker/assignments'));
                if (mode === 'startup') {
                    await vi.waitFor(() => expect(claims).toBe(1));
                    await activeWorker.liveWorkProducer.read();
                    expect(claims).toBe(1);
                    return;
                }
                await vi.waitFor(() => expect(client.hasCurrentAccountChangesObserver(), JSON.stringify({ phases, requests })).toBe(true));
                await vi.waitFor(() => expect(claims).toBe(1));
                await activeWorker.liveWorkProducer.read();
                if (mode === 'source invalidation') {
                    expect((await readSettings()).machineId).toBe(machine.id);
                    const broker = admittedRuntime?.registry.stableEventsBroker;
                    if (!broker) throw new Error('Expected admitted Host Event broker');
                    const observerLifetime = new AbortController();
                    const readErrors: string[] = [];
                    const storedTransport = createAutomationEventStoredDefinitionsHttpTransportV1({ credentials: { token, encryption: null }, revalidateCaller: async () => true });
                    const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials: { token, encryption: null },
                        caller: materialization, occurrenceId: 'source-occurrence', sourceCustody: { kind: 'managed', immutableGenerationId: 'source-generation', installSource: 'archive' },
                        transport: { kind: 'checkpointedPull' }, occurrenceSignal: observerLifetime.signal,
                        isOccurrenceCurrent: () => !observerLifetime.signal.aborted,
                        revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
                        readStoredDefinitions: async request => { try { return await storedTransport.read(request); }
                            catch (error) { readErrors.push(error instanceof Error ? error.message : 'unknown stored read'); throw error; } } });
                    const observedRevisions: number[] = [];
                    // The SDK host boundary uses the real broker and adopted reader; HTTP below remains the system boundary.
                    const context = { plugin: { id: materialization.pluginId, version: '1.0.0' }, materialization,
                        signal: observerLifetime.signal, surface: 'background', services: {
                            actions: { execute: async (id: string, input: unknown) => {
                                if (id === 'automation.event.sources.list') {
                                    try { return await owner.listPublicProjection({ accountId,
                                        input: AutomationEventSourcesListInputV1Schema.parse(input), signal: observerLifetime.signal }); }
                                    catch (error) { readErrors.push(error instanceof Error ? error.message : 'unknown source read'); throw error; }
                                }
                                if (id === 'automation.event.source.status.report') return { kind: 'reported' };
                                throw new Error(`Unexpected source Action: ${id}`);
                            } }, events: { host: { subscribe: (target: Parameters<typeof broker.subscribeHost>[0]['target'], listener: (event: HostEventEnvelopeV1) => void | Promise<void>) =>
                                broker.subscribeHost({ target, listener, isCurrent: () => !observerLifetime.signal.aborted }) } },
                        } } as unknown as BackgroundServiceContext;
                    const running = runCheckpointedPluginEventObserverV1({ context, source: {
                        decode: definition => definition.triggerRevision,
                        observe: async ({ source }) => { observedRevisions.push(source); return { observations: [], complete: true, nextEligibleAt: null }; },
                        save: async () => {}, retryAt: ({ error }) => { readErrors.push(error instanceof Error ? error.message : 'unknown'); return null; },
                    } });
                    const replay = async () => {
                        feedCursor += 1;
                        activeSocket.trigger('update', { id: `source-trigger-${feedCursor}`, seq: feedCursor, createdAt: 1, body: { t: 'account-change' } });
                        await vi.waitFor(async () => expect(await readAccountChangesCursor(accountId)).toBe(feedCursor));
                        await new Promise<void>(resolve => setImmediate(resolve));
                    };
                    try {
                        await vi.waitFor(() => expect(observedRevisions, JSON.stringify({ storedReads, requests, readErrors })).toEqual([1]));
                        storedReads = 0;
                        sourceHints.length = 0;
                        for (let n = 0; n < 5; n += 1) { settingsVersion += 1; await replay(); }
                        expect(storedReads).toBe(0);
                        expect(sourceHints.map(event => event.payload)).toEqual(Array.from({ length: 5 }, () => ({ definitionsChanged: false })));
                        sourceRevision = '2'; automationChanges = true;
                        await replay();
                        await vi.waitFor(() => expect(observedRevisions.at(-1)).toBe(2));
                        expect(storedReads).toBe(1);
                        definitionsWithdrawn = true; sourceRevision = '3';
                        await replay();
                        await vi.waitFor(() => expect(owner.readPublicProjection()).toMatchObject({ kind: 'available', revision: '3', definitions: [] }));
                        expect(storedReads).toBe(2);
                        automationChanges = false;
                        activeSocket = reconnectSocket; socket.connected = false; socket.trigger('disconnect', 'transport close');
                        await vi.waitFor(() => expect(reconnectSocket.connect).toHaveBeenCalledOnce());
                        await vi.waitFor(() => expect(sourceHints.some(event => 'reason' in event.payload && event.payload.reason === 'reconnect')).toBe(true));
                        await vi.waitFor(() => expect(storedReads).toBe(3));
                        expect(owner.readPublicProjection()).toMatchObject({ kind: 'available', revision: '3', definitions: [] });
                    } finally { observerLifetime.abort(); await running; }
                    return;
                }
                if (mode === 'heartbeat receipt') {
                    const receipt = PluginWebhookHeartbeatReceiptEphemeralV1Schema.parse({
                        type: 'health-check-heartbeat-received', webhookEndpointId: formatPluginWebhookEndpointIdV1(new Uint8Array(16)),
                        sourceInstanceId: 'health-source', checkId: 'heartbeat-check', lastAcceptedAt: 100 });
                    const payload = { webhookEndpointId: receipt.webhookEndpointId, sourceInstanceId: receipt.sourceInstanceId,
                        checkId: receipt.checkId, lastAcceptedAt: receipt.lastAcceptedAt };
                    const requestsBeforeReceipt = requests.slice();
                    socket.trigger('ephemeral', { type: 'unrelated-ephemeral' });
                    socket.trigger('ephemeral', { ...receipt, lastAcceptedAt: -1 });
                    expect(sourceHints).toEqual([]);
                    socket.trigger('ephemeral', receipt);
                    expect(sourceHints).toEqual([{ eventId: '@happier/health-check/heartbeat-received',
                        scope: { kind: 'account' }, payload }]);
                    expect(requests).toEqual(requestsBeforeReceipt);
                    expect(claims).toBe(1);

                    socket.connected = false;
                    socket.trigger('disconnect', 'transport close');
                    await vi.waitFor(() => expect(reconnectSocket.connect).toHaveBeenCalledOnce());
                    await vi.waitFor(() => expect(client.hasCurrentAccountChangesObserver()).toBe(true));
                    const requestsAfterReconnect = requests.slice();
                    const claimsAfterReconnect = claims;
                    socket.trigger('ephemeral', { ...receipt, lastAcceptedAt: 200 });
                    expect(sourceHints).toHaveLength(1);
                    reconnectSocket.trigger('ephemeral', { ...receipt, lastAcceptedAt: 300 });
                    expect(sourceHints).toEqual([
                        { eventId: '@happier/health-check/heartbeat-received', scope: { kind: 'account' }, payload },
                        { eventId: '@happier/health-check/heartbeat-received', scope: { kind: 'account' },
                            payload: { ...payload, lastAcceptedAt: 300 } },
                    ]);
                    expect(requests).toEqual(requestsAfterReconnect);
                    expect(claims).toBe(claimsAfterReconnect);
                    await retireMachineSyncRuntimeAttempt(bootstrap);
                    bootstrap = undefined;
                    reconnectSocket.trigger('ephemeral', { ...receipt, lastAcceptedAt: 400 });
                    expect(sourceHints).toHaveLength(2);
                    return;
                }
                if (mode !== 'startup') {
                    claims = 0;
                    if (mode === 'reconnect') {
                        sourceHints.length = 0;
                        activeSocket = reconnectSocket;
                        socket.connected = false;
                        socket.trigger('disconnect', 'transport close');
                        await vi.waitFor(() => expect(reconnectSocket.connect).toHaveBeenCalledOnce());
                    } else if (mode === 'resume') {
                        activeWorker.pause();
                        activeWorker.resume();
                        await bootstrap.resumeMachineConnectionPublications();
                    } else {
                        workflowChanges = mode === 'workflow-run changes' || mode === 'interrupted workflow-run changes';
                        automationChanges = mode === 'automation changes';
                        cursorGone = mode === 'cursor-gone';
                        feedCursor = workflowChanges ? 401 : 1;
                        socket.trigger('update', { id: 'automation-work-catchup', seq: feedCursor, createdAt: 1,
                            body: { t: 'account-change' } });
                    }
                    await vi.waitFor(() => expect(claims).toBe(1));
                    if (mode === 'reconnect') {
                        await vi.waitFor(() => expect(sourceHints).toEqual(expect.arrayContaining([
                            expect.objectContaining({ payload: { reason: 'reconnect' } }),
                        ])));
                    }
                    if (mode !== 'reconnect') {
                        const checkpoint = mode === 'interrupted workflow-run changes' ? 200 : feedCursor;
                        await vi.waitFor(async () => expect(await readAccountChangesCursor(accountId)).toBe(checkpoint));
                    }
                }
                await activeWorker.liveWorkProducer.read();
                expect(claims).toBe(1);
                if (mode === 'interrupted workflow-run changes') {
                    expect(refusedTail).toBe(true);
                    expect(await readAccountChangesCursor(accountId)).toBe(200);
                    return;
                }
                // Other Account and source-status changes cannot create empty claims.
                cursorGone = false;
                workflowChanges = false;
                automationChanges = false;
                sourceStatusChange = true;
                feedCursor += 2;
                activeSocket.trigger('update', { id: 'automation-unrelated-change', seq: feedCursor, createdAt: 1,
                    body: { t: 'account-change' } });
                await vi.waitFor(async () => expect(await readAccountChangesCursor(accountId)).toBe(feedCursor));
                await activeWorker.liveWorkProducer.read();
                expect(claims).toBe(1);
            } finally {
                workerRef.current?.stop();
                heldTail.resolve();
                try {
                    if (bootstrap) await retireMachineSyncRuntimeAttempt(bootstrap);
                    else await client.shutdown();
                } finally {
                    await sourceHintSubscription?.dispose();
                    await admittedRuntime?.dispose();
                    await control?.dispose();
                    restoreHttp();
                    fetchBoundary.mockRestore();
                    await app.close();
                    clearActiveAccountSettingsSnapshot();
                    if (previousSettings) setActiveAccountSettingsSnapshot(previousSettings);
                    withdrawActiveProjectAccountRowsSnapshot();
                }
            }
        });
    },
);
