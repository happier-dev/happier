import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createExistingSessionDirectoryPreflightResult, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema, type AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { configureConnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createNewSessionPromptStore } from './screenModel/newSessionPromptStore';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { HandleCreateSessionOptions, useCreateNewSession } from './useCreateNewSession';
import { SessionAuthoringValueV1Schema } from '@happier-dev/protocol/sessions/authoring/index';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import type { NewSessionLaunchAttempt } from '../modules/newSessionLaunchAttempt';
import type { NewSessionConnectedServicesSelectionContentProps } from '../components/NewSessionConnectedServicesSelectionContent';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { buildNewSessionLaunchIntentSignature, type NewSessionPreparedInstructions } from '../modules/newSessionLaunchIntent';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';

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
let purposeRowForbidden = false;
let sharedGuestMachine = false;
let spawnResult: ReturnType<typeof createDeferred<SessionSpawnNewResultV1>>;
let spawnOperationTerminal: ReturnType<typeof createDeferred<void>> | null = null;
let authoringHttp: ReturnType<typeof createAuthoringMemoryHttpBoundary>;
let instructionsArtifacts: ReturnType<typeof createArtifactStoreBoundary>;
let instructionsCreateUnavailable = false;
let instructionsCreateGate: ReturnType<typeof createDeferred<void>> | null = null;
let instructionsCreateReached: ReturnType<typeof createDeferred<void>> | null = null;
let restoreActionExecutorModuleLoader: (() => void) | undefined;
let managedMachine: ManagedMachineV1 | null = null;
let managedOperationSettled = false;
let managedOperationWait: Promise<void> | null = null;
let managedDeleteSettings: ReturnType<typeof ActionsSettingsV1Schema.parse> | null = null;
const managedDeleteRequests: Array<{ actionId: string; target: unknown; input: unknown }> = [];
let managedActionHttp: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | null = null;
const managedAcquireRequests: unknown[] = [];
let managedConsentHttp: ((path: string, init?: RequestInit) => Promise<Response | null>) | null = null;
let managedConsentRpc: ((method: string, params: unknown) => Promise<unknown | null>) | null = null;
const scopeRules = new Map<string, AutomationDefinitionDetail>();

beforeEach(async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    vi.mocked(Modal.prompt).mockReset().mockResolvedValue(null);
    spawnRequests.length = 0;
    projectionBoundaryRequests.length = 0;
    purposeInitializationRequests.length = 0;
    savedSecretImportRequests.length = 0;
    retainedPurposeDefaults = null;
    initializedPurposeContent = null;
    purposeRowReadGate = null;
    purposeRowReadCount = 0;
    purposeRowForbidden = false;
    sharedGuestMachine = false;
    managedMachine = null;
    managedOperationSettled = false;
    managedOperationWait = null;
    managedDeleteSettings = null;
    managedDeleteRequests.length = 0;
    managedActionHttp = null;
    managedAcquireRequests.length = 0;
    managedConsentHttp = null;
    managedConsentRpc = null;
    scopeRules.clear();
    spawnResult = createDeferred<SessionSpawnNewResultV1>();
    spawnOperationTerminal = null;
    authoringHttp = createAuthoringMemoryHttpBoundary();
    instructionsArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    instructionsCreateUnavailable = false;
    instructionsCreateGate = null;
    instructionsCreateReached = null;
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
    features: () => createRootLayoutFeaturesResponse(managedConsentHttp || sharedGuestMachine || managedActionHttp ? { features: {
        encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
    } } : {}),
    request: async (url, init) => {
        const requestUrl = new URL(String(url));
        const consentResponse = await managedConsentHttp?.(requestUrl.pathname, init);
        if (consentResponse) return consentResponse;
        const actionBoundary = managedActionHttp;
        if (actionBoundary) {
            if (requestUrl.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === actionBoundary.machine.id ? actionBoundary.machine
                    : createPlainMachineRowFixture({ id, accountId: 'account-a' }));
            const actionResponse = await actionBoundary.handle(requestUrl, init);
            if (actionResponse) return actionResponse;
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
        if (requestUrl.pathname === '/v1/artifacts' && init?.method === 'POST' && instructionsCreateGate) {
            instructionsCreateReached?.resolve();
            await instructionsCreateGate.promise;
        }
        const artifactResponse = instructionsArtifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init);
        if (artifactResponse) return await artifactResponse;
        if (managedMachine && new URL(String(url)).pathname === managedMachineActionEndpointPathV1('machines.managed.get')) {
            return Response.json(managedMachine);
        }
        if (new URL(String(url)).pathname === '/v2/account/settings') {
            if (managedDeleteSettings) return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: managedDeleteSettings } }, version: 1 });
            if (retainedPurposeDefaults) return Response.json({ content: { t: 'plain', v: retainedPurposeDefaults }, version: 1 });
            return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        }
        if (requestUrl.pathname === '/v1/account/entity-rows/connected-accounts/purposes') {
            if (init?.method !== 'POST') purposeRowReadCount += 1;
            if (purposeRowForbidden) return Response.json({ error: 'forbidden' }, { status: 403 });
            if (retainedPurposeDefaults) {
                if (init?.method === 'POST') {
                    const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    purposeInitializationRequests.push(mutation);
                    initializedPurposeContent = mutation.content;
                    return Response.json({ status: 'updated', revision: 1, cursor: 1 });
                }
                await purposeRowReadGate?.promise;
                return Response.json(initializedPurposeContent
                    ? { status: 'present', revision: 1, content: initializedPurposeContent } : { status: 'absent' });
            }
            return Response.json({ status: 'present', revision: 1,
                content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } });
        }
        if (requestUrl.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
            return createMachineReadBatchResponseFixture(init.body, id => createPlainMachineRowFixture({ id,
                accountId: sharedGuestMachine && id === 'm1' ? 'guest-owner' : 'account-a',
                ...(sharedGuestMachine && id === 'm1' ? { machine: createMachineFixture({ id, isShared: true, access: {
                    custodian: { accountId: 'guest-owner', displayName: 'Guest owner' },
                    role: 'use', resourceMode: 'plain', accessState: 'ready',
                } }) } : {}),
            }));
        }
        const machineRead = /^\/v1\/machines\/(m1|controller)$/.exec(new URL(String(url)).pathname);
        if (machineRead) {
            const id = machineRead[1]!;
            return Response.json({ machine: createPlainMachineRowFixture({ id,
                accountId: sharedGuestMachine && id === 'm1' ? 'guest-owner' : 'account-a' }) });
        }
        const machineAccessRead = /^\/v1\/machines\/(m1|controller)\/access$/.exec(new URL(String(url)).pathname);
        if (machineAccessRead) {
            const custodian = machineAccessRead[1] === 'controller' && managedMachine
                ? { accountId: managedMachine.custodianAccountId, displayName: 'Controller owner' }
                : sharedGuestMachine && machineAccessRead[1] === 'm1'
                ? { accountId: 'guest-owner', displayName: 'Guest owner' }
                : { accountId: 'account-a', displayName: 'Account A' };
            const canManage = custodian.accountId === 'account-a';
            return Response.json({ machineId: machineAccessRead[1], custodian,
                access: { custodian, role: canManage ? 'manage' : 'use', resourceMode: 'plain', accessState: 'ready' },
                canManage, grants: [], ownDirectGrant: false, ownAccessSources: [],
            });
        }
        return await authoringHttp.handle(url, init);
    },
    configureSocket: (socket) => {
        configureConnectedServerSocketBoundary(socket);
        // Socket is the transport boundary; presence cleanup cannot write to a real unconnected engine.
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!payload || typeof payload !== 'object' || !('method' in payload)
                || typeof payload.method !== 'string' || !('params' in payload)) {
                throw new Error('Malformed daemon RPC');
            }
            const method = payload.method.slice(payload.method.indexOf(':') + 1);
            const consentResponse = await managedConsentRpc?.(method, payload.params);
            if (consentResponse) return consentResponse;
            if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
                return { ok: true, result: createExistingSessionDirectoryPreflightResult(payload.params) };
            }
            projectionBoundaryRequests.push(method);
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get && spawnOperationTerminal) {
                await spawnOperationTerminal.promise;
                return { ok: true, result: { kind: 'found', operation: {
                    version: 1, operationId: 'r71-accepted-launch', revision: 2,
                    actionId: 'session.spawn_new', state: 'failed', scope: { accountId: 'account-a', machineId: 'm1' },
                    title: 'Start Session', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
                    error: { errorCode: 'target_unavailable', error: 'target_unavailable' },
                } } };
            }
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
                                providerRequirements: Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(agent => agent.identity.localId === 'codex')?.providerRequirements,
                                connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }] },
                        },
                        installedPackagesById: {}, actionsById: {},
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

// Prepare after the transport harness installs its real-store boundary, before per-case bootstrap.
await import('@/sync/ops/actions/defaultActionExecutor');

async function readCurrentProjection() {
    const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs,
        readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.setState({ profileScope: { serverId: runtime.serverId, accountId: 'account-a' },
        profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain' })], true, { sourceServerId: runtime.serverId });
    clearDaemonMergedProjectionCacheForTests();
    const inputs = await loadDaemonMergedProjectionInputs({ sections: 'complete',
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
    overrides: Partial<Parameters<typeof useCreateNewSession>[0]> = {},
    projectParams: (params: Parameters<typeof useCreateNewSession>[0]) => Parameters<typeof useCreateNewSession>[0] = params => params,
    throughCaller = false) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { useCreateNewSession: owner } = await import('./useCreateNewSession');
    const { useNewSessionCreateSessionAction } = await import('./screenModel/useNewSessionCreateSessionAction');
    const machine = overrides.selectedMachine ?? createMachineFixture({ id: 'm1', storageMode: 'plain' });
    storage.getState().applyMachines([machine], true, { sourceServerId: runtime.serverId });
    if (managedMachine && !managedConsentHttp) storage.getState().applyMachines([createMachineFixture({ id: 'controller',
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
    const hook = await renderHook((input: Parameters<typeof useCreateNewSession>[0]) => {
        const projected = projectParams(input);
        if (!throughCaller) return owner(projected);
        const { authoringDraft, allowedTargetServerIds, ...callerParams } = projected;
        return useNewSessionCreateSessionAction({ ...callerParams, currentAuthoringDraft: authoringDraft,
            allowedTargetServerIds: allowedTargetServerIds ?? [], resolvedSettingsAllowedServerIds: [runtime.serverId] });
    }, { initialProps: params, wrapper: runtime.Wrapper });
    return { ...hook, params };
}

// Send admits synchronously; its public settlement observer owns completion.
function startCreation(hook: Awaited<ReturnType<typeof mount>>, options: HandleCreateSessionOptions): Promise<void> {
    const settled = createDeferred<void>();
    hook.getCurrent().handleCreateSession({
        ...options,
        onAfterCreatedSettled: value => {
            options.onAfterCreatedSettled?.(value);
            settled.resolve();
        },
    });
    return settled.promise;
}

async function createManagedDraft(archiveEffect: 'keep' | 'stop' | 'delete' = 'keep') {
        const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        return createManagedMachineSelectionDraft({
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            selection: { kind: 'one-off', homeId: runtime.serverIdentityId, launch, controller,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            receipt: { launch, controller, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            archiveEffect,
        });
}

describe('shared guest Send through the screen action caller', () => {
    it('dispatches a brokered Team model without reading suppressed native Account defaults or passing settings', async () => {
        purposeRowForbidden = true;
        sharedGuestMachine = true;
        const inputs = await readCurrentProjection();
        const { SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2 } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
        managedActionHttp = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-pane.test',
            serverIdentityId: runtime.serverIdentityId, accountId: 'account-a', machineId: 'm1',
            custodian: { accountId: 'guest-owner', displayName: 'Guest owner' },
            actionId: 'session.spawn_new', tokenEpoch: 0, requesterInvocation: 'credentials',
            execute: async input => {
                spawnRequests.push(admitSessionSpawnNewActionInputV2(SessionSpawnNewActionInputV2Schema.parse(input)));
                return await spawnResult.promise;
            },
        });
        const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const { useNewSessionConnectedServicesAgentOptions } = await import('./screenModel/useNewSessionConnectedServicesAgentOptions');
        const { applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        const { TeamCredentialResourceCatalogEntryV1Schema } = await import('@happier-dev/protocol/teams');
        const { SessionModelSelectionV2Schema, projectSessionModelSelectionV2ToV1, sessionModelSelectionV2TeamBindingIntent } = await import('@happier-dev/protocol/providers/selection/v2');
        const target = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const targetKey = 'agent:happier.agent.codex/codex';
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: 'shared-model', teamId: 'engineering', displayName: 'Engineering models', resourceRevision: 2,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', sourcePresentation: null,
            providerModels: [{ selection: { kind: 'team_credential_provider_model', teamId: 'engineering', resourceId: 'shared-model',
                expectedResourceRevision: 2, agentTargetKey: targetKey, modelId: 'gpt-5.6-luna', deliveryMode: 'brokered' },
                descriptor: { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }, availability: 'available', sourceRevision: 'source-2',
                application: { agentTargetKey: targetKey, implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses' } }],
        });
        const { kind: _providerModelKind, ...model } = resource.providerModels[0]!.selection;
        const selection = { ...model, source: 'team_resource' as const };
        const modelSelection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1, ref: selection });
        const teamBinding = sessionModelSelectionV2TeamBindingIntent(modelSelection);
        const statuses = new Map([['engineering:shared-model', { kind: 'current' as const }]]);
        const declaration = inputs?.mergedProviderProjectionById.codex;
        if (!declaration?.identity) throw new Error('Expected Codex Machine declaration');
        applyConnectedAccountCatalogSnapshot({ serverId: runtime.serverId, accountId: 'account-a' }, 'purposes',
            { status: 'unavailable', reason: 'forbidden' }, true);
        const draft = buildNewSessionAuthoringDraftFromResolvedInputs({ directory: '/home/member/workspace', prompt: 'Ready',
            agentTarget: target, modelSelection: projectSessionModelSelectionV2ToV1(modelSelection),
            teamCredentialBindings: [teamBinding], connectedServices: null });
        const hook = await mount(inputs, false, {
            selectedMachine: createMachineFixture({ id: 'm1', isShared: true, access: {
                custodian: { accountId: 'guest-owner', displayName: 'Guest owner' },
                role: 'use', resourceMode: 'plain', accessState: 'ready',
            } }),
            selectedPath: '/home/member/workspace', agentType: 'codex', staticAgentId: 'codex', runtimeCarrierAgentId: 'codex',
            backendTarget: target, spawnBackendTarget: target, authoringDraft: draft,
        }, params => {
            const connected = useNewSessionConnectedServicesAgentOptions({
                staticAgentId: 'codex', runtimeCarrierAgentId: 'codex', selectedMachineId: params.selectedMachineId,
                targetServerId: runtime.serverId, selectedBackendTargetKey: targetKey,
                connectedAccounts: declaration.connectedAccounts, agentIdentity: declaration.identity,
                modelSelection: selection, providerProjection: inputs?.pluginProjectionV2,
                teamCredentialResources: [resource], teamCredentialResourceStatusByKey: statuses,
                agentOptionState: null, settings: { connectedServicesDefaultProfileByServiceId: {} },
                router: params.router, setBackendNewSessionOptionStateByTargetKey() {},
            });
            return { ...params, agentNewSessionOptions: connected.agentNewSessionOptions,
                requireConnectedAccountDefaultsReady: connected.requireConnectedAccountDefaultsReady };
        }, true);
        try {
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => { await startCreation(hook, {}); });
            expect(spawnRequests).toHaveLength(1);
            expect(spawnRequests[0]).toMatchObject({ teamCredentialBindings: [teamBinding] });
            expect(purposeRowReadCount).toBe(0);
        } finally { await hook.unmount(); }
    });
});

describe('useCreateNewSession (projection currentness admission)', () => {
    it.each(['Team currentness refresh', 'Team availability refresh', 'launch attempt persistence', 'Send composer flush', 'Send composer flush with retained attempt', 'Instructions materialization', 'Instructions edit during preparation',
        'authored text edit', 'authored text edit without render', 'draft switch', 'draft deletion', 'Account scope change', 'Home change', 'unmount'] as const)(
        'respects admitted authored intent through %s during custody', async cause => {
        const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        const { readSpawnAttemptCustodyState } = await import('@/sync/domains/session/spawn/spawnAttemptNonceStore');
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository, writeNewSessionInstructionsToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { getSessionDraftSnapshot, subscribeSessionDraft, resetSessionDraftRepositoryForTests, deleteSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createNewSessionComposerDocumentOwner } = await import('@/components/sessions/composer/newSessionComposerDocumentOwner');
        const { buildNewSessionAuthoringDraftFromPersistedDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const { composeConnectedServiceTeamCredentialBindingIntents } = await import('../modules/connectedServicesNewSessionBindings');
        const { applyTeamCredentialResourceCatalog, getTeamCredentialResourceCatalogSnapshot, subscribeTeamsSnapshots } = await import('@/sync/store/teams/teamsSnapshots');
        const { ConnectedServiceBindingsV2Schema } = await import('@happier-dev/protocol/connect/connected-service-bindings');
        const { captureNewSessionDraftLaunchCurrentness } = await import('../modules/newSessionDraftLifecycle');
        const inputs = await readCurrentProjection();
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const draftId = 'b2571c5a-d42d-4b87-8aa0-62021ff18170';
        const address = { kind: 'newSession', draftId } as const;
        const teamAddress = { serverId: runtime.serverId, teamId: 'team-launch' };
        const selection = { source: 'team_resource', resourceId: 'resource-launch', deliveryMode: 'brokered' } as const;
        const bindings = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: { 'acme.review/auth': selection } });
        const resource: TeamCredentialResourceCatalogEntryV1 = { id: selection.resourceId, teamId: teamAddress.teamId, displayName: 'Shared sign-in', resourceRevision: 3,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
            connectedServiceSelections: [selection], sourcePresentation: { kind: 'connected_service', service: connectedAccountDeclaration.service },
        };
        applyTeamCredentialResourceCatalog({ scope, address: teamAddress, resources: [resource], observedAt: 1 });
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: { input: 'Original prompt', selectedMachineId: 'm1', selectedPath: '/tmp',
            agentType: agentId, backendTarget: spawnTarget,
            selectedProfileId: null, selectedSecretId: null, permissionMode: 'default', acpSessionModeId: null,
            ...(cause.startsWith('Instructions') ? { instructionsDraft: { title: 'Launch instructions', markdown: 'Keep the authored requirements.' } } : {}), updatedAt: 1 } });
        if (cause === 'Instructions edit during preparation') {
            instructionsCreateGate = createDeferred<void>();
            instructionsCreateReached = createDeferred<void>();
        }
        if (cause === 'Send composer flush with retained attempt') {
            captureNewSessionDraftLaunchCurrentness({ scope, draftId, launchUserAttemptId: 'obsolete-attempt' });
        }
        const composer = createNewSessionComposerDocumentOwner({ scope,
            ref: { kind: 'newSession', instanceId: draftId } });
        const promptStore = createNewSessionPromptStore('Original prompt');
        const initialDraft = readNewSessionDraftFromRepository({ scope, draftId });
        if (!initialDraft) throw new Error('Expected seeded launch draft');
        if (cause === 'Send composer flush with retained attempt') expect(initialDraft.launchUserAttemptId).toBe('obsolete-attempt');
        const legacySignatures: string[] = [];
        let currentSignature = '';
        let readCurrentSignature = () => currentSignature;
        let project: Parameters<typeof mount>[3];
        project = params => {
            const [, setCreating] = React.useState(false);
            React.useSyncExternalStore(listener => subscribeSessionDraft(scope, address, listener), () => getSessionDraftSnapshot(scope, address));
            const catalog = React.useSyncExternalStore(subscribeTeamsSnapshots, () => getTeamCredentialResourceCatalogSnapshot(scope, teamAddress));
            const persisted = readNewSessionDraftFromRepository({ scope, draftId }) ?? initialDraft;
            const [launchUserAttemptId, setLaunchUserAttemptId] = React.useState(persisted.launchUserAttemptId ?? null);
            React.useEffect(() => { setLaunchUserAttemptId(persisted.launchUserAttemptId ?? null); }, [persisted.launchUserAttemptId]);
            const teamCredentialBindings = composeConnectedServiceTeamCredentialBindingIntents({ consumer: identity,
                declarations: [connectedAccountDeclaration], bindings, resources: catalog?.data ?? [] });
            const draft = { ...buildNewSessionAuthoringDraftFromPersistedDraft(persisted), agentTarget,
                connectedServices: SessionAuthoringValueV1Schema.shape.connectedServices.parse(bindings),
                teamCredentialBindings: teamCredentialBindings.length > 0 ? teamCredentialBindings : undefined };
            const signatureInput = { draft, composerDocumentRevision: composer.read().revision, machineId: 'm1',
                managedMachineSelection: null, sourceContext: null, selectedSecretReferences: {}, targetServerId: params.targetServerId ?? null };
            const { composerDocumentRevision: _revision, ...intent } = signatureInput;
            const readLaunchIntentSignature = (preparedInstructions?: NewSessionPreparedInstructions) => {
                const live = readNewSessionDraftFromRepository({ scope, draftId }) ?? initialDraft;
                return buildNewSessionLaunchIntentSignature({ ...intent,
                    draft: { ...draft, instructionsDraft: live.instructionsDraft, promptStack: live.promptStack, ...preparedInstructions },
                    composerDocument: { ...composer.read().document, text: promptStore.getPrompt() } });
            };
            currentSignature = readLaunchIntentSignature();
            readCurrentSignature = readLaunchIntentSignature;
            legacySignatures.push(JSON.stringify(signatureInput));
            return { ...params, authoringDraft: draft, launchIntentSignature: currentSignature, readLaunchIntentSignature,
                launchUserAttemptId,
                setIsCreating: value => { params.setIsCreating(value); setCreating(value); },
                onLaunchUserAttemptIdChange: attemptId => {
                    setLaunchUserAttemptId(attemptId);
                    const retained = readNewSessionDraftFromRepository({ scope, draftId });
                    if (retained) writeNewSessionDraftToRepository({ scope, draftId, draft: { ...retained,
                        ...(attemptId ? { launchUserAttemptId: attemptId } : { launchUserAttemptId: undefined }), updatedAt: 2 } });
                } };
        };
        const hook = await mount(inputs, false, { draftId, promptStore }, project);
        if (cause.startsWith('Send composer flush')) promptStore.setPrompt('Text admitted by Send');
        const locks = installWebLockManagerMock();
        const request = navigator.locks.request.bind(navigator.locks);
        const custodyReached = createDeferred<void>();
        const releaseCustody = createDeferred<void>();
        let changed = false;
        let before = '';
        let after = '';
        let legacyBefore = '';
        let legacyAfter = '';
        const lockSpy = vi.spyOn(navigator.locks, 'request').mockImplementation(async (name, options, callback) => {
            const result = await request(name, options, callback);
            const custody = readSpawnAttemptCustodyState(scope);
            if (!changed && name.startsWith('happier:session-spawn-attempts-v2:') && custody.status === 'valid'
                && Object.values(custody.attempts).some(attempt => attempt.submissionState === 'submitted')) {
                changed = true;
                expect(spawnRequests).toEqual([]);
                before = currentSignature;
                legacyBefore = legacySignatures.at(-1)!;
                custodyReached.resolve();
                await releaseCustody.promise;
            }
            return result;
        });
        spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
        let send: Promise<void> | undefined;
        try {
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip' }); });
            if (cause === 'Instructions edit during preparation') {
                await instructionsCreateReached!.promise;
                const edited = { title: 'Later instructions', markdown: 'Preserve this later edit.' };
                await act(async () => { writeNewSessionInstructionsToRepository({ scope, draftId, instructionsDraft: edited }); });
                instructionsCreateGate!.resolve();
                await act(async () => { await send; });
                expect(spawnRequests).toEqual([]);
                expect(readNewSessionDraftFromRepository({ scope, draftId })?.instructionsDraft).toEqual(edited);
                expect(hook.params.setIsCreating).toHaveBeenLastCalledWith(false);
                return;
            }
            await custodyReached.promise;
            if (cause === 'unmount') await hook.unmount();
            else if (cause === 'draft switch') await hook.rerender({ ...hook.params, draftId: 'other-draft' });
            else if (cause === 'Account scope change') await hook.rerender({ ...hook.params, draftScope: { ...scope, accountId: 'account-b' } });
            else if (cause === 'Home change') await hook.rerender({ ...hook.params, targetServerId: 'other-home' });
            else if (cause === 'authored text edit without render') promptStore.setPrompt('Different work after Send');
            else await act(async () => {
                if (cause === 'draft deletion') {
                    expect(await deleteSessionDraft({ scope, address })).toBe(true);
                } else if (cause === 'authored text edit') {
                    promptStore.setPrompt('Different work after Send');
                    await hook.rerender(hook.params);
                } else if (cause === 'Team currentness refresh' || cause === 'Team availability refresh') {
                    applyTeamCredentialResourceCatalog({ scope, address: teamAddress,
                        resources: cause === 'Team availability refresh' ? [] : [resource], observedAt: 2, current: false });
                } else {
                    const retained = readNewSessionDraftFromRepository({ scope, draftId });
                    if (!retained) throw new Error('Expected launch-owned draft');
                    writeNewSessionDraftToRepository({ scope, draftId, draft: { ...retained, input: promptStore.getPrompt(), updatedAt: 3 } });
                }
            });
            after = readCurrentSignature();
            legacyAfter = legacySignatures.at(-1)!;
            releaseCustody.resolve();
            await act(async () => { await send; });
            expect(changed).toBe(true);
            const preserved = ['Team currentness refresh', 'Team availability refresh', 'launch attempt persistence', 'Send composer flush', 'Send composer flush with retained attempt', 'Instructions materialization'].includes(cause);
            if (preserved) {
                expect(legacyAfter === legacyBefore).toBe(cause === 'Team currentness refresh' || cause === 'launch attempt persistence' || cause === 'Instructions materialization');
                const original = JSON.parse(legacyBefore) as { draft: Record<string, unknown>; composerDocumentRevision: number };
                const refreshed = JSON.parse(legacyAfter) as typeof original;
                const changedDraftFields = Object.keys({ ...original.draft, ...refreshed.draft }).filter(key =>
                    JSON.stringify(original.draft[key]) !== JSON.stringify(refreshed.draft[key])).sort();
                expect(changedDraftFields).toEqual(cause === 'Team availability refresh' ? ['teamCredentialBindings']
                    : cause.startsWith('Send composer flush') ? ['displayText', 'prompt'] : []);
                expect(original.composerDocumentRevision !== refreshed.composerDocumentRevision).toBe(cause.startsWith('Send composer flush'));
                expect(before).toBe(after);
            }
            expect(spawnRequests).toHaveLength(preserved ? 1 : 0);
            if (cause === 'Send composer flush with retained attempt') {
                const { buildManualSessionCreationKey } = await import('@/sync/ops/actions/sessionSpawnNewAction');
                expect(spawnRequests[0].creationKey).not.toBe(buildManualSessionCreationKey('obsolete-attempt'));
            }
            if (cause !== 'unmount') expect(hook.params.setIsCreating).toHaveBeenLastCalledWith(false);
            const custody = readSpawnAttemptCustodyState(scope);
            if (preserved) {
                expect(custody.status).toBe('valid');
                if (custody.status !== 'valid') throw new Error('Expected retained terminal refusal');
                expect(Object.values(custody.attempts)).toEqual([expect.objectContaining({
                    createdSessionId: null, terminalResult: { type: 'error', code: 'target_unavailable', retryable: false },
                })]);
            } else expect(custody).toEqual({ status: 'missing' });
        } finally { instructionsCreateGate?.resolve(); releaseCustody.resolve(); await send; lockSpy.mockRestore(); locks.restore(); await hook.unmount(); resetSessionDraftRepositoryForTests(); }
    });
    it.each(['refresh', 'retire'] as const)('settles a launch when its captured Account changes during custody: %s', async change => {
        const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { readSpawnAttemptCustodyState } = await import('@/sync/domains/session/spawn/spawnAttemptNonceStore');
        const { Modal } = await import('@/modal');
        const attempts: Array<NewSessionLaunchAttempt | null> = [];
        const settlements: unknown[] = [];
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const hook = await mount(await readCurrentProjection(), false, {
            onLaunchAttemptChange: attempt => { attempts.push(attempt); },
        });
        hook.params.promptStore.setPrompt('Keep this launch draft');
        const locks = installWebLockManagerMock();
        const request = navigator.locks.request.bind(navigator.locks);
        let changed = false;
        const lockSpy = vi.spyOn(navigator.locks, 'request').mockImplementation(async (name, options, callback) => {
            const result = await request(name, options, callback);
            const state = readSpawnAttemptCustodyState(scope);
            if (!changed && name.startsWith('happier:session-spawn-attempts-v2:')
                && state.status === 'valid' && Object.values(state.attempts).some(attempt => attempt.submissionState === 'submitted')) {
                changed = true;
                expect(attempts.at(-1)).toMatchObject({ status: 'spawning', createdSessionId: null });
                expect(hook.params.setIsCreating).toHaveBeenLastCalledWith(true);
                expect(spawnRequests).toEqual([]);
                if (change === 'refresh') {
                    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', tokenEpoch: 0, jti: 'refreshed',
                        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
                    })).toString('base64url')}.signature`;
                    expect(await TokenStorage.setCredentialsForServerUrl('https://session-pane.test', { serverId: runtime.serverId }, { token })).toBe(true);
                } else {
                    await TokenStorage.removeCredentialsForServerUrl('https://session-pane.test', { serverId: runtime.serverId });
                }
            }
            return result;
        });
        const alert = vi.mocked(Modal.alert);
        alert.mockClear();
        // A wrongly admitted request still settles; it cannot leave this regression hanging.
        spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
        try {
            await act(async () => { await startCreation(hook, { onAfterCreatedSettled: value => { settlements.push(value); } }); });
            expect(changed).toBe(true);
            expect({ dispatches: spawnRequests.length, attempt: attempts.at(-1)?.status ?? null,
                creating: vi.mocked(hook.params.setIsCreating).mock.calls.at(-1)?.[0] }).toEqual({
                dispatches: change === 'refresh' ? 1 : 0, attempt: null, creating: false,
            });
            const custody = readSpawnAttemptCustodyState(scope);
            if (change === 'refresh') {
                expect(custody.status).toBe('valid');
                if (custody.status !== 'valid') throw new Error('Expected original Account terminal refusal');
                expect(Object.values(custody.attempts)).toEqual([expect.objectContaining({ scope,
                    createdSessionId: null, terminalResult: { type: 'error', code: 'target_unavailable', retryable: false },
                })]);
            } else expect(custody).toEqual({ status: 'missing' });
            expect(settlements).toEqual([{ status: 'rejected' }]);
            expect(alert).toHaveBeenCalled();
            expect(hook.params.promptStore.getPrompt()).toBe('Keep this launch draft');
        } finally {
            alert.mockClear(); lockSpy.mockRestore(); locks.restore(); await hook.unmount();
        }
    });
    it.each(['Send and start another', 'Start another pressed during launch'] as const)('keeps launching behind a fresh draft after %s', async (entry) => {
        const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        const { readSpawnAttemptCustodyState } = await import('@/sync/domains/session/spawn/spawnAttemptNonceStore');
        const { newSessionBackgroundLaunches } = await import('../modules/newSessionBackgroundLaunches');
        const { Modal } = await import('@/modal');
        newSessionBackgroundLaunches.resetForTests();
        const onStartAnother = vi.fn();
        const inputs = await readCurrentProjection();
        const hook = await mount(inputs, false, { onStartAnother });
        spawnOperationTerminal = createDeferred<void>();
        const locks = installWebLockManagerMock();
        const request = navigator.locks.request.bind(navigator.locks);
        const custodyReached = createDeferred<void>();
        const releaseCustody = createDeferred<void>();
        let reached = false;
        const lockSpy = vi.spyOn(navigator.locks, 'request').mockImplementation(async (name, options, callback) => {
            const result = await request(name, options, callback);
            const custody = readSpawnAttemptCustodyState({ serverId: runtime.serverId, accountId: 'account-a' });
            if (!reached && name.startsWith('happier:session-spawn-attempts-v2:') && custody.status === 'valid'
                && Object.values(custody.attempts).some(attempt => attempt.submissionState === 'submitted')) {
                reached = true;
                expect(spawnRequests).toEqual([]);
                custodyReached.resolve();
                await releaseCustody.promise;
            }
            return result;
        });
        const alert = vi.mocked(Modal.alert);
        alert.mockClear();
        let send: Promise<void> | undefined;
        try {
            await act(async () => {
                send = startCreation(hook, { initialMessage: 'skip',
                    ...(entry === 'Send and start another' ? { afterSend: 'startAnother' as const } : {}) });
            });
            if (entry === 'Start another pressed during launch') hook.getCurrent().handOffLaunchToBackground();
            await custodyReached.promise;
            if (entry === 'Send and start another') {
                expect(onStartAnother).not.toHaveBeenCalled();
                expect(newSessionBackgroundLaunches.read().starting).toBe(0);
                releaseCustody.resolve();
                spawnResult.resolve({ type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                    operation: { serverId: runtime.serverId, machineId: 'm1', operationId: 'r71-accepted-launch' } });
                await vi.waitFor(() => expect(onStartAnother).toHaveBeenCalledTimes(1));
            }
            expect(newSessionBackgroundLaunches.read().starting).toBe(1);
            await hook.unmount();
            releaseCustody.resolve();
            spawnResult.resolve({ type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                operation: { serverId: runtime.serverId, machineId: 'm1', operationId: 'r71-accepted-launch' } });
            spawnOperationTerminal.resolve();
            await act(async () => { await send; });
            expect(spawnRequests).toHaveLength(1);
            expect(alert).not.toHaveBeenCalled();
            expect(newSessionBackgroundLaunches.read()).toEqual({
                starting: 0,
                latest: expect.objectContaining({ kind: 'failed', message: expect.any(String) }),
            });
        } finally {
            releaseCustody.resolve();
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            spawnOperationTerminal.resolve();
            await send;
            lockSpy.mockRestore();
            locks.restore();
            await hook.unmount();
            newSessionBackgroundLaunches.resetForTests();
        }
    });

    it.each(['Send and start another', 'Start another during preparation', 'refused Send'] as const)(
        'keeps a ready Connected Account launch and its draft continuous after %s', async entry => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { applyConnectedAccountCatalogSnapshot, getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        const { useNewSessionConnectedServices } = await import('../modules/useNewSessionConnectedServices');
        const { newSessionBackgroundLaunches } = await import('../modules/newSessionBackgroundLaunches');
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { buildNewSessionAuthoringDraftFromPersistedDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const inputs = await readCurrentProjection();
        const declarations = inputs?.mergedProviderProjectionById[agentId]?.connectedAccounts;
        if (!declarations) throw new Error('Expected projected Connected Account purpose');
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
            record: { key: 'purposes', value: { v: 1, bindings: [] } } }, true);
        const draftId = `r71-connected-handoff-${entry}`;
        const instructionsDraft = { title: 'Launch instructions', markdown: 'Keep the submitted choices.' };
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: 'Keep the submitted prompt', instructionsDraft, selectedMachineId: 'm1', selectedPath: '/tmp',
            targetServerId: runtime.serverId, selectedProfileId: null, selectedSecretId: null,
            agentType: agentId, agentTarget, permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        if (!draft) throw new Error('Expected submitted handoff draft');
        if (entry === 'Start another during preparation') {
            instructionsCreateGate = createDeferred<void>();
            instructionsCreateReached = createDeferred<void>();
        }
        newSessionBackgroundLaunches.resetForTests();
        let hook: Awaited<ReturnType<typeof mount>>;
        let unmount: Promise<void> | undefined;
        const onStartAnother = vi.fn(() => { unmount = hook.unmount(); });
        hook = await mount(inputs, false, { draftId, onStartAnother,
            promptStore: createNewSessionPromptStore(draft.input),
            authoringDraft: buildNewSessionAuthoringDraftFromPersistedDraft(draft),
            getInstructionsDraft: () => instructionsDraft,
        }, params => {
            const connected = useNewSessionConnectedServices({
                agentCore: null, defaultAuthAgentId: agentId, defaultAuthConsumer: identity, connectedAccounts: declarations,
                agentOptionState: null, settings: storage.getState().settings,
                targetServerId: runtime.serverId, router: params.router, setAgentOptionStateForCurrentAgent() {},
            });
            return { ...params, requireConnectedAccountDefaultsReady: connected.requireConnectedAccountDefaultsReady };
        });
        if (entry === 'refused Send') spawnResult.resolve({ type: 'error', code: 'permission_denied', retryable: false });
        else {
            spawnOperationTerminal = createDeferred<void>();
            spawnResult.resolve({ type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                operation: { serverId: runtime.serverId, machineId: 'm1', operationId: 'r71-accepted-launch' } });
        }
        let send: Promise<void> | undefined;
        try {
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip',
                afterSend: entry === 'Start another during preparation' ? 'open' : 'startAnother' }); });
            if (entry === 'Start another during preparation') {
                await instructionsCreateReached?.promise;
                hook.getCurrent().handOffLaunchToBackground();
                await hook.unmount();
                instructionsCreateGate?.resolve();
            }
            if (entry === 'Send and start another') await vi.waitFor(() => expect(onStartAnother).toHaveBeenCalledTimes(1));
            spawnOperationTerminal?.resolve();
            await act(async () => { await send; });
            await unmount;
            expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'ready' });
            expect(spawnRequests).toHaveLength(1);
            expect(onStartAnother).toHaveBeenCalledTimes(entry === 'Send and start another' ? 1 : 0);
            if (entry === 'refused Send') {
                expect(hook.params.promptStore.getPrompt()).toBe(draft.input);
                expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                    input: draft.input, selectedMachineId: 'm1', agentType: draft.agentType, agentTarget,
                });
                expect(newSessionBackgroundLaunches.read()).toEqual({ starting: 0, latest: null });
            } else expect(newSessionBackgroundLaunches.read()).toMatchObject({ starting: 0, latest: { kind: 'failed' } });
        } finally {
            instructionsCreateGate?.resolve();
            spawnOperationTerminal?.resolve();
            await send;
            await hook.unmount();
            newSessionBackgroundLaunches.resetForTests();
        }
    });

    it('keeps a retained managed draft readable before its Account scope and operation hydrate', async () => {
        const selection = await createManagedDraft();
        const hook = await mount(null, false, {
            managedMachineSelection: selection,
            managedMachineAcquisition: { requestId: 'retained-send', selection: selection.selection,
                managedId: 'paid', operation: { operationId: 'not-yet-hydrated' } },
            draftScope: undefined, targetAccountScope: undefined,
        });
        try {
            expect(hook.getCurrent().managedMachineCreationProgress).toEqual({ kind: 'idle' });
            expect(managedAcquireRequests).toEqual([]);
            expect(spawnRequests).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('sends the reopened connected selection after configuration seeding and a controlled editor change', async () => {
        const inputs = await readCurrentProjection();
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const targetKey = `agent:${agentId}`;
        const serviceId = 'acme.review/auth';
        const { ConnectedServiceBindingsV2Schema } = await import('@happier-dev/protocol/connect/connected-service-bindings');
        const { buildNewSessionConfigurationDraft } = await import('@/components/sessions/authoring/draft/sessionConfigurationSeed');
        const { seedNewSessionDraftV1 } = await import('../newSessionDraftSeed');
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests, flushSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { buildNewSessionAuthoringDraftFromPersistedDraft, buildNewSessionAuthoringDraftFromResolvedInputs,
            buildNewSessionTempDataFromAuthoringDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const { useNewSessionConnectedServicesAgentOptions } = await import('./screenModel/useNewSessionConnectedServicesAgentOptions');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const declarations = inputs?.mergedProviderProjectionById[agentId]?.connectedAccounts;
        if (!declarations) throw new Error('Expected admitted Machine Agent declarations');
        storage.setState({ profile: AccountProfileSchema.parse({ id: scope.accountId,
            connectedAccountsV4: ['seed-account', 'editor-account'].map(accountId => ({
                revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
                ref: { service: connectedAccountDeclaration.service, accountId }, status: 'connected',
                authenticationModeId: 'manual', configurationReady: true, configurationRevision: null,
                kind: 'token', scopes: [], displayName: accountId,
            })),
        }) });
        const seededBindings = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
            [serviceId]: { source: 'connected', selection: 'profile', profileId: 'seed-account' },
        } });
        // Configuration handoffs share this producer with existing-Session seeding;
        // installed Agent identity comes from authored targets, not arbitrary metadata.
        const configuration = buildNewSessionTempDataFromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromResolvedInputs({
                directory: '/tmp', prompt: '', agentTarget,
                connectedServices: SessionAuthoringValueV1Schema.shape.connectedServices.parse(seededBindings),
            }), machineId: 'm1',
        });
        const draftId = seedNewSessionDraftV1({ scope, createDraftId: () => '6bf41279-7890-4da1-b94a-037a176c1975',
            seed: { prompt: { text: 'Keep my connected selection', mode: 'replace' },
                placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'm1', directory: '/tmp' } },
            configurationDraft: buildNewSessionConfigurationDraft(configuration),
        });
        if (!draftId) throw new Error('Expected seeded draft');
        const seeded = readNewSessionDraftFromRepository({ scope, draftId });
        if (!seeded) throw new Error('Expected repository seed');
        expect(ConnectedServiceBindingsV2Schema.parse(seeded.backendNewSessionOptionStateByTargetKey?.[targetKey]?.connectedServices)).toEqual(seededBindings);
        const editor = await renderHook(() => {
            const [options, setOptions] = React.useState(seeded.backendNewSessionOptionStateByTargetKey ?? {});
            return { options, ...useNewSessionConnectedServicesAgentOptions({
                runtimeCarrierAgentId: agentId, selectedMachineId: 'm1', targetServerId: runtime.serverId,
                selectedBackendTargetKey: targetKey, connectedAccounts: declarations, agentIdentity: identity,
                agentOptionState: options[targetKey] ?? null, settings: storage.getState().settings,
                router: { push() {} }, setBackendNewSessionOptionStateByTargetKey: setOptions,
            }) };
        }, { wrapper: runtime.Wrapper });
        let sendHook: Awaited<ReturnType<typeof mount>> | undefined;
        let reopenedEditor: { unmount: () => Promise<void> } | undefined;
        try {
            expect(editor.getCurrent().connectedServicesBindingsPayload).toEqual(seededBindings);
            const popover = editor.getCurrent().connectedServicesAuthChip?.collapsedContentPopover;
            if (!popover || typeof popover.renderContent !== 'function') throw new Error('Expected real connected selection popover');
            const selection = popover.renderContent({ requestClose() {}, maxHeight: 420 }) as React.ReactElement<NewSessionConnectedServicesSelectionContentProps>;
            await act(async () => { await selection.props.setBindingForService(serviceId,
                { source: 'connected', selection: 'profile', profileId: 'editor-account' }); });
            const editedBindings = ConnectedServiceBindingsV2Schema.parse(editor.getCurrent().connectedServicesBindingsPayload);
            expect(editedBindings.bindingsByServiceId[serviceId]).toEqual({ source: 'connected', selection: 'profile', profileId: 'editor-account' });
            writeNewSessionDraftToRepository({ scope, draftId, draft: { ...seeded,
                backendNewSessionOptionStateByTargetKey: editor.getCurrent().options } });
            await flushSessionDraft({ scope, address: { kind: 'newSession', draftId } });
            resetSessionDraftRepositoryForTests();
            const reopened = readNewSessionDraftFromRepository({ scope, draftId });
            if (!reopened) throw new Error('Expected retained editor draft');
            const authoringDraft = buildNewSessionAuthoringDraftFromPersistedDraft(reopened);
            expect(ConnectedServiceBindingsV2Schema.parse(authoringDraft.connectedServices)).toEqual(editedBindings);
            const recoveredOptions = reopened.backendNewSessionOptionStateByTargetKey ?? {};
            const recovered = await renderHook(() => useNewSessionConnectedServicesAgentOptions({
                runtimeCarrierAgentId: agentId, selectedMachineId: 'm1', targetServerId: runtime.serverId,
                selectedBackendTargetKey: targetKey, connectedAccounts: declarations, agentIdentity: identity,
                agentOptionState: recoveredOptions[targetKey] ?? null, settings: storage.getState().settings,
                router: { push() {} }, setBackendNewSessionOptionStateByTargetKey() {},
            }), { wrapper: runtime.Wrapper });
            reopenedEditor = recovered;
            expect(recovered.getCurrent().connectedServicesBindingsPayload).toEqual(editedBindings);
            expect(recovered.getCurrent().agentNewSessionOptions).toMatchObject({ connectedServices: editedBindings });
            sendHook = await mount(inputs, false, { authoringDraft,
                agentNewSessionOptions: recovered.getCurrent().agentNewSessionOptions,
                promptStore: createNewSessionPromptStore(reopened.input),
                requireConnectedAccountDefaultsReady: recovered.getCurrent().requireConnectedAccountDefaultsReady,
            });
            let send: Promise<void> | undefined;
            await act(async () => { send = startCreation(sendHook!, { initialMessage: 'skip' }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            // The transport parses the real Send producer with the daemon's exact strict schema.
            expect(spawnRequests[0]).toMatchObject({ agentTarget, connectedServices: editedBindings,
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' } });
            spawnResult.resolve(SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'created-session',
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } }));
            await act(async () => { await send; });
        } finally {
            await sendHook?.unmount();
            await reopenedEditor?.unmount();
            await editor.unmount();
            resetSessionDraftRepositoryForTests();
        }
    });
    it('submits the authored Session continuation to managed admission before acquiring a fresh target', async () => {
        const selection = await createManagedDraft();
        managedActionHttp = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-pane.test',
            serverIdentityId: runtime.serverIdentityId, accountId: 'account-a', machineId: 'controller',
            installationId: 'installation', actionId: 'machines.managed.acquire', tokenEpoch: 0,
            execute: input => { managedAcquireRequests.push(input); return null; },
            failure: () => ({ errorCode: 'policy_denied_field', error: 'policy_denied_field' }),
        });
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
    it.each(['approve', 'decline', 'cancel', 'establish'] as const)('continues the Composer requester enrollment question through the real managed Action (%s)', async decision => {
        const { Modal } = await import('@/modal');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
        const { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
            projectExternalActionManagedAdmissionV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
        const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
        const { ManagedInstallationResponseV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
        const { createDelegatedManagedPresetFixture } = await import('@/dev/testkit/fixtures/machineProvisionerFixtures');
        const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        const nacl = (await import('tweetnacl')).default;
        const ordinary = await createManagedDraft();
        const installationPublicKey = encodeBase64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6)).publicKey, 'base64url');
        const preset = createDelegatedManagedPresetFixture({ preset: { id: 'team-preset', homeId: runtime.serverIdentityId,
            revision: 1, name: 'Team sandbox', owner: { kind: 'team', teamId: 'team' }, launch: ordinary.receipt.launch,
            controller: ordinary.receipt.controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            custodianAccountId: 'company', installationPublicKey, descriptor: { id: 'native', title: 'Compute', icon: 'server',
                resourceKind: 'VM', schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
                resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
                billing: ordinary.receipt.billing, retention: ordinary.receipt.retentionCapabilities,
                actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
            } });
        if (preset.delegatedAcquire?.kind !== 'ready') throw new Error('Expected delegated preset projection');
        const selection = { ...ordinary, selection: { kind: 'preset' as const, homeId: runtime.serverIdentityId,
            id: preset.id, revision: preset.revision }, receipt: preset.delegatedAcquire.reviewedFacts,
            enrollmentIdentity: decision === 'establish'
                ? { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const, role: 'server' as const,
                    adminAccessAtCreation: 'ask' as const, administrator: { username: 'operator' } }
                : { kind: 'guestProcess' as const, role: 'sandbox' as const } };
        managedMachine = { id: 'requester-paid', homeId: runtime.serverIdentityId,
            custodianAccountId: 'company', enrollmentAccountId: 'account-a', launch: ordinary.receipt.launch,
            controller: ordinary.receipt.controller,
            controllerAccess: { custodian: { accountId: 'company' }, installationPublicKey },
            allocation: 'bound', resource: { contributionRef: ordinary.receipt.launch.provider, schemaVersion: 1,
                value: { nativeId: 'requester-native' } }, creationState: 'active', desired: 'start', desiredWhen: 'now',
            intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const row = managedMachine;
        const secret = 'correct-horse-battery-staple';
        const question = decision === 'establish'
            ? { kind: 'administrator.establish' as const, promptId: 'administrator-prompt', administratorUsername: 'operator',
                message: 'Your new administrator password passes through setup.' }
            : { kind: 'auth.approveRemoteProvisioning' as const, message: 'Sign this guest into your Account?' };
        const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'requester-install', revision: 1,
            actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'account-a', machineId: 'controller' },
            title: 'Create Team sandbox', createdAt: 1, startedAt: 1, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: row.id, controller: row.controller, resource: row.resource,
                bootstrapTask: { id: 'requester-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt: question } } });
        let answer: boolean | undefined;
        const operationReads: unknown[] = [];
        const taskResponses: ReturnType<typeof ManagedInstallationResponseV1Schema.parse>[] = [];
        const pairingApprovals: unknown[] = [];
        const controllerReads: string[] = [];
        const consentRequests: string[] = [];
        const guest = nacl.box.keyPair();
        managedConsentHttp = async (path, init) => {
            consentRequests.push(path);
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => {
                if (id === row.controller.machineId) {
                    controllerReads.push(path);
                    return null;
                }
                return createPlainMachineRowFixture({ id, accountId: 'account-a' });
            });
            if (path === '/v1/machines/presets/get') return Response.json({ kind: 'found', preset });
            if (path === '/v1/actions/action.operations.get/execution-authorization'
                || path === '/v1/actions/machines.managed.acquire/execution-authorization') {
                const actionId = path.includes('machines.managed.acquire') ? 'machines.managed.acquire' : 'action.operations.get';
                const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const managedAdmission = envelope.v === 1
                    ? projectExternalActionManagedAdmissionV1(actionId, envelope.input) : envelope.managedAdmission;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'exact-resource-root', binding: {
                    serverIdentityId: row.homeId, accountId: 'account-a', authentication: { kind: 'account', tokenEpoch: 0 },
                    machineId: row.controller.machineId, installationId: row.controller.installationId, custodianAccountId: 'company',
                    accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId,
                    target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    ...(actionId === 'action.operations.get' ? { managedAdmission } : {}),
                } }));
            }
            if (path === '/v1/actions/machines.managed.acquire') {
                const body: unknown = JSON.parse(String(init?.body));
                if (!body || typeof body !== 'object' || !('envelope' in body)) throw new Error('Expected signed acquire');
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body.envelope);
                managedAcquireRequests.push(envelope);
                return Response.json({ v: 1, actionId: 'machines.managed.acquire', requestId: envelope.requestId,
                    execution: { ok: true, result: { managedId: row.id, operation: { operationId: operation.operationId } } } });
            }
            if (path === '/v1/actions/action.operations.get') {
                const body: unknown = JSON.parse(String(init?.body));
                if (!body || typeof body !== 'object' || !('envelope' in body)) throw new Error('Expected signed operation read');
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body.envelope);
                operationReads.push(envelope.input);
                if (answer === true) managedMachine = { ...row, enrolledMachineId: 'm1' };
                return Response.json({ v: 1, actionId: 'action.operations.get', requestId: envelope.requestId,
                    execution: { ok: true, result: { kind: 'found', operation: answer === undefined ? operation
                        : { ...operation, revision: 2, state: answer ? 'succeeded' : 'cancelled', settledAt: 2 } } } });
            }
            if (path === '/v1/auth/request/status') return Response.json({ status: 'pending', supportsV2: true });
            if (path === '/v1/auth/response') {
                pairingApprovals.push(JSON.parse(String(init?.body)));
                return Response.json({ success: true });
            }
            if (path === '/v1/machines/controller' || path === '/v1/machines/controller/access') {
                controllerReads.push(path);
                return Response.json({}, { status: 403 });
            }
            return null;
        };
        managedConsentRpc = async (method, params) => {
            if (method !== RPC_METHODS.CAPABILITIES_INVOKE) return null;
            if (!params || typeof params !== 'object' || !('params' in params)) throw new Error('Expected managed task response');
            const response = ManagedInstallationResponseV1Schema.parse(params.params);
            taskResponses.push(response);
            if (response.delivery) return { ok: true, result: { ok: true, result: {
                publicKey: encodeBase64(guest.publicKey), homeServerIdentityId: row.homeId,
                enrollmentAccountId: 'account-a', supportsTokenOnly: true, pairingRequirement: 'v3',
                pairing: { secretB64Url: encodeBase64(new Uint8Array(32).fill(9), 'base64url'),
                    createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 },
            } } };
            if (response.answer && typeof response.answer === 'object' && 'password' in response.answer
                && typeof response.answer.password === 'string') answer = true;
            else if (!response.answer || typeof response.answer !== 'object' || !('approved' in response.answer)
                || typeof response.answer.approved !== 'boolean') throw new Error('Expected the human enrollment answer');
            else answer = response.answer.approved;
            return { ok: true, result: { ok: true, result: { ok: true } } };
        };
        const confirmation = createDeferred<boolean>();
        const secretPrompt = createDeferred<string | null>();
        if (decision === 'establish') vi.mocked(Modal.prompt).mockReturnValueOnce(secretPrompt.promise);
        else vi.mocked(Modal.confirm).mockReturnValueOnce(confirmation.promise);
        const enrolled = vi.fn();
        let hook: Awaited<ReturnType<typeof mount>>;
        hook = await mount(await readCurrentProjection(), false, {
            managedMachineSelection: selection, managedMachineAcquisition: null, selectedMachineId: null, selectedMachine: null,
            authoringDraft: buildNewSessionAuthoringDraftFromResolvedInputs({ directory: '/tmp', prompt: 'Do the submitted work',
                agentTarget, connectedServices: null }),
            onManagedMachineAcquisitionChange: () => {}, onManagedMachineEnrolled: async machineId => {
                enrolled(machineId);
                await hook.rerender({ ...hook.params, selectedMachineId: machineId, selectedMachine: createMachineFixture({ id: machineId }) });
            },
        });
        let send: Promise<void> | undefined;
        try {
            expect(storage.getState().machines.controller).toBeUndefined();
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip' }); });
            if (decision === 'establish') await vi.waitFor(() => expect(vi.mocked(Modal.prompt), JSON.stringify({
                progress: hook.getCurrent().managedMachineCreationProgress, consentRequests,
            })).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('operator'), expect.objectContaining({ inputType: 'secure-text' })));
            else await vi.waitFor(() => expect(vi.mocked(Modal.confirm), JSON.stringify({
                progress: hook.getCurrent().managedMachineCreationProgress, consentRequests,
            })).toHaveBeenCalledWith(question.message, undefined, expect.any(Object)));
            expect(hook.getCurrent().managedMachineCreationProgress).toMatchObject({ kind: 'acquiring' });
            // Private delivery selects whether an admitted Create already supplies consent.
            expect(taskResponses).toEqual(decision === 'establish' ? [] : [expect.objectContaining({ delivery: { kind: 'terminalPairing' } })]);
            if (decision === 'cancel') await act(async () => { hook.getCurrent().cancelManagedMachineCreation(); });
            if (decision === 'establish') secretPrompt.resolve(secret);
            else confirmation.resolve(decision !== 'decline');
            if (decision === 'approve' || decision === 'establish') {
                await vi.waitFor(() => expect(spawnRequests, JSON.stringify({
                    progress: hook.getCurrent().managedMachineCreationProgress, taskResponseCount: taskResponses.length,
                    pairingApprovalCount: pairingApprovals.length, operationReadCount: operationReads.length,
                })).toHaveLength(1));
                expect(enrolled).toHaveBeenCalledWith('m1');
                expect(spawnRequests[0]?.executionTarget).toEqual({ serverId: runtime.serverId, machineId: 'm1' });
                expect(pairingApprovals).toEqual(decision === 'approve' ? [expect.objectContaining({ responseKind: 'tokenOnly' })] : []);
            } else {
                await act(async () => { await send; });
                expect(enrolled).not.toHaveBeenCalled();
                expect(spawnRequests).toEqual([]);
                expect(pairingApprovals).toEqual([]);
            }
            expect(operationReads).toEqual(Array.from({ length: decision === 'cancel' ? 1 : 2 }, () => expect.objectContaining({
                managed: { homeId: row.homeId, managedId: row.id }, operationId: operation.operationId,
                waitForTerminal: true, includeManagedPrompt: true,
            })));
            expect(taskResponses).toEqual([
                ...(decision !== 'establish' ? [expect.objectContaining({ delivery: { kind: 'terminalPairing' } })] : []),
                ...(decision === 'cancel' ? [] : [
                expect.objectContaining({ homeId: row.homeId, managedId: row.id, operationId: operation.operationId,
                    taskId: 'requester-task', controller: row.controller, resource: row.resource, expectedIntentRevision: 1,
                    expectedPromptKind: question.kind, ...(decision === 'establish'
                        ? { expectedPromptId: 'administrator-prompt', answer: { password: secret } } : { answer: { approved: decision === 'approve' } }) }),
                ]),
            ]);
            // The secret travels only in the one answer: never in progress, requests, approvals or logs, and no controller grant exists.
            expect(JSON.stringify([hook.getCurrent().managedMachineCreationProgress, consentRequests, pairingApprovals])).not.toContain(secret);
            if (decision === 'decline') expect(hook.getCurrent().managedMachineCreationProgress)
                .toMatchObject({ kind: 'failed', code: 'creation_canceled' });
            expect(controllerReads).toEqual([]);
            expect(managedAcquireRequests).toHaveLength(1);
            expect(managedAcquireRequests[0]).toMatchObject({ target: { kind: 'machine', machineId: row.controller.machineId },
                input: { selection: selection.selection, enrollmentIdentity: selection.enrollmentIdentity } });
        } finally {
            hook.getCurrent().cancelManagedMachineCreation();
            confirmation.resolve(false);
            secretPrompt.resolve(null);
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => { await send; });
            await hook.unmount();
        }
    });
    it('retires acknowledged failed-setup Delete custody without sending the held prompt or replaying its request', async () => {
        const selection = await createManagedDraft();
        managedMachine = { id: 'delete-paid', homeId: runtime.serverIdentityId, custodianAccountId: 'account-a',
            launch: selection.receipt.launch, controller: selection.receipt.controller, enrolledMachineId: 'm1', allocation: 'bound',
            resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: { nativeId: 'retained-native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
            preset: { id: 'preset', revision: 1 }, machineSetup: { setup: { scripts: [{ body: 'echo setup' }] },
                state: 'failed', errorCode: 'setup_failed' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        managedDeleteSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.delete': ['ui'] } });
        managedActionHttp = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-pane.test',
            serverIdentityId: runtime.serverIdentityId, accountId: 'account-a', machineId: 'controller',
            installationId: 'installation', actionId: 'machines.managed.delete', tokenEpoch: 0,
            execute: (input, context) => {
                managedDeleteRequests.push({ actionId: 'machines.managed.delete', target: context.target, input });
                return { kind: 'accepted', managedId: 'delete-paid', intentRevision: 5, operation: { operationId: 'delete' },
                    machineReferences: { homeId: runtime.serverIdentityId, machineId: 'm1', coverage: 'complete', references: [], unavailable: [] } };
            },
        });
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
    it.each(['before Send', 'during launch preparation'] as const)('retains the authored draft and refuses spawn when inherited purpose authority withdraws %s', async phase => {
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
        const attempts: NewSessionLaunchAttempt[] = [];
        const hook = await mount(inputs, false, { ...params,
            // An enrolled managed guest is an ordinary shared Machine target,
            // with no new-machine selection or acquisition continuation.
            selectedMachine: createMachineFixture({ id: 'm1', isShared: true, access: {
                custodian: { accountId: 'guest-owner', displayName: 'Guest owner' },
                role: 'use', resourceMode: 'plain', accessState: 'ready',
            } }),
            managedMachineSelection: null, managedMachineAcquisition: null,
            onLaunchAttemptChange: attempt => {
                if (!attempt) return;
                attempts.push(attempt);
                if (phase === 'during launch preparation' && attempt.status === 'idle') {
                    applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
                }
            },
        });
        hook.params.promptStore.setPrompt('Keep this authored work');
        const settlements: unknown[] = [];
        try {
            expect(defaults.getCurrent().connectedAccountDefaultsStatus).toBe('ready');
            // A forbidden dispatch still settles through the real public daemon
            // response, so the missing admission guard cannot hang the fixture.
            spawnResult.resolve({ type: 'error', code: 'target_unavailable', retryable: false });
            await act(async () => {
                if (phase === 'before Send') applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
                const send = hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: value => { settlements.push(value); } });
                await send;
            });
            expect(spawnRequests).toEqual([]);
            expect(settlements).toEqual([{ status: 'rejected' }]);
            expect(attempts.map(attempt => attempt.status)).not.toContain('spawning');
            expect(hook.params.setIsCreating).not.toHaveBeenLastCalledWith(true);
            expect(hook.params.promptStore.getPrompt()).toBe('Keep this authored work');
        } finally { await hook.unmount(); await defaults.unmount(); }
    });
    it.each([['keep', 'account-a'], ['stop', 'account-a'], ['delete', 'account-a'], ['stop', 'alice'], ['delete', 'alice']] as const)(
        'settles the admitted managed Bot %s Home retention with controller custodian %s before finalizing its creation draft', async (effect, custodianAccountId) => {
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
        if (effect !== 'keep') managedMachine = { ...managedMachine, creationScopeRetention: { effect } };
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
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip',
                deferAcceptedDraftClearToDocument: true,
                afterCreated: async created => {
                    expect(scopeRules.size).toBe(0);
                    expect(managedMachine?.creationScopeRetention).toEqual(effect === 'keep' ? undefined
                        : { effect, source: { kind: 'session', sessionId: created.sessionId } });
                    await hook.rerender({ ...hook.params, managedMachineSelection: null }); completedCallbacks.push(created.sessionId);
                },
                onAfterCreatedSettled: settlement => { settlements.push(settlement); } }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(spawnRequests[0]).toMatchObject({ title: 'Scoped helper', identity: initialSessionFacts,
                memoryEnabled: false, promptStack, managedCreation: { homeId: managedMachine.homeId,
                    managedId: managedMachine.id, controller: managedMachine.controller } });
            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.getState().applySessions([createSessionFixture({ id: 'created-session', serverId: runtime.serverId,
                metadata: { machineId: 'm1', path: '/tmp', host: 'test' } })]);
            // The Home birth owner attaches the accepted Session to the acquisition's retention choice.
            if (effect !== 'keep') managedMachine = { ...managedMachine, creationScopeRetention: {
                effect, source: { kind: 'session', sessionId: 'created-session' },
            } };
            spawnResult.resolve(SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'created-session',
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } }));
            // The completion callback owns its rerender act; an outer act would
            // defer its draft retirement until after the continuation checked it.
            await send;
            expect({ completedCallbacks, launchFailures, settlements }).toEqual({
                completedCallbacks: ['created-session'], launchFailures: [],
                settlements: [{ status: 'accepted', sessionId: 'created-session' }],
            });
            expect(hook.getCurrent().managedMachineCreationProgress.kind).not.toBe('failed');
        } finally { await hook.unmount(); }
    });
    // JOURNEY-UX-1107 (live, Account B): a Docked Send created its Session, but the sent draft stayed in Drafts with its
    // text, because the composer-document route left settlement to a document that had already moved on.
    it('settles a sent draft out of Drafts once its Session exists on the composer-document route', async () => {
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const draftId = '5c1f0e2a-8d4b-4c6e-9a3f-2b7d1e0c9f41';
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: { input: 'Fix the flaky test', selectedMachineId: 'm1',
            selectedPath: '/tmp', agentType: agentId, backendTarget: spawnTarget, selectedProfileId: null, selectedSecretId: null,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1 } });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('Fix the flaky test');
        const hook = await mount(await readCurrentProjection(), false, { draftScope: scope, draftId,
            promptStore: createNewSessionPromptStore('Fix the flaky test') });
        try {
            let send: Promise<void> | undefined;
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip', deferAcceptedDraftClearToDocument: true }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.getState().applySessions([createSessionFixture({ id: 'created-session', serverId: runtime.serverId,
                metadata: { machineId: 'm1', path: '/tmp', host: 'test' } })]);
            spawnResult.resolve(SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'created-session',
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } }));
            await send;
            await vi.waitFor(() => expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.materialized ?? false).toBe(false));
        } finally { await hook.unmount(); }
    });
    it('keeps post-create follow-up alive across route unmount and retires it with the captured Account', async () => {
        const hook = await mount(await readCurrentProjection(), false);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let cancelled = false;
        try {
            await act(async () => { hook.getCurrent().handleCreateSession({ initialMessage: 'skip',
                afterCreated: async created => {
                    created.signal?.addEventListener('abort', () => { cancelled = true; release.resolve(); }, { once: true });
                    entered.resolve();
                    await release.promise;
                },
            }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.getState().applySessions([createSessionFixture({ id: 'created-session', serverId: runtime.serverId,
                metadata: { machineId: 'm1', path: '/tmp', host: 'test' } })]);
            spawnResult.resolve({ type: 'success', disposition: 'created', sessionId: 'created-session',
                executionTarget: { serverId: runtime.serverId, machineId: 'm1' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } });
            await entered.promise;
            await hook.unmount();
            expect(cancelled).toBe(false);
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-b', jti: 'retired-follow-up' })).toString('base64url')}.signature`;
            await TokenStorage.setCredentialsForServerUrl('https://session-pane.test', { serverId: runtime.serverId }, { token });
            expect(cancelled).toBe(true);
        } finally { release.resolve(); await hook.unmount(); }
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
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip' }); });
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

    it('retires the selected Stop binding when the original Home Account is replaced after enrollment and before Session acceptance', async () => {
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
        const setIsCreating = vi.fn();
        const hook = await mount(await readCurrentProjection(), false, {
            managedMachineSelection: selection,
            managedMachineAcquisition: { requestId: 'credential-send', selection: selection.selection, managedId: 'credential-paid' },
            onManagedMachineAcquisitionChange: () => {}, onManagedMachineEnrolled: async () => {},
            onLaunchAttemptChange: attempt => { if (attempt) attempts.push(attempt); },
            setIsCreating,
        });
        let send: Promise<void> | undefined;
        try {
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip',
                deferAcceptedDraftClearToDocument: true,
                afterCreated: async created => { completedCallbacks.push(created.sessionId); },
                onAfterCreatedSettled: settlement => { settlements.push(settlement); },
            }); });
            await vi.waitFor(() => expect(spawnRequests).toHaveLength(1));
            expect(scopeRules.size).toBe(0);

            // The selected binding awaits the actual Session receipt. Replace the
            // Account through secure storage, without switching the
            // focused Home: only the submitted Account's credential watch retires it.
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const focusedLifetime = captureActiveServerAccountScopeLifetime();
            if (!focusedLifetime) throw new Error('Expected the original Home Account lifetime');
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-b', jti: 'replacement-bearer' })).toString('base64url')}.signature`;
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
            expect(setIsCreating).toHaveBeenLastCalledWith(false);
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
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip' }); });
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
            selectedProfileId: null, selectedSecretId: null, agentType: agentId, agentTarget,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected managed Bot draft');
        const projection = await readCurrentProjection();
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applySettingsLocal({ memoryUpkeepInNewBots: false });
        let hook: Awaited<ReturnType<typeof mount>>;
        hook = await mount(projection, false, {
            draftId, authoringDraft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened),
            managedMachineSelection: selection, managedMachineAcquisition: acquisition,
            selectedMachineId: null, selectedMachine: null,
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
            await act(async () => { send = startCreation(hook, { initialMessage: 'skip' }); });
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
            selectedProfileId: null, selectedSecretId: null, agentType: agentId, agentTarget,
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
            expect(spawnRequests[0]).not.toHaveProperty('managedCreation');
            expect(scopeRules.size).toBe(0);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ promptStack, instructionsDraft: null });
            expect(instructionsArtifacts.read(created.id)).not.toBeNull();
        } finally { await hook.unmount(); }
    });

    it.each(['open', 'startAnother'] as const)('keeps the shown prompt and launch choices after Instructions refusal with afterSend=%s', async afterSend => {
        instructionsCreateUnavailable = true;
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const draftId = 'authored-instructions-document-failed';
        const instructionsDraft = { title: 'Build helper remit', markdown: 'Preserve the project conventions.' };
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { buildNewSessionAuthoringDraftFromPersistedDraft } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: 'Keep this authored prompt', sessionName: 'Build helper', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true }, instructionsDraft,
            selectedMachineId: 'm1', selectedPath: '/tmp', targetServerId: runtime.serverId,
            selectedProfileId: null, selectedSecretId: null, agentType: agentId, agentTarget,
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected ordinary authored Bot draft');
        const onStartAnother = vi.fn();
        const promptStore = createNewSessionPromptStore(reopened.input);
        const hook = await mount(await readCurrentProjection(), false, { draftId, promptStore, onStartAnother,
            authoringDraft: buildNewSessionAuthoringDraftFromPersistedDraft(reopened), getInstructionsDraft: () => instructionsDraft });
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');
        vi.mocked(Modal.alert).mockClear();
        try {
            await act(async () => { await startCreation(hook, { afterSend }); });
            expect(spawnRequests).toEqual([]);
            expect(instructionsArtifacts.list()).toEqual([]);
            expect(onStartAnother).not.toHaveBeenCalled();
            expect(promptStore.getPrompt()).toBe('Keep this authored prompt');
            expect(vi.mocked(Modal.alert).mock.calls).toContainEqual([t('common.error'), t('bots.create.documentFailed'), undefined]);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                input: 'Keep this authored prompt', sessionName: 'Build helper', instructionsDraft,
                selectedMachineId: 'm1', selectedPath: '/tmp', agentType: reopened.agentType, agentTarget, permissionMode: 'default',
            });
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
