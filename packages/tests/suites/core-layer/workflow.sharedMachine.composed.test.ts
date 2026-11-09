import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import {
    type AutomationAccountCurrentnessWitnessV1, type WorkflowDefinitionV1, type SessionTurnV1,
    SessionPendingEnqueueByMachineRequestV1Schema, SessionPendingEnqueueByMachineResponseV1Schema,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, WorkflowRunListRequestV1Schema,
    sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
    openWorkflowAcceptedSnapshotStoredEnvelopeV1, WorkflowRunRecipientCensusResponseV1Schema,
    resolveWorkflowRunDataKeyV1, createAccountScopedCryptoMaterialSnapshotV1,
} from '@happier-dev/protocol';
import type { AvailableAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import type { RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { SessionTurnsProjectionV1Schema, buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { createWorkflowRunActionOwner } from '../../../../apps/cli/src/session/actions/workflowRunActions';
import { createAutomationClaimClient } from '../../../../apps/cli/src/daemon/automation/automationClaimClient';
import { resolveAutomationWorkerAccountEncryption, startAutomationWorker } from '../../../../apps/cli/src/daemon/automation/automationWorker';
import { createCliWorkflowTriggerActions } from '../../../../apps/cli/src/session/actions/workflowTriggers';
import { createWorkflowRequesterCustody, listWorkflowRequesterCredentialScopes, reconcileWorkflowRequesterCredentialScope,
    retainWorkflowRequesterCredentials } from '../../../../apps/cli/src/daemon/workflows/requesterCustody';
import { getAutomationDefinition } from '../../../../apps/cli/src/api/automations';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createUnavailableActionTransportDeps } from '../../../../apps/cli/src/testkit/actionTransportDeps';
import { createWorkflowRunStorageClient } from '../../../../apps/cli/src/daemon/workflows/workflowRunStorageClient';
import { createProductionWorkflowRunCoordinator } from '../../../../apps/cli/src/daemon/workflows/production';
import { createWorkflowAcceptedAuthorizationCurrentness } from '../../../../apps/cli/src/daemon/workflows/daemonRuntime';
import { resolveWorkflowSessionConversation } from '../../../../apps/cli/src/daemon/workflows/invocationRecoveryObserver';
import { prepareWorkflowSessionRequester, runObservedWorkflowSessionStartup } from '../../../../apps/cli/src/daemon/workflows/workflowSessionStartup';
import { createWorkflowRunMachineTransport } from '../../../../apps/cli/src/daemon/workflows/workflowMachineTransport';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { registerActionOperationRpcHandlers } from '../../../../apps/cli/src/daemon/actionOperations/actionOperationRpcHandlers';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { createHostActionOperationRuntime } from '../../../../apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import { createMachineSessionSpawnRpcHandler } from '../../../../apps/cli/src/session/actions/sessionLifecycleActions';
import { awaitTrackedRunnerAgentSessionOpen } from '../../../../apps/cli/src/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { buildCommittedLaunchMetadata } from '../../../../apps/cli/src/agent/runtime/createSessionMetadata';
import { createInitialHostRuntimeActivityMutation } from '../../../../apps/cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createTestMetadata } from '../../../../apps/cli/src/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub } from '../../../../apps/cli/src/testkit/backends/apiSessionSocketHarness';
import { createGitWorkflowWorkspaceTestDependencies } from '../../../../apps/cli/src/daemon/workflows/workflowWorkspace.testkit';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { ApiMachineClient } from '../../../../apps/cli/src/api/apiMachine';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import type { TranscriptMessageLookupResult } from '../../../../apps/cli/src/api/session/transcriptMessageLookup';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '../../../../apps/cli/src/api/session/transcriptMessageLookup';
import { readSessionMessageReply } from '../../../../apps/cli/src/session/services/sessionMessageReply';
import type { StoredCredentials } from '../../../../apps/cli/src/persistence';

const localConfiguration = vi.hoisted(() => ({ paths: {} as Record<string, string> }));
// Isolate the daemon's OS configuration paths; custody, identity-file reads and
// installation signing remain real beneath this environment adapter.
vi.mock('../../../../apps/cli/src/configuration', async importOriginal => {
    const actual = await importOriginal<typeof import('../../../../apps/cli/src/configuration')>();
    return { ...actual, configuration: new Proxy(actual.configuration, {
        get(target, key, receiver) {
            return typeof key === 'string' && key in localConfiguration.paths
                ? localConfiguration.paths[key] : Reflect.get(target, key, receiver);
        },
    }) };
});

type Machine = Readonly<{ id: string; installationId: string; keys: tweetnacl.SignKeyPair }>;
interface SharedServer {
    readonly accountId: string;
    readonly custodianAccountId: string;
    readonly token: string;
    readonly homeId: string;
    readonly baseUrl: string;
    readonly guest: { accountId: string; token: string; currentness: AutomationAccountCurrentnessWitnessV1 };
    readonly currentness: AutomationAccountCurrentnessWitnessV1;
    readonly foreign: { accountId: string; token: string };
    readonly machines: readonly Machine[];
    publisherHeader(input: { machineId: string; path: string; body: unknown }): string;
    claimGuestRun(machineId: string): Promise<{ runId: string; attempt: number; revision: number }>;
    revokeGuest(machineId: string): Promise<unknown>;
    readEffects(): Promise<{ runs: Array<{ id: string; accountId: string; state: string; errorCode: string | null }>;
        sessions: Array<{ id: string; accountId: string }>;
        keyRecipients: Array<{ runId: string; recipientAccountId: string }> }>;
    close(): Promise<void>;
}

// Server's @/* aliases remain in its owner compiler, as in approvedOperation.composed.
const serverTestkitPath = '../../../../apps/server/sources/testkit/workflowSharedMachineServer.testkit';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    localConfiguration.paths = {};
});

it('settles a scheduled occurrence whose pre-save custody retired during reconnect before the late save committed', async () => {
    const f = await fixture();
    const { home, serverId } = await prepareDaemonHome(f);
    const attribution = { serverId, accountId: f.server.guest.accountId,
        machineId: f.machine.id, installationId: f.machine.installationId };
    const order: string[] = [];
    const actions = createCliWorkflowTriggerActions({ credentials: f.credentials, serverHttpBaseUrl: f.server.baseUrl,
        resolveWorkflow: async () => ({ definition: f.definition }),
        workflowRequesterCustody: {
            retain: async ({ scopeId, automationId }) => {
                if (!automationId) throw new Error('scheduled_custody_association_missing');
                const retained = await retainWorkflowRequesterCredentials({ happyHomeDir: home, scopeId, automationId,
                    credentials: f.credentials, attribution, homeServerIdentityId: f.server.homeId });
                await access(retained.path);
                order.push('custody-retained');
                expect(await runWithServerHttpBaseUrl(f.server.baseUrl, () => getAutomationDefinition({
                    token: f.credentials.token, automationId }))).toBeNull();
                await reconcileWorkflowRequesterCredentialScope({ ...attribution, happyHomeDir: home, scopeId,
                    homeServerIdentityId: f.server.homeId, serverHttpBaseUrl: f.server.baseUrl });
                await expect(access(retained.path)).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await listWorkflowRequesterCredentialScopes({ ...attribution, happyHomeDir: home }))
                    .toMatchObject({ status: 'ready', bindings: [] });
                order.push('reconnect-retired-custody');
            },
            retire: async () => { throw new Error('late_save_must_not_request_retirement'); },
        } });
    const saved = await actions.add({ target: { kind: 'inline', definition: f.definition },
        project: { machineId: f.machine.id, directory: f.directory }, trigger: { kind: 'schedule', enabled: true,
            schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } });
    order.push('late-save-committed');
    const automation = await runWithServerHttpBaseUrl(f.server.baseUrl, () => getAutomationDefinition({
        token: f.credentials.token, automationId: saved.set.automationId }));
    const schedule = automation?.triggers.find(trigger => trigger.id === saved.triggerId && trigger.kind === 'schedule');
    if (!schedule || schedule.kind !== 'schedule' || schedule.nextRunAt === null) throw new Error('saved_schedule_due_time_missing');
    const scheduleWorkerPath = '../../../../apps/server/sources/app/automations/automationScheduleWorker';
    const scheduler = await import(scheduleWorkerPath) as { runAutomationScheduleWorkerPass(input: { now: Date }): Promise<{ progressed: boolean }> };
    expect(await scheduler.runAutomationScheduleWorkerPass({ now: new Date(schedule.nextRunAt) })).toMatchObject({ progressed: true });
    const admitted = (await f.server.readEffects()).runs;
    expect(admitted).toEqual([expect.objectContaining({ accountId: f.server.guest.accountId, state: 'queued' })]);
    const runId = admitted[0]!.id;
    order.push('scheduled-occurrence-admitted');
    const requests: Array<{ path: string; body: unknown; response: unknown }> = [];
    const post = axios.post.bind(axios);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        const response = await post(url, body, config);
        requests.push({ path: new URL(String(url)).pathname, body, response: response.data });
        return response;
    });
    await runWithServerHttpBaseUrl(f.server.baseUrl, async () => {
        const worker = startAutomationWorker({ token: f.server.token, credentials: { token: f.server.token, encryption: null },
            machineId: f.machine.id, requesterHomeServerIdentityId: f.server.homeId,
            requesterWorkAttributionV1: { ...attribution, accountId: f.server.accountId },
            env: { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
        cleanups.push(async () => worker.stop());
        // Let the incumbent startup catch-up finish its empty custodian claim
        // before observing the later guest wake's network effects.
        await expect.poll(() => requests.find(request => request.path.endsWith('/runs/claim')))
            .toMatchObject({ response: { run: null } });
        requests.length = 0;
        const machine = new ApiMachineClient(f.server.token, { id: f.machine.id, encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: 'plain' });
        cleanups.push(() => machine.shutdown());
        const wakes: unknown[] = [];
        // Match daemon bootstrap: register the existing worker consumer before
        // connecting. With no local scope, only the server's signed-install
        // reconnect replay can deliver this missed private assignment.
        machine.onUpdate(update => {
            if (update.body.t !== 'automation-run-updated') return false;
            wakes.push(update.body);
            worker.handleServerUpdate(update);
            return true;
        });
        const firstConnectionAttempt = new Promise<{ phase: string; error: string | null }>(resolve => {
            machine.onConnectionStateChange(state => {
                if (state.phase === 'online' || state.phase === 'offline' || state.phase === 'auth_failed')
                    resolve({ phase: state.phase, error: state.lastErrorMessage });
            });
        });
        machine.connect();
        expect(await firstConnectionAttempt).toEqual({ phase: 'online', error: null });
        await expect.poll(async () => (await f.server.readEffects()).runs).toEqual([
            expect.objectContaining({ id: runId, state: 'failed', errorCode: 'requester_custody_unavailable' }),
        ]);
        await expect.poll(() => requests).toEqual([{ path: `/v3/automations/runs/${runId}/requester-custody-unavailable`,
            body: { machineId: f.machine.id }, response: { recorded: true } }]);
        expect(wakes).toContainEqual(expect.objectContaining({ runId, automationId: saved.set.automationId,
            requesterScope: { kind: 'workflow_trigger', id: saved.triggerId }, targetMachineId: f.machine.id }));
        worker.stop();
        await machine.shutdown();
    });
    expect(order).toEqual(['custody-retained', 'reconnect-retired-custody', 'late-save-committed', 'scheduled-occurrence-admitted']);
    expect(requests).toEqual([{ path: `/v3/automations/runs/${runId}/requester-custody-unavailable`,
        body: { machineId: f.machine.id }, response: { recorded: true } }]);
    expect(JSON.stringify(requests)).not.toContain('SHARED_MACHINE_PRIVATE_PROMPT');
    expect((await f.server.readEffects()).sessions).toEqual([]);
});

it('settles missing requester custody through the signed custodian endpoint without returning Run content', async () => {
    const f = await fixture();
    await f.admit();
    const initial = await f.server.readEffects();
    const runId = initial.runs[0]!.id;
    const responseBodies: unknown[] = [];
    const post = axios.post.bind(axios);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        const response = await post(url, body, config);
        if (String(url).endsWith('/requester-custody-unavailable')) responseBodies.push(response.data);
        return response;
    });
    await runWithServerHttpBaseUrl(f.server.baseUrl, async () => {
        const foreignInstallation = f.server.machines[1]!;
        const wrongPublisher = createAutomationClaimClient({ token: f.server.token,
            createPublisherHeader: async ({ path, body }) => f.server.publisherHeader({ machineId: foreignInstallation.id, path, body }) });
        await expect(wrongPublisher.reportRequesterCustodyUnavailable({ machineId: f.machine.id, runId }))
            .rejects.toMatchObject({ response: { status: 401, data: null } });
        expect((await f.server.readEffects()).runs).toEqual(initial.runs);
        const client = createAutomationClaimClient({ token: f.server.token,
            createPublisherHeader: async ({ path, body }) => f.server.publisherHeader({ machineId: f.machine.id, path, body }) });
        await client.reportRequesterCustodyUnavailable({ machineId: f.machine.id, runId });
    });
    expect(responseBodies).toHaveLength(1);
    expect(JSON.stringify(responseBodies)).not.toContain('SHARED_MACHINE_PRIVATE_PROMPT');
    expect(responseBodies[0]).not.toHaveProperty('acceptedEnvelope');
    expect(responseBodies[0]).not.toHaveProperty('keyCensus');
    const effects = await f.server.readEffects();
    expect(effects.runs).toEqual([expect.objectContaining({ id: runId, accountId: f.server.guest.accountId,
        state: 'failed', errorCode: 'requester_custody_unavailable' })]);
    expect(effects.sessions).toEqual([]);
    const outsider = createWorkflowRunStorageClient({ token: f.server.token, serverHttpBaseUrl: f.server.baseUrl });
    await expect(outsider.execute({ operation: 'get', runId })).rejects.toMatchObject({ response: { status: 404 } });
});

it('keeps encrypted requester content and recipient keys private in both Account directions', async () => {
    const f = await fixture('e2ee');
    await f.admit();
    const effects = await f.server.readEffects();
    const runId = effects.runs[0]!.id;
    expect(effects.keyRecipients).toEqual([{ runId, recipientAccountId: f.server.guest.accountId }]);
    const stored = await f.storage.execute({ operation: 'get', runId });
    if (!stored || typeof stored !== 'object' || !('acceptedEnvelope' in stored) || !('keyCensus' in stored))
        throw new Error('guest_run_snapshot_unavailable');
    const envelope = parseWorkflowStoredContentEnvelopeV1(stored.acceptedEnvelope);
    if (!envelope) throw new Error('guest_run_snapshot_envelope_invalid');
    expect(envelope.t).toBe('encrypted');
    expect(JSON.stringify(stored)).not.toContain('SHARED_MACHINE_PRIVATE_PROMPT');
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse(stored.keyCensus);
    const openedKey = resolveWorkflowRunDataKeyV1({ encryption: f.encryption, census });
    expect(openedKey.kind).toBe('available');
    if (openedKey.kind !== 'available') throw new Error('guest_run_key_unavailable');
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...openedKey.encryption.runCrypto,
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: f.server.guest.accountId, runId }, envelope });
    expect(opened.kind).toBe('available');
    expect(JSON.stringify(opened)).toContain('SHARED_MACHINE_PRIVATE_PROMPT');
    const unrelatedKey = tweetnacl.box.keyPair();
    const unrelatedMaterial = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'dataKey', machineKey: unrelatedKey.secretKey }, dataKeyPublicKey: unrelatedKey.publicKey });
    expect(resolveWorkflowRunDataKeyV1({ encryption: { witness: { mode: 'e2ee' }, material: unrelatedMaterial }, census }))
        .toEqual({ kind: 'unavailable', reason: 'waiting_for_keys' });
    for (const token of [f.server.token, f.server.foreign.token]) {
        const outsider = createWorkflowRunStorageClient({ token, serverHttpBaseUrl: f.server.baseUrl });
        await expect(outsider.execute({ operation: 'get', runId })).rejects.toMatchObject({ response: { status: 404 } });
    }
    await f.admitCustodian();
    const custodianRun = (await f.server.readEffects()).runs.find(run => run.accountId === f.server.accountId);
    expect(custodianRun).toBeDefined();
    await expect(f.storage.execute({ operation: 'get', runId: custodianRun!.id }))
        .rejects.toMatchObject({ response: { status: 404 } });
    const ownRun = await f.custodianStorage.execute({ operation: 'get', runId: custodianRun!.id });
    expect(ownRun).toMatchObject({ run: { id: custodianRun!.id } });
    const guestList = await f.storage.execute({ operation: 'list', request: WorkflowRunListRequestV1Schema.parse({}),
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
    expect(JSON.stringify(guestList)).toContain(runId);
    expect(JSON.stringify(guestList)).not.toContain(custodianRun!.id);
});

async function fixture(mode: 'plain' | 'e2ee' = 'plain') {
    const keys = mode === 'e2ee' ? tweetnacl.box.keyPair() : null;
    const module = await import(serverTestkitPath) as { startWorkflowSharedMachineServer(input?: { contentPublicKey?: Uint8Array }): Promise<SharedServer> };
    const server = await module.startWorkflowSharedMachineServer(keys ? { contentPublicKey: keys.publicKey } : {});
    cleanups.push(() => server.close());
    const directory = await mkdtemp(join(tmpdir(), 'workflow-shared-machine-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const machine = server.machines[0]!;
    const credentials: StoredCredentials = { token: server.guest.token, encryption: keys
        ? { type: 'dataKey', publicKey: keys.publicKey, machineKey: keys.secretKey } : null };
    const encryption = await runWithServerHttpBaseUrl(server.baseUrl, () => resolveAutomationWorkerAccountEncryption({
        token: credentials.token, credentials }));
    if (encryption.kind !== 'available') throw new Error('guest_account_encryption_unavailable');
    const storage = createWorkflowRunStorageClient({ token: credentials.token, machineId: machine.id,
        serverHttpBaseUrl: server.baseUrl,
        createPublisherHeader: async ({ path, body }) => server.publisherHeader({ machineId: machine.id, path, body }) });
    const definition = { version: 1, inputs: [], defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'native' },
            'happier.agent.claude/anthropic': { source: 'native' },
        } },
    }, blocks: [{ kind: 'step', id: 'private-step', document: {
        text: 'SHARED_MACHINE_PRIVATE_PROMPT', references: [], attachments: [],
    }, input: [], result: { kind: 'text' } }],
    finalOutput: { kind: 'result', producer: { blockId: 'private-step', scope: { kind: 'current' } }, path: [] } } satisfies WorkflowDefinitionV1;
    const makeOwner = (accountId: string, selectedStorage: typeof storage, selectedEncryption: AvailableAutomationAccountEncryptionV1,
        workflowRequesterCustody?: Parameters<typeof createWorkflowRunActionOwner>[0]['workflowRequesterCustody']) => createWorkflowRunActionOwner({ resolveAccountId: async () => accountId, storage: selectedStorage,
        ...(workflowRequesterCustody ? { workflowRequesterCustody } : {}),
        definitions: createWorkflowDefinitionActions({ encodeListCursor: () => { throw new Error('inline_workflow_has_no_saved_source'); }, artifactStore: {
            read: async () => { throw new Error('inline_workflow_has_no_saved_source'); },
            list: async () => { throw new Error('inline_workflow_has_no_saved_source'); },
            create: async () => { throw new Error('inline_workflow_has_no_saved_source'); },
            update: async () => { throw new Error('inline_workflow_has_no_saved_source'); },
            delete: async () => { throw new Error('inline_workflow_has_no_saved_source'); },
        } }),
        resolveEncryption: async () => selectedEncryption,
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: {
            project: { machineId: machine.id, directory, checkoutRootPath: directory },
        } }),
    });
    const owner = makeOwner(server.guest.accountId, storage, encryption);
    const custodianStorage = createWorkflowRunStorageClient({ token: server.token, machineId: machine.id,
        serverHttpBaseUrl: server.baseUrl,
        createPublisherHeader: async ({ path, body }) => server.publisherHeader({ machineId: machine.id, path, body }) });
    const custodianEncryption = await runWithServerHttpBaseUrl(server.baseUrl, () => resolveAutomationWorkerAccountEncryption({
        token: server.token, credentials: { token: server.token, encryption: null } }));
    if (custodianEncryption.kind !== 'available') throw new Error('custodian_account_encryption_unavailable');
    const custodianOwner = makeOwner(server.accountId, custodianStorage, custodianEncryption);
    const admitWith = (selectedOwner: typeof owner) => runWithServerHttpBaseUrl(server.baseUrl, () => selectedOwner.execute({ actionId: 'workflow.run.start', input: {
        runId: randomUUID(), source: { kind: 'inline', definition },
    }, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        callerPermissionMode: 'safe-yolo', externalActionTarget: { kind: 'machine', machineId: machine.id,
            project: { machineId: machine.id, directory } } } }));
    return { server, machine, directory, credentials, storage, encryption, definition,
        admit: () => admitWith(owner), admitCustodian: () => admitWith(custodianOwner), custodianStorage,
        admitRetainingRequester: ({ home, serverId }: { home: string; serverId: string }) => admitWith(makeOwner(
            server.guest.accountId, storage, encryption, createWorkflowRequesterCustody({ credentials, happyHomeDir: home,
                serverHttpBaseUrl: server.baseUrl, homeServerIdentityId: server.homeId,
                attribution: { serverId, accountId: server.guest.accountId, machineId: machine.id, installationId: machine.installationId } }))),
    };
}

async function prepareDaemonHome(f: Pick<Awaited<ReturnType<typeof fixture>>, 'directory' | 'machine'>) {
    const home = join(f.directory, 'daemon-home');
    await mkdir(home, { recursive: true });
    const serverId = 'shared-machine-composed';
    localConfiguration.paths = { happyHomeDir: home, activeServerId: serverId,
        settingsFile: join(home, 'settings.json'), installationIdentityFile: join(home, 'installation.json'),
        privateKeyFile: join(home, 'credentials.json'), legacyPrivateKeyFile: join(home, 'legacy-credentials.json'),
        activeServerDir: home, serversDir: home, deviceLocalSecretKeyFile: join(home, 'device-secret') };
    await writeFile(localConfiguration.paths.settingsFile!, JSON.stringify({ schemaVersion: 6,
        machineIdByServerId: { [serverId]: f.machine.id } }), { mode: 0o600 });
    await writeFile(localConfiguration.paths.installationIdentityFile!, JSON.stringify({ version: 1,
        installationId: f.machine.installationId, createdAt: Date.now(),
        publicKey: Buffer.from(f.machine.keys.publicKey).toString('base64url'),
        privateKey: Buffer.from(f.machine.keys.secretKey).toString('base64url') }), { mode: 0o600 });
    return { home, serverId };
}

it('runs a guest private Session on a shared Machine; revocation stops the next admission and not admitted work', async () => {
    const f = await fixture();
    const daemon = await prepareDaemonHome(f);
    const admitted = await f.admitRetainingRequester(daemon);
    expect(admitted).toMatchObject({ admission: 'created' });
    const runId = (await f.server.readEffects()).runs[0]!.id;
    expect(await listWorkflowRequesterCredentialScopes({ happyHomeDir: daemon.home, serverId: daemon.serverId,
        machineId: f.machine.id, installationId: f.machine.installationId }))
        .toMatchObject({ status: 'ready', bindings: [expect.objectContaining({ sessionId: runId,
            attribution: expect.objectContaining({ accountId: f.server.guest.accountId }) })] });
    for (const token of [f.server.token, f.server.foreign.token]) {
        const outsider = createWorkflowRunStorageClient({ token, serverHttpBaseUrl: f.server.baseUrl });
        await expect(outsider.execute({ operation: 'get', runId })).rejects.toMatchObject({ response: { status: 404 } });
        const listed = await outsider.execute({ operation: 'list', request: WorkflowRunListRequestV1Schema.parse({}),
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        expect(JSON.stringify(listed)).not.toContain(runId);
    }
    const wrongMachine = f.server.machines[1]!;
    const sibling = createWorkflowRunStorageClient({ token: f.credentials.token, machineId: wrongMachine.id,
        serverHttpBaseUrl: f.server.baseUrl,
        createPublisherHeader: async ({ path, body }) => f.server.publisherHeader({ machineId: wrongMachine.id, path, body }) });
    const assertSiblingCannotInitialize = async (claim: { attempt: number; expectedRevision: number }) => {
        const rootId = randomUUID();
        await expect(sibling.execute({ operation: 'initialize', runId, parentAttempt: claim.attempt,
            expectedRevision: claim.expectedRevision, accountCurrentness: f.server.guest.currentness,
            checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'checkpoint', accountId: f.server.guest.accountId, runId },
                checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
                    nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } } })),
            rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'invocation_progress', accountId: f.server.guest.accountId, runId,
                    recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
                progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
                    blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } })) },
        })).rejects.toMatchObject({ response: { status: 401 } });
    };

    const transcripts: TranscriptMessageLookupResult[] = [];
    const turns: SessionTurnV1[] = [];
    const prompts: string[] = [];
    let childId = '';
    let executionCredentials: StoredCredentials | undefined;
    let nativeSession: ReturnType<ApiClient['sessionSyncClient']> | undefined;
    const boundaries = { nativeLaunches: 0, trackedOpenStatus: null as string | null,
        publisherClaimStatus: null as string | null,
        startupStates: [] as string[], startupErrorCodes: [] as string[], startupCompleted: false,
        transcriptLookups: 0, turnProjectionReads: 0,
        sessionActive: null as boolean | null, sessionAgentStatePresent: false };
    onTestFailed(() => console.info('Workflow Session boundary diagnostics', { ...boundaries,
        childCreated: childId.length > 0, promptCount: prompts.length, turnCount: turns.length,
        transcriptCount: transcripts.length }));
    // Provider transcript/turn delivery is the network boundary. Session creation,
    // requester ownership, admission, storage, and the exact-input observer stay real.
    const get = axios.get.bind(axios);
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        const parsed = new URL(String(url));
        if (childId && parsed.pathname === `/v1/sessions/${childId}/turns`) {
            boundaries.turnProjectionReads += 1;
            return { status: 200,
                data: SessionTurnsProjectionV1Schema.parse(buildSessionTurnsProjectionV1({ sessionId: childId, updatedAt: Date.now(), turns })) };
        }
        if (childId && parsed.pathname === `/v1/sessions/${childId}/messages`) return { status: 200,
            data: { hasMore: false, messages: transcripts.filter(row => row.seq > Number(parsed.searchParams.get('afterSeq') ?? 0)) } };
        const response = await get(url, config);
        if (childId && parsed.pathname.includes(`/v2/sessions/${childId}/messages/by-local-id/`) && !parsed.pathname.endsWith('/reply')) {
            boundaries.transcriptLookups += 1;
        }
        if (childId && parsed.pathname === `/v2/sessions/${childId}`) {
            const session = response.data?.session;
            boundaries.sessionActive = typeof session?.active === 'boolean' ? session.active : null;
            boundaries.sessionAgentStatePresent = session?.agentState != null;
        }
        return response;
    });
    const operations = createHostActionOperationRuntime({ machineId: f.machine.id,
        custodyBinding: { serverId: daemon.serverId, installationId: f.machine.installationId },
        resolveAccountId: async () => f.server.custodianAccountId });
    const operationReceiver = new RpcHandlerManager({ scopePrefix: f.machine.id, encryptionMode: 'plain', logger: () => {} });
    registerActionOperationRpcHandlers(operationReceiver, operations.handlers);
    const spawnHandler = createMachineSessionSpawnRpcHandler({ serverId: daemon.serverId, handlers: {
        stopSession: async () => ({ status: 'stopped' }),
        // Native runner launch is the OS boundary. Commit its actual row through
        // the ordinary API with the selected requester's credentials.
        spawnSession: async options => {
            boundaries.nativeLaunches += 1;
            if (!executionCredentials) throw new Error('worker_requester_credentials_missing');
            const metadata = buildCommittedLaunchMetadata({ options, directory: f.directory, accountSettings: {} });
            const api = await ApiClient.create(executionCredentials);
            api.setLocalMachineId(f.machine.id);
            const created = await api.getOrCreateSession({ tag: options.sessionCreationTag ?? randomUUID(),
                metadata: createTestMetadata({ ...metadata, machineId: f.machine.id,
                    path: f.directory, permissionMode: 'default', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
                state: null, originKind: 'run_step', originRunId: runId, workDepth: 1 });
            if (!created) throw new Error('native_session_row_unavailable');
            childId = created.id;
            // The native runner publishes presence before reporting its Session
            // open. Use its real Session client and acknowledged publisher claim.
            const runnerSession = api.sessionSyncClient(created, {
                initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                    sessionId: childId, agentRuntimeApplicability: 'supported',
                })],
                durableMutationDeliveryInitiallyActive: false,
            });
            cleanups.push(() => runnerSession.close());
            const publisherClaim = await runnerSession.claimCurrentSessionPublisherAuthorityForStartup();
            boundaries.publisherClaimStatus = publisherClaim.status;
            expect(publisherClaim).toEqual({ status: 'claimed' });
            await runnerSession.refreshSessionSnapshotFromServerRequired({ reason: 'startup-drain' });
            await runnerSession.activateDurableMutationDelivery();
            nativeSession = runnerSession;
            return { type: 'success', sessionId: childId, sessionCreationOutcome: {
                disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
            } };
        },
    }, awaitAgentSessionOpen: async input => {
        const result = await awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => [{
            pid: 101, startedBy: 'daemon', happySessionId: childId,
            agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json',
            agentRuntimeDaemonServiceSessionOpenAttestation: { request: { kind: 'create', sessionId: childId, cwd: f.directory }, providerSessionId: 'native' },
        }] });
        boundaries.trackedOpenStatus = result.status;
        return result;
    } });
    const machine = new ApiMachineClient(f.server.token, { id: f.machine.id, encryptionMode: 'plain', metadata: null,
        metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: 'plain' });
    cleanups.push(() => machine.shutdown());
    Reflect.set(machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
        if (event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1) throw new Error(`unexpected_provider_event:${event}`);
        const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(payload);
        if (request.content.t !== 'plain') throw new Error('unexpected_encrypted_input');
        const record = request.content.v;
        if (!record || typeof record !== 'object' || Array.isArray(record) || !('content' in record)
            || !record.content || typeof record.content !== 'object' || Array.isArray(record.content)
            || !('text' in record.content) || typeof record.content.text !== 'string') throw new Error('missing_provider_prompt');
        if (!nativeSession || !executionCredentials) throw new Error('native_session_publisher_missing');
        prompts.push(record.content.text);
        const meta = 'meta' in record && record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)
            ? record.meta : undefined;
        // Native transcript observation retains the admitted Workflow metadata;
        // its external observation source does not replace input provenance.
        expect(await nativeSession.enqueueUserTextMessageCommitted(record.content.text, { localId: request.localId,
            ...(meta ? { meta } : {}), provenance: { kind: 'non_dependent', source: 'external' },
            admission: { signal: new AbortController().signal, requireDelivery: true },
        })).toMatchObject({ delivered: true });
        const original = await findTranscriptEncryptedMessageByLocalIdV2({ token: executionCredentials.token,
            serverUrl: f.server.baseUrl, sessionId: childId, localId: request.localId });
        expect(original).toMatchObject({ type: 'found' });
        if (original.type !== 'found') throw new Error('native_original_input_unavailable');
        expect(original.message.content).toMatchObject(request.content);
        expect(await readSessionMessageReply({ credentials: executionCredentials, sessionId: childId, localId: request.localId }))
            .toEqual({ v: 1, status: 'none' });
        const now = Date.now();
        const userSeq = original.message.seq;
        const assistantSeq = userSeq + 1;
        transcripts.push(original.message);
        transcripts.push({ id: 'assistant-message', seq: assistantSeq, localId: null, sidechainId: null, createdAt: now + 1, updatedAt: now + 1,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: {
                role: 'assistant', content: [{ type: 'text', text: 'SHARED_MACHINE_PRIVATE_RESULT' }], stop_reason: 'end_turn',
            } } } } } });
        turns.push({ turnId: 'provider-turn', status: 'completed', startedAt: now, updatedAt: now + 1, terminalAt: now + 1,
            transcriptAnchors: { startUserMessageSeq: userSeq, userMessageSeqs: [userSeq], finalAssistantMessageSeq: assistantSeq, endSeqInclusive: assistantSeq } });
        return SessionPendingEnqueueByMachineResponseV1Schema.parse({ v: 1, result: { status: 'accepted', localId: request.localId } });
    } }));
    const coordinateForRequester = (requester: { credentials: StoredCredentials; attribution: RequesterWorkAttributionV1 }) => {
        const requesterTransport = createWorkflowRunMachineTransport({ runId, credentials: requester.credentials,
            requesterWorkAttributionV1: requester.attribution,
            boundary: { serverId: daemon.serverId, serverHttpBaseUrl: f.server.baseUrl, happyHomeDir: daemon.home,
                getObservedServerIdentityId: () => f.server.homeId }, isCurrent: async () => true,
            transport: { machineId: f.machine.id, invoke: (method, input, options) => operationReceiver.invokeLocal(method, input, options) } });
        cleanups.push(() => requesterTransport.dispose());
        return createProductionWorkflowRunCoordinator({ token: requester.credentials.token, accountId: requester.attribution.accountId,
        requesterWorkAttributionV1: requester.attribution,
        machineId: f.machine.id, storage: createWorkflowRunStorageClient({ token: requester.credentials.token,
            machineId: f.machine.id, serverHttpBaseUrl: f.server.baseUrl,
            createPublisherHeader: async ({ path, body }) => f.server.publisherHeader({ machineId: f.machine.id, path, body }) }),
        resolveAccountEncryption: async () => {
            const current = await resolveAutomationWorkerAccountEncryption({ token: requester.credentials.token,
                credentials: requester.credentials });
            if (current.kind !== 'available') throw new Error('worker_requester_encryption_unavailable');
            return current;
        },
        isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId: requester.attribution.accountId,
            listAccountApiTokens: async () => { throw new Error('host_principal_has_no_api_token'); }, resolveCurrentPluginOccurrenceId: async () => null,
            resolveCurrentPluginSourceCustody: async () => null, isMediatedSourceCurrent: async () => false }),
        resolveControllerContext: async () => ({ surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            callerPermissionMode: 'safe-yolo', serverId: requester.attribution.serverId, serverIdentityId: f.server.homeId,
            runtimeAccountId: requester.attribution.accountId }),
        execution: { credentials: requester.credentials, serverId: requester.attribution.serverId, serverIdentityId: f.server.homeId,
            resolveExistingSessionConversation: input => resolveWorkflowSessionConversation({ ...input, credentials: requester.credentials }),
            sessionStartup: async input => {
                const prepared = await prepareWorkflowSessionRequester({ credentials: requester.credentials, attribution: requester.attribution,
                    machineAdmission: { actorAccountId: requester.attribution.accountId, custodianAccountId: f.server.custodianAccountId },
                    boundary: { serverId: daemon.serverId, serverHttpBaseUrl: f.server.baseUrl, happyHomeDir: daemon.home,
                        getObservedServerIdentityId: () => f.server.homeId }, verifyMachineAdmissionCurrent: async () => true });
                if (!prepared) throw new Error('workflow_session_requester_unavailable');
                const result = await runObservedWorkflowSessionStartup({ ...input, onObservation: async operation => {
                    boundaries.startupStates.push(operation.state);
                    if (operation.error?.errorCode) boundaries.startupErrorCodes.push(operation.error.errorCode);
                    await input.onObservation?.(operation);
                } }, {
                serverId: daemon.serverId, machineId: f.machine.id, observeExecution: operations.observeExecution,
                rpcContext: { requesterSessionBootstrap: prepared.admitted },
                transport: operation => ({ spawn: (request, options) => spawnHandler(request, { ...options,
                    localActionContext: operation, requesterSessionBootstrap: prepared.admitted }),
                    resolveSpawnSessionByNonce: async () => { throw new Error('unexpected_replacement_startup'); } }),
                observeOperation: (target, options) => requesterTransport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V2.get,
                    { operationId: target.operationId, ...(options.waitForTerminal ? { waitForTerminal: true } : {}) },
                    options.signal ? { signal: options.signal } : undefined),
                cancelOperation: async target => requesterTransport.transport.invoke(ACTION_OPERATION_RPC_METHODS_V1.cancel,
                    { operationId: target.operationId }),
                cleanupOnFailure: prepared.cleanupOnFailure,
                });
                boundaries.startupCompleted = true;
                return result;
            },
            machineAdmissionTransport: (request, options) => machine.enqueueSessionPendingByMachine(request, options),
            detachedRun: { actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()),
                buildActionContext: async () => ({ surface: 'cli', authority: 'present_user' }) },
        }, workspaceScm: createGitWorkflowWorkspaceTestDependencies(),
        prepareAcceptedWorkspaceTarget: async () => ({ ok: true, workspaceTarget: { project: {
            machineId: f.machine.id, directory: f.directory, checkoutRootPath: f.directory,
        } } }), onCommittedTransition: async () => {}, onReviewEntered: async () => {},
    });
    };
    type Outcome = Awaited<ReturnType<ReturnType<typeof createProductionWorkflowRunCoordinator>>>;
    let complete!: (result: Outcome) => void;
    let fail!: (error: unknown) => void;
    const completion = new Promise<Outcome>((resolve, reject) => { complete = resolve; fail = reject; });
    await runWithServerHttpBaseUrl(f.server.baseUrl, async () => {
        const worker = startAutomationWorker({ token: f.server.token, credentials: { token: f.server.token, encryption: null },
            machineId: f.machine.id, requesterHomeServerIdentityId: f.server.homeId,
            requesterWorkAttributionV1: { serverId: daemon.serverId, accountId: f.server.accountId,
                machineId: f.machine.id, installationId: f.machine.installationId },
            env: { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' },
            coordinateWorkflowRun: async (claim, requester) => {
                try {
                    if (!requester) throw new Error('worker_requester_custody_missing');
                    expect(requester.attribution.accountId).toBe(f.server.guest.accountId);
                    expect(requester.credentials.token === f.credentials.token).toBe(true);
                    executionCredentials = requester.credentials;
                    await assertSiblingCannotInitialize(claim);
                    await f.server.revokeGuest(f.machine.id);
                    await expect(f.admit()).rejects.toMatchObject({ code: 'target_unavailable', response: { status: 422 } });
                    const result = await coordinateForRequester(requester)(claim);
                    complete(result);
                    return result;
                } catch (error) { fail(error); throw error; }
        } });
        cleanups.push(async () => worker.stop());
        expect(await completion).toMatchObject({ state: 'succeeded', finalOutput: 'SHARED_MACHINE_PRIVATE_RESULT',
            finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'SHARED_MACHINE_PRIVATE_RESULT' } } });
        worker.stop();
    });
    expect(prompts).toEqual([expect.stringContaining('SHARED_MACHINE_PRIVATE_PROMPT')]);
    const stored = await f.storage.execute({ operation: 'get', runId });
    expect(stored).toMatchObject({ run: { state: 'succeeded' } });
    expect(JSON.stringify(stored)).toContain('SHARED_MACHINE_PRIVATE_RESULT');
    const effects = await f.server.readEffects();
    expect(effects.sessions).toEqual([{ id: childId, accountId: f.server.guest.accountId }]);
    expect(effects.runs).toEqual([expect.objectContaining({ id: runId, accountId: f.server.guest.accountId, state: 'succeeded' })]);
    expect(effects.keyRecipients.every(row => row.recipientAccountId === f.server.guest.accountId)).toBe(true);
    for (const token of [f.server.token, f.server.foreign.token]) {
        await expect(axios.get(`${f.server.baseUrl}/v2/sessions/${childId}`, { headers: { Authorization: `Bearer ${token}` } }))
            .rejects.toMatchObject({ response: { status: 404 } });
    }
});
