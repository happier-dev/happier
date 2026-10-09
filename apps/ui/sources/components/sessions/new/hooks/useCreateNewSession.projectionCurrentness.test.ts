import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema, type AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createNewSessionPromptStore } from './screenModel/newSessionPromptStore';
import { AccountProfileSchema, MACHINE_PLAIN_DATA_KEY_MARKER, PluginProjectionV2Schema, SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { useCreateNewSession } from './useCreateNewSession';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import type { NewSessionLaunchAttempt } from '../modules/newSessionLaunchAttempt';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';

// Static owner imports can reach Socket.IO before runtime setup; replace only its external transport.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const identity = { pluginId: 'acme.review', localId: 'provider' } as const;
const agentId = 'acme.review/provider';
const agentTarget = { kind: 'agent', identity } as const;
const connectedAccountDeclaration = { purpose: 'model-api', service: { pluginId: 'acme.review', localId: 'auth' } } as const;
const spawnTarget = { kind: 'backend', backendId: agentId } as const;
const spawnRequests: SessionSpawnNewInputV2[] = [];
const projectionBoundaryRequests: string[] = [];
const purposeInitializationRequests: ConnectedAccountCatalogRowMutationV1[] = [];
const savedSecretImportRequests: string[] = [];
let retainedPurposeDefaults: Record<string, unknown> | null = null;
let initializedPurposeContent: ConnectedAccountCatalogRowMutationV1['content'] | null = null;
let purposeRowReadGate: ReturnType<typeof createDeferred<void>> | null = null;
let purposeRowReadCount = 0;
let spawnResult: ReturnType<typeof createDeferred<SessionSpawnNewResultV1>>;
let authoringHttp: ReturnType<typeof createAuthoringMemoryHttpBoundary>;
let instructionsArtifacts: ReturnType<typeof createArtifactStoreBoundary>;
let instructionsCreateUnavailable = false;
let restoreActionExecutorModuleLoader: (() => void) | undefined;
let managedMachine: ManagedMachineV1 | null = null;
let managedOperationSettled = false;
let managedOperationWait: Promise<void> | null = null;
let managedDeleteSettings: ReturnType<typeof ActionsSettingsV1Schema.parse> | null = null;
const managedDeleteRequests: Array<{ actionId: string; target: unknown; input: unknown }> = [];
let observeFreshManagedAcquire = false;
const managedAcquireRequests: unknown[] = [];
const scopeRules = new Map<string, AutomationDefinitionDetail>();

beforeEach(async () => {
    spawnRequests.length = 0;
    projectionBoundaryRequests.length = 0;
    purposeInitializationRequests.length = 0;
    savedSecretImportRequests.length = 0;
    retainedPurposeDefaults = null;
    initializedPurposeContent = null;
    purposeRowReadGate = null;
    purposeRowReadCount = 0;
    managedMachine = null;
    managedOperationSettled = false;
    managedOperationWait = null;
    managedDeleteSettings = null;
    managedDeleteRequests.length = 0;
    observeFreshManagedAcquire = false;
    managedAcquireRequests.length = 0;
    scopeRules.clear();
    spawnResult = createDeferred<SessionSpawnNewResultV1>();
    authoringHttp = createAuthoringMemoryHttpBoundary();
    instructionsArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    instructionsCreateUnavailable = false;
    restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
    restoreActionExecutorModuleLoader?.();
    (await import('@/sync/domains/actionOperations/actionOperationStore')).actionOperationStore.reset();
});
installNewSessionScreenModelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'created-session',
    credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', tokenEpoch: 0,
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
    })).toString('base64url')}.signature` },
    accountCurrentness: () => createPlainAccountEncryptionCurrentnessFixture(retainedPurposeDefaults ? { settingsVersion: 1 } : {}),
    request: async (url, init) => {
        const requestUrl = new URL(String(url));
        if (observeFreshManagedAcquire && requestUrl.pathname === '/v1/machines') {
            return Response.json([{ ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account-a' }),
                installationId: 'installation' }]);
        }
        if (observeFreshManagedAcquire && requestUrl.pathname === '/v1/actions/machines.managed.acquire') {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            managedAcquireRequests.push(envelope.input);
            return Response.json({ v: 1, actionId: 'machines.managed.acquire', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'policy_denied_field', error: 'policy_denied_field' } });
        }
        if (retainedPurposeDefaults) {
            if (requestUrl.pathname === '/v1/account/saved-secrets/resources/materials') {
                savedSecretImportRequests.push(requestUrl.pathname);
                return Response.json({ resources: [] });
            }
            if (requestUrl.pathname === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (requestUrl.pathname === '/v2/account/settings/history') {
                savedSecretImportRequests.push(requestUrl.pathname);
                return Response.json({ snapshots: [] });
            }
        }
        if (requestUrl.pathname === '/v3/automations') {
            if ((init?.method ?? 'GET') === 'GET') return Response.json({ automations: [...scopeRules.values()].map(({ executionRecipe: _private, ...row }) => ({
                ...row, triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger),
            })), nextCursor: null });
            const input = AutomationDefinitionCreateRequestSchema.parse(JSON.parse(String(init?.body)));
            const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name, description: input.description ?? null,
                enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, createdAt: 1, updatedAt: 1, lastRunAt: null,
                workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null, executionRecipe: input.executionRecipe,
                assignments: (input.assignments ?? []).map(value => ({ ...value, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
                triggers: input.triggers.map(value => ({ ...value.trigger, id: value.triggerId, revision: 0, createdAt: 1, updatedAt: 1,
                    remainingOccurrences: null, status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null })) });
            scopeRules.set(row.id, row);
            return Response.json(row);
        }
        if (instructionsCreateUnavailable && requestUrl.pathname === '/v1/artifacts' && init?.method === 'POST') {
            return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        const artifactResponse = instructionsArtifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init);
        if (artifactResponse) return await artifactResponse;
        if (managedMachine && new URL(String(url)).pathname === managedMachineActionEndpointPathV1('machines.managed.get')) {
            return Response.json(managedMachine);
        }
        if (managedMachine && ['/v1/actions/machines.managed.references.get', '/v1/actions/machines.managed.delete'].includes(requestUrl.pathname)) {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const actionId = requestUrl.pathname.slice('/v1/actions/'.length);
            managedDeleteRequests.push({ actionId, target: envelope.target, input: envelope.input });
            const census = { homeId: managedMachine.homeId, machineId: managedMachine.enrolledMachineId ?? null,
                coverage: 'complete', references: [], unavailable: [] };
            return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true,
                result: actionId === 'machines.managed.references.get' ? census : { kind: 'accepted',
                    managedId: managedMachine.id, intentRevision: managedMachine.intentRevision + 1,
                    operation: { operationId: 'delete' }, machineReferences: census } } });
        }
        if (new URL(String(url)).pathname === '/v2/account/settings') {
            if (managedDeleteSettings) return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: managedDeleteSettings } }, version: 1 });
            if (retainedPurposeDefaults) return Response.json({ content: { t: 'plain', v: retainedPurposeDefaults }, version: 1 });
            return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        }
        if (requestUrl.pathname === '/v1/account/entity-rows/connected-accounts/purposes') {
            if (retainedPurposeDefaults) {
                if (init?.method === 'POST') {
                    const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    purposeInitializationRequests.push(mutation);
                    initializedPurposeContent = mutation.content;
                    return Response.json({ status: 'updated', revision: 1, cursor: 1 });
                }
                purposeRowReadCount += 1;
                await purposeRowReadGate?.promise;
                return Response.json(initializedPurposeContent
                    ? { status: 'present', revision: 1, content: initializedPurposeContent } : { status: 'absent' });
            }
            return Response.json({ status: 'present', revision: 1,
                content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } });
        }
        const machineRead = /^\/v1\/machines\/(m1|controller)$/.exec(new URL(String(url)).pathname);
        if (machineRead) {
            return Response.json({ machine: { id: machineRead[1], dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        }
        const machineAccessRead = /^\/v1\/machines\/(m1|controller)\/access$/.exec(new URL(String(url)).pathname);
        if (machineAccessRead) {
            const custodian = machineAccessRead[1] === 'controller' && managedMachine
                ? { accountId: managedMachine.custodianAccountId, displayName: 'Controller owner' }
                : { accountId: 'account-a', displayName: 'Account A' };
            return Response.json({ machineId: machineAccessRead[1], custodian,
                access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
            });
        }
        return await authoringHttp.handle(url, init);
    },
    configureSocket: (socket) => {
        socket.connected = true;
        // Socket is the transport boundary; presence cleanup cannot write to a real unconnected engine.
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) {
                throw new Error('Malformed daemon RPC');
            }
            const method = payload.method.slice(payload.method.indexOf(':') + 1);
            projectionBoundaryRequests.push(method);
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get && managedMachine) {
                await managedOperationWait;
                const state = managedOperationSettled ? 'succeeded' : 'running';
                if (managedOperationSettled) managedMachine = { ...managedMachine, enrolledMachineId: 'm1' };
                return { ok: true, result: { kind: 'found', operation: {
                    version: 1, operationId: 'bot-install', revision: managedOperationSettled ? 2 : 1,
                    actionId: 'machines.managed.acquire', state,
                    scope: { accountId: 'account-a', machineId: 'controller' }, title: 'Install',
                    createdAt: 1, startedAt: 1, cancellation: 'supported',
                    ...(managedOperationSettled ? { settledAt: 2 } : {}),
                } } };
            }
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: true, result: {
                    protocolVersion: 1,
                    projection: PluginProjectionV2Schema.parse({
                        v: 2, generation: 7, agentsById: {
                            [agentId]: { id: agentId, identity, title: 'Acme Review Provider', connectedAccounts: [connectedAccountDeclaration] },
                            codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, isBuiltIn: true,
                                connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }] },
                        },
                        installedPackagesById: {}, actionsById: {}, toolsById: {}, commandsById: {},
                        resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
                    }),
                } };
            }
            if (method === RPC_METHODS.SESSION_SPAWN_NEW) {
                spawnRequests.push(SessionSpawnNewInputV2Schema.parse(payload.params));
                return { ok: true, result: await spawnResult.promise };
            }
            return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
    },
});

async function readCurrentProjection() {
    const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs,
        readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.setState({ profileScope: { serverId: runtime.serverId, accountId: 'account-a' },
        profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: runtime.serverId });
    clearDaemonMergedProjectionCacheForTests();
    const inputs = await loadDaemonMergedProjectionInputs({
        machineId: 'm1', serverId: runtime.serverId,
        accountLifetime: captureActiveServerAccountScopeLifetime(),
    });
    const entry = readCachedDaemonMergedProjectionCacheEntry({ machineId: 'm1', serverId: runtime.serverId });
    if (entry?.kind !== 'ready') throw new Error(`Projection transport fixture: ${JSON.stringify({ entry, projectionBoundaryRequests })}`);
    expect({ entry, projectionBoundaryRequests }).toMatchObject({ entry: { kind: 'ready' } });
    expect(inputs?.mergedProviderProjectionById[agentId]?.identity).toEqual(identity);
    return inputs;
}

async function mount(inputs: DaemonMergedProjectionInputs | null, authoringCommitPending = false,
    overrides: Partial<Parameters<typeof useCreateNewSession>[0]> = {}) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { useCreateNewSession: owner } = await import('./useCreateNewSession');
    const machine = createMachineFixture({ id: 'm1' });
    storage.getState().applyMachines([machine], true, { sourceServerId: runtime.serverId });
    if (managedMachine) storage.getState().applyMachines([createMachineFixture({ id: 'controller',
        isShared: managedMachine.custodianAccountId !== 'account-a', access: {
            custodian: { accountId: managedMachine.custodianAccountId, displayName: 'Controller owner' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready',
        } }), machine], true, { sourceServerId: runtime.serverId });
    const params: Parameters<typeof useCreateNewSession>[0] = {
        launchIntentSignature: 'projection-currentness-launch-intent',
        authoringCommitPending,
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: machine.id, selectedPath: '/tmp', selectedMachine: machine,
        setIsCreating: vi.fn(), setIsResumeSupportChecking: vi.fn(),
        settings: storage.getState().settings,
        useProfiles: false, selectedProfileId: null, profileMap: new Map(),
        recentMachinePaths: [],
        agentType: agentId, staticAgentId: null, runtimeCarrierAgentId: agentId,
        backendTarget: agentTarget, spawnBackendTarget: spawnTarget,
        permissionMode: 'default', modelMode: 'default',
        promptStore: createNewSessionPromptStore(''), resumeSessionId: '', agentNewSessionOptions: null,
        machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
        secrets: [], secretBindingsByProfileId: {}, selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference: (ref) => ({
            ref, kind: 'personal', status: 'temporarily_unavailable',
            entry: null, secret: null, revision: null, fingerprint: null,
        }),
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: runtime.serverId, allowedTargetServerIds: [runtime.serverId],
        draftScope: { serverId: runtime.serverId, accountId: 'account-a' },
        daemonMergedProjectionInputs: inputs,
        ...overrides,
    };
    const hook = await renderHook((input: Parameters<typeof useCreateNewSession>[0]) => owner(input), { initialProps: params, wrapper: runtime.Wrapper });
    return { ...hook, params };
}

async function createManagedDraft(archiveEffect: 'keep' | 'stop' | 'delete' = 'keep') {
        const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        return createManagedMachineSelectionDraft({
            selection: { kind: 'one-off', homeId: runtime.serverIdentityId, launch, controller,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            receipt: { launch, controller, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            archiveEffect,
        });
}

describe('useCreateNewSession (projection currentness admission)', () => {
    it('submits the authored Session continuation to managed admission before acquiring a fresh target', async () => {
        observeFreshManagedAcquire = true;
        const selection = await createManagedDraft();
        const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({ directory: '/tmp', prompt: 'Submitted work',
            agentTarget, profileId: 'review-profile', permissionMode: 'read-only', sessionName: 'Submitted Session',
            connectedServices: null, sessionConfigOptionOverrides: buildAcpConfigOptionOverridesV1({
                updatedAt: 23, overrides: { reasoning_effort: { value: 'high', updatedAt: 23 } },
            }) });
        managedDeleteSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.acquire': ['ui'] } });
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applySettingsForScope({ serverId: runtime.serverId, accountId: 'account-a' },
            { ...storage.getState().settings, actionsSettingsV1: managedDeleteSettings }, 1);
        const hook = await mount(null, false, { managedMachineSelection: selection, authoringDraft,
            selectedMachineId: null, selectedMachine: null, permissionMode: 'read-only', launchUserAttemptId: 'fresh-send',
            promptStore: createNewSessionPromptStore('Submitted work'),
            onManagedMachineAcquisitionChange: () => {}, onManagedMachineEnrolled: async () => { throw new Error('unexpected_enrollment'); } });
        try {
            await act(async () => { await hook.getCurrent().handleCreateSession(); });
            expect(managedAcquireRequests).toHaveLength(1);
            expect(managedAcquireRequests[0]).toMatchObject({ selection: selection.selection, agentStart: {
                title: 'Submitted Session', agentTarget, profileId: 'review-profile', permissionMode: 'read-only',
                initialInput: { text: 'Submitted work' },
                configuration: { options: { reasoning_effort: { value: 'high', updatedAtMs: 23 } } },
            } });
            expect(managedAcquireRequests[0]).not.toHaveProperty('agentStart.executionTarget');
            expect(spawnRequests).toEqual([]);
            expect(hook.params.promptStore.getPrompt()).toBe('Submitted work');
            expect(hook.getCurrent().managedMachineCreationProgress).toMatchObject({ kind: 'failed', code: 'policy_denied_field' });
        } finally { await hook.unmount(); }
    });
    it('retires acknowledged failed-setup Delete custody without sending the held prompt or replaying its request', async () => {
        const selection = await createManagedDraft();
        managedMachine = { id: 'delete-paid', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: selection.receipt.launch, controller: selection.receipt.controller, enrolledMachineId: 'm1', allocation: 'bound',
            resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: { nativeId: 'retained-native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
            preset: { id: 'preset', revision: 1 }, environmentSetup: { environment: { setupScript: 'echo setup' },
                state: 'failed', errorCode: 'setup_failed' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        managedDeleteSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.delete': ['ui'] } });
        const inputs = await readCurrentProjection();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        storage.getState().applySettingsForScope(scope, { ...storage.getState().settings, actionsSettingsV1: managedDeleteSettings }, 1);
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        const acquisitions: unknown[] = [];
        const attempts: unknown[] = [];
        const retired = vi.fn();
        const hook = await mount(inputs, false, {
            managedMachineSelection: selection,
            managedMachineAcquisition: { requestId: 'original-send', selection: selection.selection, managedId: 'delete-paid' },
            launchUserAttemptId: 'original-send', onLaunchUserAttemptIdChange: value => attempts.push(value),
            onManagedMachineAcquisitionChange: value => acquisitions.push(value),
            onManagedMachineEnrolled: async () => {}, onManagedMachineDeleteRequested: retired,
        });
        try {
            hook.params.promptStore.setPrompt('Original held prompt');
            await act(async () => { await hook.getCurrent().handleCreateSession({ inputTextOverride: 'Original held prompt' }); });
            await vi.waitFor(() => expect(hook.getCurrent().managedMachineCreationProgress)
                .toMatchObject({ kind: 'failed', code: 'setup_failed' }));
            hook.params.promptStore.setPrompt('Preserve my later edits too');
            await act(async () => { hook.getCurrent().deleteManagedMachineAfterFailedSetup(); });
            await vi.waitFor(() => expect(retired, JSON.stringify({
                progress: hook.getCurrent().managedMachineCreationProgress, requests: managedDeleteRequests,
                acquisitions, attempts, confirmation: vi.mocked(Modal.confirm).mock.calls,
            })).toHaveBeenCalledOnce());
            expect(managedDeleteRequests).toContainEqual({ actionId: 'machines.managed.delete',
                target: { kind: 'machine', machineId: 'controller' }, input: { homeId: runtime.serverIdentityId,
                    managedId: 'delete-paid', when: 'now', expectedRevision: 4, intent: 'delete', reviewedDependencies: true } });
            expect(acquisitions.at(-1)).toBeNull();
            expect(attempts.at(-1)).toBeNull();
            expect(hook.params.promptStore.getPrompt()).toBe('Preserve my later edits too');
            expect(hook.getCurrent().managedMachineCreationProgress.kind).toBe('idle');
            await act(async () => {
                hook.getCurrent().retryManagedMachineSetup();
                hook.getCurrent().continueWithoutManagedMachineSetup();
                hook.getCurrent().deleteManagedMachineAfterFailedSetup();
            });
            expect(managedDeleteRequests.filter(request => request.actionId === 'machines.managed.delete')).toHaveLength(1);
            expect(spawnRequests).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it.each(['settled', 'in-flight', 'same-turn'] as const)('activates retained ordinary purpose defaults only after the selected Machine supplies an admitted Agent descriptor (%s generic read)', async (phase) => {
        retainedPurposeDefaults = { connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
            codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } },
        } } };
        const inputs = await readCurrentProjection();
        const { getResolvedAgentCatalogEntries } = await import('@/agents/backendCatalog/agentCatalogProjection');
        const agent = getResolvedAgentCatalogEntries({ enabledAgentIds: ['codex'],
            mergedProviderProjectionById: inputs?.mergedProviderProjectionById,
            mergedBackendProjectionById: inputs?.mergedBackendProjectionById }).find(entry => entry.agentId === 'codex');
        if (!agent?.identity) throw new Error('Expected actual admitted Codex descriptor');
        const { resetConnectedAccountCatalogSnapshotsForTests, getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        const { resetConnectedAccountCatalogEngineForTests } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
        resetConnectedAccountCatalogEngineForTests();
        resetConnectedAccountCatalogSnapshotsForTests();
        const { useNewSessionConnectedServicesAgentOptions } = await import('./screenModel/useNewSessionConnectedServicesAgentOptions');
        const { useConnectedAccountCatalog } = await import('@/sync/store/settings/useConnectedAccountCatalog');
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        if (phase === 'in-flight') purposeRowReadGate = createDeferred<void>();
        const hook = await renderHook((selectedMachineId: string | null) => {
            // The existing generic Account reader stays mounted while New Session admits a Machine.
            useConnectedAccountCatalog('purposes', scope);
            return useNewSessionConnectedServicesAgentOptions({
            staticAgentId: 'codex', runtimeCarrierAgentId: agent.agentId, selectedMachineId, targetServerId: runtime.serverId,
            selectedBackendTargetKey: 'codex', connectedAccounts: agent.connectedAccounts, agentIdentity: agent.identity,
            agentOptionState: null, settings: { connectedServicesDefaultProfileByServiceId: {} },
            router: { push() {} }, setBackendNewSessionOptionStateByTargetKey() {},
            });
        }, { initialProps: phase === 'same-turn' ? 'm1' : null, wrapper: runtime.Wrapper });
        try {
            if (phase === 'in-flight') {
                await vi.waitFor(() => expect(purposeRowReadCount).toBeGreaterThan(0));
            } else if (phase === 'settled') {
                await vi.waitFor(() => expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'unavailable' }));
            }
            if (phase !== 'same-turn') expect(purposeInitializationRequests).toEqual([]);
            expect(retainedPurposeDefaults).toHaveProperty('connectedServicesDefaultAuthByAgentIdV1');
            if (phase !== 'same-turn') await hook.rerender('m1');
            purposeRowReadGate?.resolve();
            await vi.waitFor(() => expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'ready', value: {
                bindings: [{ purpose: { consumer: agent.identity, purpose: 'primary' }, target: {
                    kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
                } }],
            } }));
            expect(purposeInitializationRequests).toHaveLength(1);
            expect(purposeInitializationRequests[0]).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 1 });
            expect(savedSecretImportRequests).not.toContain('/v1/account/saved-secrets/resources/materials');
        } finally { purposeRowReadGate?.resolve(); await hook.unmount(); }
    });
    it('retains the authored draft and refuses spawn when inherited purpose authority withdraws before Send', async () => {
        const inputs = await readCurrentProjection();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        const { useNewSessionConnectedServices } = await import('../modules/useNewSessionConnectedServices');
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const declarations = inputs?.mergedProviderProjectionById[agentId]?.connectedAccounts;
        if (!declarations) throw new Error('Expected actual projected Connected Account purpose');
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
            record: { key: 'purposes', value: { v: 1, bindings: [] } } }, true);
        const defaults = await renderHook(() => useNewSessionConnectedServices({
            agentCore: null, defaultAuthAgentId: agentId, defaultAuthConsumer: identity, connectedAccounts: declarations,
            agentOptionState: null, settings: storage.getState().settings,
            targetServerId: runtime.serverId, router: { push() {} }, setAgentOptionStateForCurrentAgent() {},
        }), { wrapper: runtime.Wrapper });
        const params = { agentNewSessionOptions: null,
            requireConnectedAccountDefaultsReady: defaults.getCurrent().requireConnectedAccountDefaultsReady };
        const hook = await mount(inputs, false, params);
        hook.params.promptStore.setPrompt('Keep this authored work');
        const settlements: unknown[] = [];
        try {
            expect(defaults.getCurrent().connectedAccountDefaultsStatus).toBe('ready');
            // A forbidden dispatch still settles through the real public daemon
            // response, so the missing admission guard cannot hang the fixture.
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => {
                applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
                const send = hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: value => { settlements.push(value); } });
                await send;
            });
            expect(spawnRequests).toEqual([]);
            expect(settlements).toEqual([{ status: 'rejected' }]);
            expect(hook.params.promptStore.getPrompt()).toBe('Keep this authored work');
        } finally { await hook.unmount(); await defaults.unmount(); }
    });
    it.each([['keep', 'account-a'], ['stop', 'account-a'], ['delete', 'account-a'], ['stop', 'alice'], ['delete', 'alice']] as const)(
        'settles the managed Bot %s scope through controller custodian %s before finalizing its creation draft', async (effect, custodianAccountId) => {
        const bindsRule = effect !== 'keep' && custodianAccountId === 'account-a';
        const selection = await createManagedDraft(effect);
        const promptStack = [{ id: 'session.instructions',
            ref: { kind: 'doc', serverId: runtime.serverId, artifactId: 'scope-bot-instructions' },
            enabled: true, required: true, placement: 'system_append' }] as const;
        const initialSessionFacts = { bot: { kind: 'bot' }, createdAsBot: true } as const;
        const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const authoringDraft = buildNewSessionAuthoringDraftFromResolvedInputs({
            sessionName: 'Scoped helper', initialSessionFacts, memoryEnabled: false, promptStack,
            executionTarget: { kind: 'machine', target: { serverId: runtime.serverId, machineId: 'm1' } },
            directory: '/tmp', prompt: '', agentTarget, connectedServices: null,
        });
        managedMachine = { id: 'paid', homeId: runtime.serverIdentityId, custodianAccountId,
            launch: selection.receipt.launch, controller: selection.receipt.controller, enrolledMachineId: 'm1', allocation: 'bound',
            resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: {} }, creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const settlements: unknown[] = [];
        const completedCallbacks: string[] = [];
        const launchFailures: string[] = [];
        let hook: Awaited<ReturnType<typeof mount>>;
        hook = await mount(await readCurrentProjection(), false, { managedMachineSelection: selection, authoringDraft,
            managedMachineAcquisition: { requestId: 'scope-send', selection: selection.selection, managedId: 'paid' },
            onManagedMachineAcquisitionChange: () => {}, onManagedMachineEnrolled: async () => {},
            onLaunchAttemptChange: attempt => { if (attempt) launchFailures.push(...Object.values(attempt.phaseErrors).map(error => error.message)); } });
        try {
            let send: Promise<void> | undefined;
            await act(async () => { send = hook.getCurrent().handleCreateSession({ initialMessage: 'skip',
                deferAcceptedDraftClearToDocument: true,
                afterCreated: async created => {
                    expect(scopeRules.size).toBe(bindsRule ? 1 : 0);
                    if (bindsRule) expect([...scopeRules.values()][0]).toMatchObject({ scopeSessionId: created.sessionId,
                        assignments: [{ machineId: 'controller' }], executionRecipe: { workflow: { t: 'plain', v: {
                            inlineDefinition: { blocks: [{ actionId: effect === 'stop' ? 'machines.managed.power.set' : 'machines.managed.delete' }] },
                        } } } });
                    await hook.rerender({ ...hook.params, managedMachineSelection: null }); completedCallbacks.push(created.sessionId);
                },
                onAfterCreatedSettled: settlement => { settlements.push(settlement); } }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(spawnRequests[0]).toMatchObject({ title: 'Scoped helper', identity: initialSessionFacts,
                memoryEnabled: false, promptStack });
            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.getState().applySessions([createSessionFixture({ id: 'created-session', serverId: runtime.serverId,
                metadata: { machineId: 'm1', path: '/tmp', host: 'test' } })]);
            spawnResult.resolve({ type: 'success', disposition: 'created', sessionId: 'created-session',
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } });
            // The completion callback owns its rerender act; an outer act would
            // defer its draft retirement until after the continuation checked it.
            await send;
            expect(completedCallbacks).toEqual(['created-session']);
            expect(launchFailures).toEqual([]);
            expect(settlements).toEqual([{ status: 'accepted', sessionId: 'created-session' }]);
            expect(hook.getCurrent().managedMachineCreationProgress.kind).not.toBe('failed');
        } finally { await hook.unmount(); }
    });
    it('retires the pending managed continuation synchronously on local Cancel without mutating the native resource', async () => {
        const selection = await createManagedDraft();
        managedMachine = {
            id: 'cancel-paid', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: selection.receipt.launch, controller: selection.receipt.controller,
            allocation: 'bound', resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: { nativeId: 'retained-native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        };
        const waiting = createDeferred<void>();
        managedOperationWait = waiting.promise;
        managedOperationSettled = true;
        const onManagedMachineEnrolled = vi.fn();
        const setIsCreating = vi.fn();
        const hook = await mount(await readCurrentProjection(), false, {
            managedMachineSelection: selection, selectedMachineId: null, selectedMachine: null,
            managedMachineAcquisition: { requestId: 'cancel-send', selection: selection.selection,
                managedId: 'cancel-paid', operation: { operationId: 'bot-install' } },
            onManagedMachineAcquisitionChange: () => {}, onManagedMachineEnrolled, setIsCreating,
        });
        let send: Promise<void> | undefined;
        try {
            await act(async () => { send = hook.getCurrent().handleCreateSession({ initialMessage: 'skip' }); });
            await vi.waitFor(() => expect(hook.getCurrent().managedMachineCreationProgress.kind).toBe('acquiring'));
            // The native operation may settle before React commits removal of the local draft.
            await act(async () => {
                hook.getCurrent().cancelManagedMachineCreation();
                expect(setIsCreating).toHaveBeenLastCalledWith(false);
                waiting.resolve(); await send;
            });
            expect(onManagedMachineEnrolled).not.toHaveBeenCalled();
            expect(spawnRequests).toEqual([]);
            expect(managedMachine).toMatchObject({ desired: 'start', allocation: 'bound', resource: { value: { nativeId: 'retained-native' } } });
        } finally {
            waiting.resolve();
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => { await send; });
            await hook.unmount();
        }
    });

    it('retires the selected Stop binding when original Home credentials change after enrollment and before Session acceptance', async () => {
        const selection = await createManagedDraft('stop');
        managedMachine = { id: 'credential-paid', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: selection.receipt.launch, controller: selection.receipt.controller, enrolledMachineId: 'm1', allocation: 'bound',
            resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: { nativeId: 'retained-native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const originalMachine = managedMachine;
        const attempts: NewSessionLaunchAttempt[] = [];
        const completedCallbacks: string[] = [];
        const settlements: unknown[] = [];
        const hook = await mount(await readCurrentProjection(), false, {
            managedMachineSelection: selection,
            managedMachineAcquisition: { requestId: 'credential-send', selection: selection.selection, managedId: 'credential-paid' },
            onManagedMachineAcquisitionChange: () => {}, onManagedMachineEnrolled: async () => {},
            onLaunchAttemptChange: attempt => { if (attempt) attempts.push(attempt); },
        });
        let send: Promise<void> | undefined;
        try {
            await act(async () => { send = hook.getCurrent().handleCreateSession({ initialMessage: 'skip',
                deferAcceptedDraftClearToDocument: true,
                afterCreated: async created => { completedCallbacks.push(created.sessionId); },
                onAfterCreatedSettled: settlement => { settlements.push(settlement); },
            }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(scopeRules.size).toBe(0);

            // The selected binding awaits the actual Session receipt. Rotate the
            // same Account's bearer through secure storage, without switching the
            // focused Home: only the submitted Account's credential watch retires it.
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const focusedLifetime = captureActiveServerAccountScopeLifetime();
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', jti: 'replacement-bearer' })).toString('base64url')}.signature`;
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl('https://session-pane.test', { serverId: runtime.serverId }, { token })).toBe(true);
            });
            expect(focusedLifetime.isCurrent()).toBe(true);
            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.getState().applySessions([createSessionFixture({ id: 'created-session', serverId: runtime.serverId,
                metadata: { machineId: 'm1', path: '/tmp', host: 'test' } })]);
            spawnResult.resolve({ type: 'success', disposition: 'created', sessionId: 'created-session',
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } });
            await act(async () => { await send; });

            expect(attempts.at(-1)).toMatchObject({ createdSessionId: 'created-session', status: 'failed_fatal',
                phaseErrors: { uploading_attachments: { message: 'continuation_retired', retryable: false } } });
            expect(scopeRules.size).toBe(0);
            expect(managedMachine).toEqual(originalMachine);
            expect(completedCallbacks).toEqual([]);
            expect(settlements).toEqual([{ status: 'rejected' }]);
            // Retirement is not a daemon retry: the already-created Session stays
            // true, but its native/FIN follow-up must not borrow the replacement bearer.
            expect(spawnRequests).toHaveLength(1);
        } finally {
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => { await send; });
            await hook.unmount();
        }
    });

    it('recovers observed install progress from the retained paid draft without submitting another Action', async () => {
        const selection = await createManagedDraft();
        const hook = await mount(await readCurrentProjection(), false, {
            managedMachineSelection: selection, selectedMachineId: null, selectedMachine: null,
            managedMachineAcquisition: { requestId: 'retained-send', selection: selection.selection,
                managedId: 'retained-paid', operation: { operationId: 'retained-install' } },
        });
        try {
            const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
            await act(async () => actionOperationStore.mergeSnapshots({ serverId: runtime.serverId, snapshots: [{
                version: 1, operationId: 'retained-install', revision: 1, actionId: 'machines.managed.acquire',
                state: 'running', scope: { accountId: 'account-a', machineId: 'controller' }, title: 'Install',
                createdAt: 1, startedAt: 1, cancellation: 'supported',
                progress: { kind: 'phase', phase: 'install', label: 'Installing Happier' },
            }] }));
            expect(hook.getCurrent().managedMachineCreationProgress).toMatchObject({
                kind: 'acquiring', managedId: 'retained-paid',
                operation: { operationId: 'retained-install', progress: { label: 'Installing Happier' } },
            });
            expect(spawnRequests).toEqual([]);
            await act(async () => actionOperationStore.mergeSnapshots({ serverId: runtime.serverId, snapshots: [{
                version: 1, operationId: 'retained-install', revision: 2, actionId: 'machines.managed.acquire',
                state: 'succeeded', scope: { accountId: 'account-a', machineId: 'controller' }, title: 'Install',
                createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
            }] }));
            // Historical success is not proof that the current managed row remains enrolled.
            expect(hook.getCurrent().managedMachineCreationProgress).toMatchObject({
                kind: 'acquiring', operation: { state: 'succeeded' },
            });
            await hook.rerender({ ...hook.params, draftScope: { serverId: runtime.serverId, accountId: 'replacement-account' } });
            expect(hook.getCurrent().managedMachineCreationProgress).toEqual({ kind: 'idle' });
        } finally {
            await hook.unmount();
        }
    });

    it('keeps the admitted machine continuation current when only the archive choice changes during install', async () => {
        const selection = await createManagedDraft();
        managedMachine = {
            id: 'paid', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: selection.receipt.launch, controller: selection.receipt.controller,
            allocation: 'bound', resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: { nativeId: 'same-native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        };
        const waiting = createDeferred<void>();
        managedOperationWait = waiting.promise;
        managedOperationSettled = true;
        let hook: Awaited<ReturnType<typeof mount>>;
        hook = await mount(await readCurrentProjection(), false, {
            managedMachineSelection: selection,
            managedMachineAcquisition: { requestId: 'same-send', selection: selection.selection, managedId: 'paid', operation: { operationId: 'bot-install' } },
            selectedMachineId: null, selectedMachine: null,
            onManagedMachineAcquisitionChange: () => {},
            onManagedMachineEnrolled: async machineId => {
                await hook.rerender({ ...hook.params, managedMachineSelection: { ...selection, archiveEffect: 'stop' },
                    selectedMachineId: machineId, selectedMachine: createMachineFixture({ id: machineId }) });
            },
        });
        let send: Promise<void> | undefined;
        try {
            await act(async () => { send = hook.getCurrent().handleCreateSession({ initialMessage: 'skip' }); });
            await vi.waitFor(() => expect(hook.getCurrent().managedMachineCreationProgress.kind).toBe('acquiring'));
            const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
            await act(async () => {
                actionOperationStore.mergeSnapshots({ serverId: runtime.serverId, snapshots: [{
                    version: 1, operationId: 'bot-install', revision: 1, actionId: 'machines.managed.acquire',
                    state: 'running', scope: { accountId: 'account-a', machineId: 'controller' }, title: 'Install',
                    createdAt: 1, startedAt: 1, cancellation: 'supported',
                    progress: { kind: 'phase', phase: 'install', label: 'Installing Happier' },
                }] });
                actionOperationStore.setMachineObservation({ serverId: runtime.serverId, machineId: 'controller' }, 'unavailable');
            });
            expect(hook.getCurrent().managedMachineCreationProgress).toMatchObject({
                kind: 'acquiring', operationObservation: 'unavailable',
            });
            await hook.rerender({ ...hook.params, managedMachineSelection: { ...selection, archiveEffect: 'stop' } });
            waiting.resolve();
            // Session start reaches its real transport after the same native install settles.
            // A rejected start creates no archive trigger regardless of the chosen effect.
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(spawnRequests[0]?.executionTarget).toEqual({ serverId: runtime.serverId, machineId: 'm1' });
        } finally {
            waiting.resolve();
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => { await send; });
            await hook.unmount();
        }
    });

    it('keeps Bot creation facts in ordinary custody across pending managed enrollment and Send refusal', async () => {
        const selection = await createManagedDraft();
        managedMachine = {
            id: 'bot-paid', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: selection.receipt.launch, controller: selection.receipt.controller,
            allocation: 'bound', resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: { nativeId: 'same-paid-resource' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        };
        const acquisition = { requestId: 'bot-managed-send', selection: selection.selection,
            managedId: managedMachine.id, operation: { operationId: 'bot-install' } };
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const draftId = 'bot-managed-continuation';
        const initialSessionFacts = { bot: { kind: 'bot' }, createdAsBot: true } as const;
        const promptStack = [{ id: 'session.instructions',
            ref: { kind: 'doc', serverId: runtime.serverId, artifactId: 'managed-instructions' },
            enabled: true, required: true, placement: 'system_append' }] as const;
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { buildNewSessionAuthoringDraftFromPersistedDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Managed helper', initialSessionFacts, memoryEnabled: false, promptStack,
            managedMachineSelection: selection, managedMachineAcquisition: acquisition,
            selectedMachineId: null, selectedPath: '/tmp', targetServerId: runtime.serverId,
            selectedProfileId: null, selectedSecretId: null, agentType: agentId, backendTarget: agentTarget,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected managed Bot draft');
        const projection = await readCurrentProjection();
        let hook: Awaited<ReturnType<typeof mount>>;
        hook = await mount(projection, false, {
            draftId, authoringDraft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened),
            managedMachineSelection: selection, managedMachineAcquisition: acquisition,
            selectedMachineId: null, selectedMachine: null,
            settings: { ...(await import('@/sync/domains/state/storageStore')).storage.getState().settings, memoryUpkeepInNewBots: false },
            onManagedMachineAcquisitionChange: () => {},
            onManagedMachineEnrolled: async machineId => {
                await hook.rerender({ ...hook.params, selectedMachineId: machineId,
                    selectedMachine: createMachineFixture({ id: machineId }),
                    authoringDraft: { ...hook.params.authoringDraft!, executionTarget: {
                        kind: 'machine', target: { serverId: runtime.serverId, machineId },
                    } },
                });
            },
        });
        try {
            await act(async () => { await hook.getCurrent().handleCreateSession({ initialMessage: 'skip' }); });
            expect(spawnRequests).toEqual([]);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                sessionName: 'Managed helper', initialSessionFacts, memoryEnabled: false,
                managedMachineAcquisition: acquisition, promptStack,
            });
            managedOperationSettled = true;
            let send: Promise<void> | undefined;
            await act(async () => { send = hook.getCurrent().handleCreateSession({ initialMessage: 'skip' }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(spawnRequests[0]).toMatchObject({
                title: 'Managed helper', identity: initialSessionFacts, memoryEnabled: false, promptStack,
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
            });
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => { await send; });
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                sessionName: 'Managed helper', initialSessionFacts, memoryEnabled: false,
                managedMachineAcquisition: acquisition, promptStack,
            });
        } finally {
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await hook.unmount();
        }
    });

    it.each([
        { type: 'error', code: 'target_unavailable', retryable: false },
        { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' },
    ] satisfies SessionSpawnNewResultV1[])('creates authored Instructions before ordinary Send and retains the qualified reference after $type', async result => {
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const draftId = 'authored-instructions-ordinary-send';
        const instructionsDraft = { title: 'Build helper remit', markdown: 'Preserve the project conventions.' };
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { buildNewSessionAuthoringDraftFromPersistedDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Build helper', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            selectedMachineId: 'm1', selectedPath: '/tmp', targetServerId: runtime.serverId,
            selectedProfileId: null, selectedSecretId: null, agentType: agentId, backendTarget: agentTarget,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected ordinary authored Bot draft');
        const submitted = { draftId, authoringDraft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened),
            getInstructionsDraft: () => instructionsDraft, getSessionName: () => 'Renamed before Send' };
        const hook = await mount(await readCurrentProjection(), false, submitted);
        spawnResult.resolve(result);
        try {
            await act(async () => { await hook.getCurrent().handleCreateSession({ initialMessage: 'skip' }); });
            expect(instructionsArtifacts.list()).toHaveLength(1);
            const created = instructionsArtifacts.list()[0]!;
            expect(instructionsArtifacts.readPlainBody(created.id)).toContain(instructionsDraft.markdown);
            const promptStack = [{ id: 'session.instructions',
                ref: { kind: 'doc', serverId: runtime.serverId, artifactId: created.id },
                enabled: true, required: true, placement: 'system_append' }];
            expect(spawnRequests).toHaveLength(1);
            expect(spawnRequests[0]).toMatchObject({ promptStack, title: 'Renamed before Send',
                identity: { bot: { kind: 'bot' }, createdAsBot: true } });
            expect(spawnRequests[0]).not.toHaveProperty('initialInput');
            expect(spawnRequests[0]).not.toHaveProperty('memoryEnabled');
            expect(scopeRules.size).toBe(0);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ promptStack, instructionsDraft: null });
            expect(instructionsArtifacts.read(created.id)).not.toBeNull();
        } finally { await hook.unmount(); }
    });

    it('keeps the authored draft and says its Instructions could not be prepared when the document store refuses', async () => {
        instructionsCreateUnavailable = true;
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const draftId = 'authored-instructions-document-failed';
        const instructionsDraft = { title: 'Build helper remit', markdown: 'Preserve the project conventions.' };
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { buildNewSessionAuthoringDraftFromPersistedDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Build helper', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true }, instructionsDraft,
            selectedMachineId: 'm1', selectedPath: '/tmp', targetServerId: runtime.serverId,
            selectedProfileId: null, selectedSecretId: null, agentType: agentId, backendTarget: agentTarget,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected ordinary authored Bot draft');
        const hook = await mount(await readCurrentProjection(), false, { draftId,
            authoringDraft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened), getInstructionsDraft: () => instructionsDraft });
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');
        vi.mocked(Modal.alert).mockClear();
        try {
            await act(async () => { await hook.getCurrent().handleCreateSession({ initialMessage: 'skip' }); });
            expect(spawnRequests).toEqual([]);
            expect(instructionsArtifacts.list()).toEqual([]);
            expect(vi.mocked(Modal.alert).mock.calls).toContainEqual([t('common.error'), t('bots.create.documentFailed')]);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ sessionName: 'Build helper', instructionsDraft });
        } finally { await hook.unmount(); }
    });

    it('keeps a selected unsupported archive effect explicit before buying or starting', async () => {
        const supported = await createManagedDraft('stop');
        const selection = { ...supported, receipt: { ...supported.receipt,
            retentionCapabilities: { supportedIntents: ['start' as const, 'delete' as const] } } };
        const hook = await mount(null, false, { managedMachineSelection: selection, selectedMachineId: null, selectedMachine: null });
        await act(async () => { await Promise.resolve(hook.getCurrent().handleCreateSession()); });
        expect(spawnRequests).toEqual([]);
        expect(hook.getCurrent().managedMachineCreationProgress).toMatchObject({ kind: 'failed', code: 'native_intent_unsupported' });
        await hook.unmount();
    });
    it('uses a fresh request after explicit replacement cleared the previous paid reference, even for the same recipe', async () => {
        const managedDraft = await createManagedDraft();
        const references: Array<NonNullable<Parameters<typeof useCreateNewSession>[0]['managedMachineAcquisition']>> = [];
        const hook = await mount(null, false, {
            managedMachineSelection: managedDraft,
            managedMachineAcquisition: { requestId: 'previous-send', selection: managedDraft.selection, managedId: 'previous-paid' },
            selectedMachineId: null, selectedMachine: null,
            onManagedMachineAcquisitionChange: value => { if (value) references.push(value); },
            onManagedMachineEnrolled: async () => {},
        });
        await hook.rerender({ ...hook.params, launchIntentSignature: 'explicit-fresh-use', managedMachineAcquisition: null, launchUserAttemptId: null });
        await act(async () => { await Promise.resolve(hook.getCurrent().handleCreateSession()); });
        expect(references).toHaveLength(1);
        expect(references[0]?.requestId).not.toBe('previous-send');
        expect(references[0]?.managedId).toBeUndefined();
        expect(spawnRequests).toEqual([]);
        await hook.unmount();
    });
    it('emits the exact qualified Agent identity of the current projection on the spawn payload', async () => {
        const hook = await mount(await readCurrentProjection());
        let pending: void | Promise<void> = undefined;
        try {
            await act(async () => { pending = hook.getCurrent().handleCreateSession(); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(spawnRequests[0]?.agentTarget).toEqual(agentTarget);
            expect(spawnRequests[0]?.agentTarget.identity).toEqual(identity);
        } finally {
            spawnResult.resolve({ type: 'error', code: 'machine_offline', retryable: true });
            await act(async () => { await pending; });
            await hook.unmount();
        }
    });

    it('does not issue a Session request while an authoring selection commit is pending', async () => {
        const hook = await mount(await readCurrentProjection(), true);
        await act(async () => { await Promise.resolve(hook.getCurrent().handleCreateSession()); });
        expect(spawnRequests).toEqual([]);
    });

    it('fails closed without emitting a spawn payload when the current projection cannot qualify the target', async () => {
        const hook = await mount(null);
        await act(async () => { await Promise.resolve(hook.getCurrent().handleCreateSession()); });
        expect(spawnRequests).toEqual([]);
        expect(hook.getCurrent()).toBeTruthy();
    });
});
