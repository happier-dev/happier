import '../../../../ui/sources/dev/vitestSetup';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createCliPayloadFixture } from '../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture';
import { join } from 'node:path';
import axios from 'axios';
import { PluginError } from '@happier-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema, normalizeActionsSettingsV1, createActionExecutor, deriveSessionCreationTagV1, ExternalActionExecutionAuthorizationRequestV1Schema, type ActionExecuteResult, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, AccountApiTokensListActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';

import { configuration } from '@/configuration';
import { updateSettings, writeStoredCredentialsForServerId, readStoredCredentialsForServerId, removeStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '../externalActions/approvalExecutionAuthorization';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { createDaemonSessionAccountActionExecutor } from '../agentRuntime/createDaemonSessionAccountActionExecutor';
import { dispatchManagedMachineSetup, dispatchManagedSessionStart, prepareExternalActionRequesterAccountAuthorization, projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { prepareManagedMachineSetupApplyInput, createManagedMachinePresetPreparationBindingV1 } from '@happier-dev/cli-common/machines/managed';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import nacl from 'tweetnacl';
import { SessionActionRpcOriginV1Schema, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonApprovalExecutionOriginCurrentnessFromCredentials, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { registerSessionCreationDirectoryPreflightRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { authorizeMachineRpcRequest, readMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema as ChildRequestSchema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { applyTrackedSessionTurnLifecycle } from '../sessions/applyTrackedSessionTurnLifecycle';
import { authorizeTrackedRunnerAgentDaemonServiceOperation } from '../agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { readOrCreateInstallationIdentity } from '../identity/store';
import type { TrackedSession } from '../types';
import { AccountProfileSchema, AccountSettingsSchema } from '@happier-dev/protocol';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema, resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, deriveManagedDeleteApprovalSubjectKeyV1,
    managedDeleteApprovalIndexedKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ManagedMachineFullV1Schema, ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanResultV1Schema, ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createManagedMachinePresetAcquireOverrideV1, projectManagedMachinePresetForRecipientV1,
    replaceManagedMachinePresetLaunchNameV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { createPluginContributionIdentity } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerManagedFiniteWake } from '@/rpc/handlers/managedFiniteWake';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { writeDaemonState } from '@/persistence';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveApprovalRequestExecutionInput } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { logger } from '@/ui/logger';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from '../../../../ui/sources/sync/ops/actions/actionAccountContext';
import { replayLiveCliApproval } from '../../../../ui/sources/sync/ops/actions/liveCliApprovalReplay';
import { buildUpdateArtifactUpdate } from '../../../../server/sources/app/events/artifactEventPayloadBuilders';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import type { RpcHandler } from '@/api/rpc/types';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, parseExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ManagedPendingActivationFailureRequestV1Schema, PendingActivationAuthorizationV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CUA_PLUGIN } from '../../../../../packages/plugins/machine-cua/src/manifest';
import { CuaLocalLaunchV1Schema } from '../../../../../packages/plugins/machine-cua/src/machine/schemas';
import { projectMachineProvisionerSelectionV1, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import { createMachineProvisionerSpecializedPreparationAuthorFixture } from '../../../../../packages/plugin-sdk/fixtures/authoring-inference/machineProvisioners';

import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';

import { ManagedMachinePresetV1Schema, ManagedMachinePresetUpdateInputV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';

import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';

const approvalWire = vi.hoisted(() => ({ sockets: [] as Array<{ update(value: unknown): void }>,
    registrations: new Map<string, { deliver(packet: unknown, acknowledge: (value: unknown) => void): void }>(),
}));
vi.mock('socket.io-client', async importOriginal => (
    await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const approvingHomes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(approvingHomes);
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    approvalWire.sockets.push({ update: value => { for (const listener of socket.listeners('update')) listener(value); } });
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emit').mockImplementation((event, payload) => {
        if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
            if (event === SOCKET_RPC_EVENTS.REGISTER) {
                approvalWire.registrations.set(payload.method, { deliver(packet, acknowledge) {
                    for (const listener of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) listener(packet, acknowledge);
                } });
                for (const listener of socket.listeners(SOCKET_RPC_EVENTS.REGISTERED)) listener(payload);
            } else if (event === SOCKET_RPC_EVENTS.UNREGISTER) approvalWire.registrations.delete(payload.method);
        }
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { ok: true };
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') throw new Error('Missing actual UI RPC packet');
        const receiver = approvalWire.registrations.get(payload.method);
        if (!receiver) return { ok: false, error: 'RPC method not found', errorCode: 'method_not_found' };
        // Home relay is the network boundary. Actual Account UI admission,
        // RPC parsing, live origin decision and native continuation stay real.
        const result = await new Promise<unknown>(resolve => receiver.deliver({ ...payload, callerAuthority: 'present_user' }, resolve));
        return { ok: true, result };
    });
});

function publishApprovalArtifactUpdate(artifact: Readonly<{
    id: string; seq: number; header: string; headerVersion: number; body: string; bodyVersion: number;
}>) {
    const update = buildUpdateArtifactUpdate(artifact.id, artifact.seq, `${artifact.id}-${artifact.seq}`,
        { value: artifact.header, version: artifact.headerVersion }, { value: artifact.body, version: artifact.bodyVersion });
    for (const socket of approvalWire.sockets) socket.update(update);
}

const serverUrl = 'https://managed-home.example';
const enrollmentIdentity = { kind: 'existingUser', role: 'adopted' } as const;
const credentials = { token: 'token', encryption: null };
const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
const authority = createManagedProviderOperationAuthority({
    materializationBaseDir: tmpdir(),
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    }),
    requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }),
});

async function storeHome(homeServerIdentityId: string) {
    await updateSettings((settings) => ({ ...settings, servers: { ...settings.servers,
        [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Managed Home',
            serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId, canonicalServerUrl: serverUrl,
                revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
        },
    } }));
}

function adapter(withAuthority = true, executeSessionStart?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['executeSessionStart'],
    preflightSessionStart?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['preflightSessionStart'],
    privateKey: string | Uint8Array = 'not-used-by-passive-discovery', accountCredentials = credentials,
    observeRecordedApprovalExecution?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['observeRecordedApprovalExecution'],
    executeEnvironmentSetup?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['executeEnvironmentSetup'],
    observeActionExecution?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['observeActionExecution'],
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry, installationId = 'installation',
    cancelAndWaitForActionOperation?: ReturnType<typeof createHostActionOperationRuntime>['runner']['cancelAndWait']) {
    // The module-loading boundary has no installed plugin. The empty catalog
    // itself is produced by the real contribution registry owner.
    const registry = { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry;
    return createDaemonManagedMachineActionAdapter({ credentials: accountCredentials, machineId: 'controller', serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
        ...(executeSessionStart ? { executeSessionStart } : {}),
        ...(preflightSessionStart ? { preflightSessionStart } : {}),
        ...(observeRecordedApprovalExecution ? { observeRecordedApprovalExecution } : {}),
        ...(executeEnvironmentSetup ? { executeEnvironmentSetup } : {}),
        ...(observeActionExecution ? { observeActionExecution } : {}),
        ...(cancelAndWaitForActionOperation ? { cancelAndWaitForActionOperation } : {}),
        installationIdentity: { installationId, privateKey },
        ...(withAuthority ? { managedProviderOperationAuthority: authority } : {}),
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl, resolveCurrentMachineId: () => 'controller',
        }),
        acquireRuntimeRegistryLease: async () => ({ registry: runtimeRegistry ?? registry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
}

describe('daemon managed Machine Action factory', () => {
    it.each(['ready', 'inspected', 'cancelled', 'replaced', 'retired'] as const)('prepares a private preset beneath its original public Action (%s)', async outcome => {
        const actionId = MACHINE_PRESET_PREPARE_ACTION_ID_V1;
        const payload = await createCliPayloadFixture();
        onTestFinished(() => payload.cleanup());
        await writeFile(join(payload.payloadRoot, 'package.json'), JSON.stringify({ version: '0.3.0' }));
        vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload.payloadRoot);
        vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA', JSON.stringify({ root: payload.payloadRoot, identity: 'a'.repeat(64) }));
        vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: 'srv_home' },
                guestCli: { source: 'home-payload', line: '0.3', channel: 'publicdev' } } })));
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const accountCredentials = { token, encryption: null };
        const signing = nacl.sign.keyPair();
        const settings = AccountSettingsSchema.parse({});
        const input = { homeId: 'srv_home', id: 'prepare-preset', expectedRevision: 1, machineId: 'controller' };
        const authored = normalizePluginManifestV2(createMachineProvisionerSpecializedPreparationAuthorFixture().manifest);
        const originalProvisioner = authored.contributes.machineProvisioners[0]!;
        const manifest = outcome !== 'replaced' ? authored : normalizePluginManifestV2({ ...authored, contributes: { ...authored.contributes,
            machineProvisioners: [...authored.contributes.machineProvisioners, { ...originalProvisioner, id: 'replacement',
                preparation: { ...originalProvisioner.preparation!, actions: { build: 'prepare-build-replacement',
                    inspect: 'prepare-inspect-replacement', destroy: 'prepare-destroy-replacement' } } }],
            actions: [...authored.contributes.actions, ...authored.contributes.actions.filter(action => action.id.startsWith('prepare-'))
                .map(action => ({ ...action, id: `${action.id}-replacement` }))],
        } });
        const provider = { pluginId: manifest.id, localId: manifest.contributes.machineProvisioners[0]!.id };
        const launch = { provider, schemaVersion: 1, name: 'Prepared guest', choices: { name: 'base' } };
        let preset = ManagedMachinePresetV1Schema.parse({ id: input.id, homeId: input.homeId, revision: 1,
            owner: { kind: 'account', accountId: 'account' }, controller: { machineId: 'controller', installationId: 'installation' },
            contentEncryptionMode: 'plain', content: { t: 'plain', v: { v: 1, name: launch.name, launch,
                preparation: { enabled: true } } }, recipients: [] });
        const writes: number[] = [];
        const roots: string[] = [];
        const nativeRoles: string[] = [];
        const artifact = { contributionRef: provider, schemaVersion: 1, value: { launch: { name: 'prepared' } } };
        const replacementArtifact = { ...artifact, contributionRef: { ...provider, localId: 'replacement' } };
        if (outcome === 'replaced') {
            preset = ManagedMachinePresetV1Schema.parse({ ...preset, content: { t: 'plain', v: { v: 1,
                name: launch.name, launch: { ...launch, provider: replacementArtifact.contributionRef, choices: { name: 'replacement' } },
                preparation: { enabled: true }, prepared: { operationId: 'original-preparation', status: 'ready', artifact,
                    cliBinaryPath: '/opt/happier/cli/current/happier', binding: createManagedMachinePresetPreparationBindingV1({
                        content: { launch }, presetRevision: 1, cliIdentity: 'a'.repeat(64) }) },
            } } });
        }
        const nativeOperationRef = { contributionRef: provider, schemaVersion: 1, value: { claimId: 'prepare-operation' } };
        let releaseOriginal = () => {};
        const originalHeld = new Promise<void>(resolve => { releaseOriginal = resolve; });
        let markStopping = () => {};
        const stopping = new Promise<void>(resolve => { markStopping = resolve; });
        let builds = 0;
        let admittedInput = input;
        let markBuildStarted = () => {};
        const buildStarted = new Promise<void>(resolve => { markBuildStarted = resolve; });
        const native = nativeFixture({ fixtureManifest: manifest, credentialPurposes: [],
            actionHandlers: new Map(manifest.contributes.actions.map(action => [action.id, async body => {
                nativeRoles.push(action.id);
                if (action.id === 'options') return { base: { launch: outcome === 'replaced' ? { name: 'replacement' } : launch.choices,
                    nativeFacts: { preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' } } },
                    dimensions: { size: [], image: [], location: [], network: [], duration: [] } };
                if (action.id === 'prepare-build') {
                    expect(openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: preset.content })?.prepared)
                        .toMatchObject({ status: 'building', operationId: builds === 0 ? 'prepare-operation' : 'replacement-operation' });
                    markBuildStarted();
                    builds++;
                    if (outcome === 'retired' && builds === 1) await originalHeld;
                    return outcome === 'ready' || outcome === 'retired' ? { kind: 'ready', artifact } : { kind: 'pending', nativeOperationRef };
                }
                if (action.id === 'prepare-inspect') return outcome === 'inspected' || outcome === 'retired' ? { kind: 'ready', artifact } : { kind: 'pending', nativeOperationRef };
                if (action.id === 'prepare-destroy') {
                    expect(body).toMatchObject(outcome === 'replaced' || outcome === 'retired' ? { artifact } : { nativeOperation: nativeOperationRef });
                    return { kind: 'confirmed' };
                }
                if (action.id === 'prepare-build-replacement') {
                    expect(body).toMatchObject({ input: { launch: { choices: { name: 'replacement' } } } });
                    return { kind: 'ready', artifact: replacementArtifact };
                }
                throw new Error(`Unexpected preparation role ${action.id}`);
            }])) });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
                content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'account' }) };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
            if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({ v: 1,
                encryptionMode: 'plain', nativeEmail: null, password: { status: 'not_enrolled', revision: null } }) };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) };
            throw new Error(`Unexpected preparation GET ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/execution-authorization')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                roots.push(path);
                return { status: 200, data: { v: 1, token: 'prepare-original-root', binding: { accountId: 'account', custodianAccountId: 'account',
                    authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: 'srv_home',
                    machineId: 'controller', installationId: 'installation', actionId, presetPreparationAdmission: admittedInput, requestId: request.envelope.requestId,
                    target: { kind: 'machine', machineId: 'controller' }, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
            }
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/presets/get')) return { status: 200, data: { kind: 'found', preset } };
            if (path.endsWith('/presets/update')) {
                const mutation = ManagedMachinePresetUpdateInputV1Schema.parse(body);
                if (mutation.expectedRevision !== preset.revision) return { status: 409,
                    data: { kind: 'conflict', currentRevision: preset.revision } };
                writes.push(mutation.expectedRevision);
                preset = ManagedMachinePresetV1Schema.parse({ ...preset, ...mutation.patch, revision: preset.revision + 1 });
                return { status: 200, data: { kind: 'saved', preset } };
            }
            throw new Error(`Unexpected preparation POST ${path}`);
        });
        let operationSequence = 0;
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => operationSequence++ === 0 ? 'prepare-operation' : 'replacement-operation' });
        const managed = adapter(true, undefined, undefined, signing.secretKey, accountCredentials, undefined, undefined, undefined,
            native.runtimeRegistry, 'installation', async (...args) => {
                const result = operations.runner.cancelAndWait(...args);
                markStopping();
                return await result;
            });
        const deps = createCliActionDeps({ credentials: accountCredentials, token, sessionId: '', mode: 'plain', ctx: null,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            externalActionMachineRequestPrivateKey: signing.secretKey, externalActionMachineInstallationId: 'installation',
            actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }), machinePresetPrepare: managed.preparePreset });
        const executor = createActionExecutor({ ...deps, runActionOperation: operations.runActionOperation,
            invokeContributedAction: createCommittedContributedActionInvoker({ managedProviderOperationAuthority: authority,
                acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }) }) });
        const start = async (requestInput = input, requestId = 'prepare-request') => {
            const input = requestInput;
            admittedInput = input;
            const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId,
                target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller', accountId: 'account', accountEncryptionMode: 'plain',
                tokenEpochHint: 0, token, serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
                installationId: 'installation', privateKey: signing.secretKey });
            if (!authorization) throw new Error('Home did not admit the Prepare root');
            const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                machineId: 'controller', installationId: 'installation', installationPrivateKey: signing.secretKey,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
                ownCredentials: accountCredentials, isCurrent: async () => true, createExecutor: () => executor });
            if (!requester) throw new Error('Prepare requester custody is unavailable');
            onTestFinished(() => requester.dispose());
            const confirmation = bindPresentUserActionConfirmationV1(actionId, input, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                runtimeAccountId: 'account', actionRequestId: requestId, serverId: configuration.activeServerId,
                serverIdentityId: 'srv_home', externalActionTarget: authorization.binding.target });
            const context = { ...confirmation, externalActionExecutionAuthorization: requester.authorization,
                signExternalActionApprovalInput: (args: Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0]) =>
                    signExternalActionApprovalInputV1({ authorizationToken: authorization.token, ...args, privateKey: signing.secretKey }),
                originalActionEnvelope: { v: 1 as const, requestId, target: authorization.binding.target, input } };
            const result = await operations.observeExecution({ actionId, input, actionRequestId: requestId,
                execute: operation => executor.execute(actionId, input, { ...context, ...operation }) });
            return result;
        };
        const result = await start();
        expect(result.ok ? null : result).toBeNull();
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', operationId: 'prepare-operation' } });
        if (outcome === 'retired') {
            await buildStarted;
            const replacement = start({ ...input, expectedRevision: preset.revision }, 'replacement-request');
            try {
                expect(await Promise.race([stopping.then(() => 'stopping'), replacement.then(() => 'premature')])).toBe('stopping');
                expect(builds).toBe(1);
                expect(nativeRoles).toEqual(['options', 'prepare-build']);
            } finally {
                releaseOriginal();
            }
            expect(await replacement).toMatchObject({ ok: true, result: { status: 'accepted', operationId: 'replacement-operation' } });
            expect(await operations.handlers.getV2({ operationId: 'prepare-operation', waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
        }
        if (outcome === 'cancelled') {
            await buildStarted;
            expect(await operations.handlers.cancel({ operationId: 'prepare-operation' })).toMatchObject({ kind: 'requested' });
        }
        const terminal = await operations.handlers.getV2({ operationId: outcome === 'retired' ? 'replacement-operation' : 'prepare-operation', waitForTerminal: true });
        expect(terminal.kind === 'found' && terminal.operation.state === 'failed' ? terminal.operation.error : undefined).toBeUndefined();
        expect(terminal).toMatchObject({ kind: 'found', operation: { state: outcome === 'cancelled' ? 'cancelled' : 'succeeded' } });
        const prepared = openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: preset.content })?.prepared;
        expect(roots).toEqual(Array.from({ length: outcome === 'retired' ? 2 : 1 }, () => bindExternalActionExecutionAuthorizationHttpPathV1(actionId)));
        if (outcome === 'retired') {
            expect(prepared).toMatchObject({ status: 'ready', operationId: 'replacement-operation', artifact });
            expect(builds).toBe(2);
            expect(nativeRoles.indexOf('prepare-destroy')).toBeLessThan(nativeRoles.lastIndexOf('prepare-build'));
            return;
        }
        if (outcome !== 'cancelled') {
            expect(prepared).toMatchObject({ status: 'ready', artifact: outcome === 'replaced' ? replacementArtifact : artifact });
            expect(writes).toEqual(outcome === 'ready' ? [1, 2] : outcome === 'replaced' ? [1, 2, 3, 4] : [1, 2, 3]);
            expect(nativeRoles).toEqual(outcome === 'ready' ? ['options', 'prepare-build'] : outcome === 'replaced'
                ? ['prepare-destroy', 'options', 'prepare-build-replacement'] : ['options', 'prepare-build', 'prepare-inspect']);
        } else {
            expect(prepared).toMatchObject({ status: 'cancelled' });
            expect(prepared?.artifact).toBeUndefined();
            expect(prepared?.nativeOperationRef).toBeUndefined();
            expect(nativeRoles.filter(role => role === 'prepare-build')).toHaveLength(1);
            expect(nativeRoles.filter(role => role === 'prepare-destroy')).toHaveLength(1);
        }
    });
    it.each(['supported', 'unsupported'] as const)(
      'runs a Machine isolation preset through native Sandbox qualification (%s)', async nativeSandbox => {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const accountCredentials = { token, encryption: null };
        const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'session.spawn_new': ['cli'], 'machines.managed.acquire': ['cli'] } } });
        setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1,
            loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(accountCredentials) });
        const signing = nacl.sign.keyPair();
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Local sandbox', choices: {} };
        const content = sealManagedMachinePresetContentV1({ presetId: 'isolation-preset', mode: 'plain',
            content: { v: 1, name: launch.name, launch } });
        const preset = { id: 'isolation-preset', homeId: 'srv_home', revision: 1, owner: { kind: 'account', accountId: 'account' },
            controller, contentEncryptionMode: 'plain', ...content };
        let machine = ManagedMachineV1Schema.parse({ id: 'isolation-resource', homeId: 'srv_home', custodianAccountId: 'account',
            controller, preset: { id: preset.id, revision: 1, contentEncryptionMode: 'plain' }, acquisitionMode: 'resource-bound',
            allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const roles: string[] = [];
        const nativeInputs: unknown[] = [];
        const native = nativeFixture({ privateNative: true, credentialPurposes: [], onNativeRole: (role, input) => {
            roles.push(role);
            nativeInputs.push({ role, input });
        } });
        const registry = { ...native.runtimeRegistry, contributes: { ...native.runtimeRegistry.contributes,
            machineProvisioners: native.runtimeRegistry.contributes.machineProvisioners?.map(entry => ({ ...entry,
                definition: { ...entry.definition, sessionPlacement: { kind: 'controller-local' as const,
                    supportsAgentNativeSandbox: nativeSandbox === 'supported' } } })) } };
        // Home persistence, installed-machine RPC and native plugin effects are
        // system boundaries. Session defaults, admission, preset opening,
        // controller custody and native role qualification remain real.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (new URL(String(request.url)).pathname === '/v1/home/governance/get') return { status: 200, data: { homeDefaults: null } };
            throw new Error(`Unexpected isolation Home request ${String(request.url)}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (new URL(String(url)).pathname.endsWith('/connected-accounts/purposes')) return { status: 200,
                data: { status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes',
                    value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } } } };
            if (new URL(String(url)).pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (new URL(String(url)).pathname === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'account' }) };
            if (new URL(String(url)).pathname === '/v2/account/settings') return { status: 200,
                data: { content: { t: 'plain', v: settings }, version: 1 } };
            if (new URL(String(url)).pathname === ACCOUNT_SECURITY_PATH_V1) return { status: 200,
                data: AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: 'plain', nativeEmail: null,
                    password: { status: 'not_enrolled', revision: null } }) };
            if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) };
            throw new Error(`Unexpected isolation GET ${String(url)}`);
        });
        const isolationAdmissions: unknown[] = [];
        const isolationReports: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/execution-authorization')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                return { status: 200, data: { v: 1, token: 'isolation-root-proof', binding: { accountId: 'account', custodianAccountId: 'account',
                    authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: 'srv_home',
                    ...controller, actionId: 'session.spawn_new', requestId: request.envelope.requestId,
                    target: { kind: 'machine', machineId: 'controller' }, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
            }
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/presets/get')) return { status: 200, data: { kind: 'found', preset } };
            if (path.endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
            if (path.endsWith('/admit')) {
                isolationAdmissions.push(body);
                return { status: 200, data: { machine, presetContent: content, replayed: false } };
            }
            if (path.endsWith('/current')) return { status: 200, data: { machine, current: true } };
            if (path.endsWith('/submit')) return { status: 200, data: { machine, submitted: true } };
            if (path.endsWith('/report')) {
                isolationReports.push(body);
                const report = ManagedControllerReportV1Schema.parse(body);
                machine = ManagedMachineV1Schema.parse({ ...machine,
                    allocation: report.result.kind === 'bound' ? 'bound' : machine.allocation });
                return { status: 200, data: { machine } };
            }
            throw new Error(`Unexpected isolation POST ${path}`);
        });
        const nativeRpc = async (method: string) => {
            if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE)
                return { ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null };
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection: {
                v: 2, generation: 1, familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex',
                    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true }, nativeSandbox: { off: true } } } } } };
            if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
                installed: true, version: '1.0', latestVersion: null, update: { supported: false, command: null },
                signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
                install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] } } } };
            throw new Error(`Unexpected isolation native RPC ${method}`);
        };
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(request => nativeRpc(request.method));
        vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(request => nativeRpc(request.method));
        const managed = adapter(true, undefined, undefined, signing.secretKey, accountCredentials, undefined, undefined, undefined, registry);
        const launched: unknown[] = [];
        const isolationChildResults: unknown[] = [];
        const isolationQualifications: boolean[] = [];
        let isolationFailure: unknown;
        let nextIsolationOperationId = 0;
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => `isolation-operation-${nextIsolationOperationId++}` });
        const deps = createCliActionDeps({ credentials: accountCredentials, token, sessionId: '', mode: 'plain', ctx: null,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            externalActionMachineRequestPrivateKey: signing.secretKey, externalActionMachineInstallationId: 'installation',
            actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
            savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials: accountCredentials,
                serverHttpBaseUrl: serverUrl, isCurrent: async () => true, snapshot: { settings, settingsVersion: 1,
                    loadedAtMs: 1, settingsSecretsReadKeys: [], source: 'network', scopeKey: resolveAccountSettingsScopeKey(accountCredentials),
                    whenRefreshed: null, connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes',
                        value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } } } }),
            acquireSessionIsolationSandbox: async request => {
                try {
                    const resolveNativeSandbox = request.resolveNativeSandbox;
                    return await managed.acquireSessionIsolationSandbox({ ...request,
                        ...(resolveNativeSandbox ? { resolveNativeSandbox: supports => {
                            isolationQualifications.push(supports);
                            return resolveNativeSandbox(supports);
                        } } : {}),
                        executeSessionIsolationAcquire: async (input, context) => {
                            const result = await request.executeSessionIsolationAcquire(input, context);
                            isolationChildResults.push(result);
                            return result;
                        },
                    });
                } catch (error) {
                    isolationFailure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
                    throw error;
                }
            },
            sessionSpawnDirectTargetTransport: { machineId: 'controller', readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1,
                metadata: { isolationPolicyV1: { agentNativeSandboxEnabled: true,
                    configuredSandboxes: { local: { provisioner: launch.provider, presetId: preset.id } },
                    workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'local', lifecycle: 'fresh' },
                        botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } } } }),
                prepare: async () => ({ ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
                spawnedSession: { spawn: async request => { launched.push(request); return { type: 'success', sessionId: 'created',
                    sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } }; },
                    resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
            machineActionDirectTargetTransport: { machineId: 'controller', invoke: nativeRpc },
        });
        const executor = createActionExecutor({ ...deps, managedMachineAction: managed,
            runActionOperation: operations.runActionOperation });
        const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'isolation-spawn',
            executionTarget: { serverId: configuration.activeServerId, machineId: 'controller' }, directory: { kind: 'path', path: '/tmp' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, memoryEnabled: false,
            configuration: { mode: { value: null, updatedAtMs: 1 },
                model: { value: null, updatedAtMs: 1, selectionSource: 'inherited' },
                permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } });
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: 'session.spawn_new', input,
            requestId: 'isolation-spawn', target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller',
            accountId: 'account', accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: configuration.activeServerId,
            serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, installationId: 'installation', privateKey: signing.secretKey });
        if (!authorization) throw new Error('Home did not admit the Session isolation root');
        const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
            machineId: 'controller', installationId: 'installation', installationPrivateKey: signing.secretKey,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            ownCredentials: accountCredentials, isCurrent: async () => true, createExecutor: () => executor });
        if (!requester) throw new Error('The receiving host must open its admitted requester custody');
        onTestFinished(() => requester.dispose());
        const rootContext: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            actionsSettings: normalizeActionsSettingsV1(settings.actionsSettingsV1), runtimeAccountId: 'account', actionRequestId: 'isolation-spawn',
            serverId: configuration.activeServerId, externalActionExecutionAuthorization: requester.authorization, externalActionTarget: authorization.binding.target,
            originalActionEnvelope: { v: 1, requestId: 'isolation-spawn', target: authorization.binding.target, input } };
        const result = await operations.observeExecution({ actionId: 'session.spawn_new', input, actionRequestId: 'isolation-spawn',
            actionContext: rootContext,
            execute: operation => executor.execute('session.spawn_new', input, { ...rootContext, ...operation }) });
        // Native acquisition retains its own operation after returning acceptance.
        // The root Session's terminal result does not settle that child effect.
        const isolationChildOperation = nativeSandbox === 'supported'
            ? await operations.handlers.getV2({ operationId: 'isolation-operation-1', waitForTerminal: true })
            : undefined;
        const diagnostic = JSON.stringify({ result, isolationChildResults, isolationQualifications, isolationFailure,
            isolationAdmissions, isolationReports, isolationChildOperation, roles, launched });
        if (nativeSandbox === 'unsupported') {
            expect(result, diagnostic).toMatchObject({ ok: true, result: { type: 'error', code: 'target_unavailable',
                failureCause: { nativeErrorReason: 'not_available_in_sandbox_type' } } });
            expect(isolationAdmissions).toEqual([]);
            expect(roles).toEqual([]);
            expect(launched).toEqual([]);
            return;
        }
        expect(result, diagnostic).toMatchObject({ ok: true, result: { type: 'success' } });
        expect(await operations.handlers.getV2({ operationId: 'isolation-operation-0', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        expect(isolationChildOperation, diagnostic).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        expect(isolationAdmissions, diagnostic).toEqual([expect.objectContaining({ acquisitionMode: 'resource-bound' })]);
        expect(machine.acquisitionMode).toBe('resource-bound');
        // Bootstrap opens a transport carrier; installing a CLI or daemon would
        // also require native exec/file effects or enrollment HTTP, which the
        // real boundary recorders expose or reject.
        expect(roles, diagnostic).toEqual(['acquire', 'bootstrap']);
        expect(nativeInputs, diagnostic).toContainEqual({ role: 'bootstrap', input: { resource: {} } });
        expect(machine.enrolledMachineId).toBeUndefined();
        expect(launched).toHaveLength(1);
        expect(launched[0]).toMatchObject({ nativeSandbox: 'on' });
    });

    it.each(['spawn-child', 'release', 'ordinary'] as const)('receives %s native admission without borrowing another Account or repeating its approved effect', async kind => {
        const keys = nacl.sign.keyPair();
        const actionId = 'machines.managed.credentials.install' as const;
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const input = { homeId: 'srv_home', managedId: 'managed', sessionId: 'session', bindingKey: 'binding',
            expectedResourceRevision: 0, expectedSourceRevision: 'source', expectedProviderTicket: 'ticket',
            ...(kind === 'release' ? { operation: 'release' as const } : {}) };
        const envelope = { v: 1 as const, requestId: 'native-codec-receiver', target, input };
        const principal = { accountId: 'member', authority: 'account_automation' as const,
            authentication: { kind: 'account' as const, tokenEpoch: 1 } };
        const authorization = sealManagedControllerActionCodecV1({ authorization: ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'native-home-root', binding: { accountId: principal.accountId, authentication: principal.authentication,
                custodianAccountId: 'account', serverIdentityId: 'srv_home', machineId: target.machineId,
                installationId: 'installation', accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId,
                target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), managedAdmission: { actionId, input },
                ...(kind === 'spawn-child' ? { nativeCredentialSpawnChild: { requestId: 'approved-spawn',
                    requestEnvelopeDigest: 'a'.repeat(43) } } : {}) },
        }), material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(3) },
            invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'account_automation' },
            installationPublicKey: keys.publicKey, randomBytes: nacl.randomBytes });
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        let reads = 0;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (!String(url).endsWith('/v1/account/encryption')) throw new Error('Unexpected requester Account read');
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
            expect(config?.headers).not.toHaveProperty('Authorization');
            if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
            reads += 1;
            if (String(url).endsWith('/actions/get')) return { status: 200, data: machine };
            return { status: 200, data: { machine, requestId: 'current-creation' } };
        });
        const handlers = new Map<string, RpcHandler>();
        registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
            machineId: 'controller', currentServerId: configuration.activeServerId, currentServerHttpBaseUrl: serverUrl,
            resolveAccountId: async () => 'account', resolveInstallationId: () => 'installation',
            externalActionMachineRequestPrivateKey: keys.secretKey,
            verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                privateKey: keys.secretKey, installationId: 'installation', serverHttpBaseUrl: serverUrl }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
            executor: createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
                serverApiUrl: serverUrl, managedMachineAction: adapter(true, undefined, undefined, keys.secretKey),
                pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({
                    v: 1, actions: {},
                }) } }),
        });
        const handler = handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!;
        const request = { actionId, envelope, principal, placement: { machineId: 'controller', target }, executionAuthorization: authorization };
        const ingress = { authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal };
        const result = parseExternalActionDaemonDispatchResultV1(await handler(request, ingress));
        expect(result?.kind).toBe('response');
        if (result?.kind !== 'response') throw new Error('Expected installed native response');
        if (kind === 'ordinary') {
            expect(result.prepared.response).toMatchObject({ execution: { ok: false } });
            expect(reads).toBe(0);
            return;
        }
        expect(result.prepared.response, JSON.stringify(result.prepared.response)).toMatchObject({ execution: { ok: true,
            result: { kind: 'refused', code: 'credential_unavailable' } } });
        expect(reads).toBeGreaterThan(0);
        const before = reads;
        expect(parseExternalActionDaemonDispatchResultV1(await handler({ ...request, executionAuthorization: { ...authorization,
            requesterAccountContext: { ...authorization.requesterAccountContext!, ciphertext: 'tampered' } } }, ingress))?.kind).not.toBe('response');
        for (const substituted of [
            { ...request, envelope: { ...envelope, input: { ...input, bindingKey: 'foreign' } } },
            { ...request, executionAuthorization: { ...authorization, binding: { ...authorization.binding, installationId: 'replaced' } } },
        ]) {
            const refused = parseExternalActionDaemonDispatchResultV1(await handler(substituted, ingress));
            expect(refused?.kind !== 'response' || refused.prepared.response.v === 1 && !refused.prepared.response.execution.ok).toBe(true);
        }
        expect(reads).toBe(before);
    });

    it('serializes each native whole-policy read through the installed resource owner', async () => {
        await storeHome('srv_home');
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        let reading = 0;
        let overlapping = 0;
        let sameResourceReads = 0;
        const queuedAbort = new AbortController();
        let releaseIndependent!: () => void;
        const independent = new Promise<void>(resolve => { releaseIndependent = resolve; });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const managedId = body && typeof body === 'object' && 'managedId' in body ? body.managedId : machine.id;
            const current = managedId === 'independent' ? { ...machine, id: 'independent' } : machine;
            if (String(url).endsWith('/actions/get')) {
                if (managedId === 'independent') {
                    queuedAbort.abort();
                    releaseIndependent();
                    return { status: 200, data: current };
                }
                reading += 1;
                sameResourceReads += 1;
                overlapping = Math.max(overlapping, reading);
                await independent;
                await new Promise<void>(resolve => setImmediate(resolve));
                reading -= 1;
                return { status: 200, data: current };
            }
            return { status: 200, data: { machine: current, requestId: 'current-creation' } };
        });
        const input = { homeId: 'srv_home', managedId: machine.id, sessionId: 'session', bindingKey: 'binding',
            expectedResourceRevision: 0, expectedSourceRevision: 'source', expectedProviderTicket: 'ticket' };
        const pending = ['first', 'second'].map(actionRequestId => adapter()({
            actionId: 'machines.managed.credentials.install', input, context: { actionRequestId },
        }));
        const canceled = expect(adapter()({ actionId: 'machines.managed.credentials.install', input,
            context: { actionRequestId: 'canceled' }, signal: queuedAbort.signal })).rejects.toMatchObject({ name: 'AbortError' });
        const results = await Promise.all([...pending, adapter()({
            actionId: 'machines.managed.credentials.install', input: { ...input, managedId: 'independent' },
            context: { actionRequestId: 'independent' },
        })]);
        await canceled;
        expect(results).toEqual(Array.from({ length: 3 }, () => ({ kind: 'refused', code: 'credential_unavailable' })));
        expect(overlapping).toBe(1);
        expect(sameResourceReads).toBe(2);
    });

    it('settles a retained Delete through the ordinary untracked Inspect adapter', async () => {
        await storeHome('srv_home');
        const controller = { machineId: 'controller', installationId: 'installation' };
        let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller,
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
            submittedNativeEffect: { intent: 'delete', requestId: 'delete-request', intentRevision: 1,
                controller: { machineId: 'controller', installationId: 'installation' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const native = nativeFixture({ privateNative: true, nativeRoleResults: {
            inspect: { observedAt: 123, availability: 'absent' },
        } });
        // Home HTTP and the native provider are the boundaries; the ordinary
        // adapter, native admission, driver and operation owner stay real.
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = String(url);
            if (path.endsWith('/actions/get')) return { status: 200, data: machine };
            if (path.endsWith('/report-intent')) machine = ManagedMachineV1Schema.parse({ ...machine,
                allocation: 'confirmed-absent', observation: { observedAt: 123, availability: 'absent' }, submittedNativeEffect: undefined });
            return { status: 200, data: { machine, ...(path.endsWith('/context') ? { requestId: 'delete-request' } : {}) } };
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'old-delete' });
        await operations.observeExecution({ actionId: 'machines.managed.delete', input: {}, actionRequestId: 'delete-request',
            execute: async ({ operationOwnerUpdate }) => {
                operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: machine.id,
                    controller: machine.controller, resource: machine.resource } });
                return { ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' };
            } });
        const managed = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'srv_home' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution(request) });
        await expect(managed({ actionId: 'machines.managed.inspect', input: { homeId: machine.homeId, managedId: machine.id },
            context: { actionRequestId: 'check-now' } })).resolves.toMatchObject({ machine: { allocation: 'confirmed-absent' } });
        expect(await operations.handlers.getV2({ operationId: 'old-delete' })).toMatchObject({ kind: 'found',
            operation: { state: 'succeeded', settledAt: expect.any(Number) } });
        expect(operations.store.list({ accountId: 'account', machineId: 'controller' }).items).toHaveLength(1);
    });

    it.each([['stop', 'unused'], ['delete', 'unused'], ['stop', 'deadline'], ['delete', 'deadline'], ['stop', 'admission-conflict']] as const)(
        'settles an automatic retention operation after manual %s (%s) without native IO', async (desired, kind) => {
        await storeHome('srv_home');
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: kind === 'unused' ? { kind, afterMs: 3_600_000, effect: 'stop' }
                : { kind: 'deadline', at: kind === 'admission-conflict' ? 0 : Date.now() + 60_000, effect: 'stop' },
            wakeOnAcceptedMessage: false });
        let current = kind === 'unused' ? { ...machine, desired, intentRevision: 1 } : machine;
        let readCurrent!: () => void;
        const currentRead = new Promise<void>(resolve => { readCurrent = resolve; });
        const nativeEffects: string[] = [];
        const native = nativeFixture({ privateNative: true, onNativeRole: role => { nativeEffects.push(role); } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
            if (kind === 'admission-conflict') return { status: 409, data: { code: 'intent_changed' } };
            throw new Error('Unexpected policy HTTP preparation');
        });
        const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'superseded-retention' });
        const managed = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'srv_home' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution(request), readPolicyCurrent: async () => { readCurrent(); return current; },
            executeManagedPolicyAction: unavailable });
        if (kind === 'deadline') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        try {
            const execution = managed.executePolicy({ machine, purpose: { kind: 'retention' } });
            if (kind === 'deadline') {
                expect(await Promise.race([currentRead.then(() => 'waiting'), execution])).toBe('waiting');
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(await operations.handlers.getV2({ operationId: 'superseded-retention' })).toMatchObject({ kind: 'found',
                    operation: { state: 'running', progress: { phase: 'managed.intent.waiting-deadline' } } });
                current = { ...machine, desired, intentRevision: 1 };
                await vi.advanceTimersByTimeAsync(60_000);
            }
            await expect(execution).resolves.toMatchObject({ ok: false,
                errorCode: kind === 'admission-conflict' ? 'intent_changed' : 'cancelled' });
        } finally { vi.useRealTimers(); }
        await expect(operations.handlers.getV2({ operationId: 'superseded-retention', waitForTerminal: true }))
            .resolves.toMatchObject({ kind: 'found', operation: { state: kind === 'admission-conflict' ? 'failed' : 'cancelled',
                domainRef: { kind: 'managedMachine', id: machine.id } } });
        if (kind === 'admission-conflict') {
            expect(post.mock.calls.filter(([url]) => String(url).endsWith('/prepare-policy'))).toHaveLength(1);
            expect(diagnostics).not.toHaveBeenCalledWith('[managed-policy.wait-superseded]', expect.anything());
        } else {
            expect(post).not.toHaveBeenCalled();
            expect(diagnostics).toHaveBeenCalledWith('[managed-policy.wait-superseded]', expect.objectContaining({
                managedId: machine.id, reasonCode: 'intent_changed',
            }));
        }
        expect(nativeEffects).toEqual([]);
    });
    it.each(['cleanup', 'rearmed-wake', 'stale-running-wake', 'denied-wake', 'retired-wake', 'reconnected-wake', 'cleanup-native-refused'] as const)(
        'resumes %s through the remote app replay adapter and actual live operation', async purpose => {
        const wake = !purpose.startsWith('cleanup');
        const denied = purpose === 'denied-wake';
        const retired = purpose === 'retired-wake';
        const reconnected = purpose === 'reconnected-wake';
        const nativeRefused = purpose === 'cleanup-native-refused';
        const nativeDetails = { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } } as const;
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
        const controllerDiagnostics = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const ownCredentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        installHomeGovernanceBoundaries(approvingHomes);
        const approvingHome = await approvingHomes.addHome({ name: 'Approving app', serverUrl, serverIdentityId: 'srv_home',
            accountId: 'account', credentials: { token }, currentAccount: true });
        const approvingConnection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_home', accountId: 'account',
            credentials: { token }, request: approvingHomes.request });
        const approvingAccount = await captureLazyActionAccountContext(approvingHome);
        onTestFinished(async () => { approvingAccount.dispose(); await approvingConnection.dispose(); await approvingHomes.reset(); });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
            settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(ownCredentials) });
        const signing = nacl.sign.keyPair();
        const effects: string[] = [];
        const native = nativeFixture({ privateNative: true, supportedIntents: ['start', 'delete'],
            nativeRoleResults: wake ? { get inspect() { return { observedAt: Date.now(), availability: 'present',
                power: effects.includes('power') ? 'running' : 'stopped', storage: 'retained' }; } }
                : nativeRefused ? { destroy: { kind: 'refused', code: 'provider_unavailable', nativeCause: nativeDetails.nativeCause } } : {},
            onNativeRole: role => { effects.push(role); } });
        const controller = { machineId: 'controller', installationId: 'installation' };
        let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller,
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: wake ? 'active' : 'canceled', desired: wake ? 'stop' : 'delete', desiredWhen: 'now', intentRevision: 1,
            ...(wake ? { enrolledMachineId: 'guest', observation: { observedAt: Date.now(), availability: 'present',
                power: purpose === 'stale-running-wake' ? 'running' : 'stopped', storage: 'retained' } } : {}),
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: wake });
        const target = ManagedWakeTargetV1Schema.parse({ homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest',
            controller, expectedIntentRevision: 1, reason: 'admitted-work',
            origin: { kind: 'session-input', session: { homeId: machine.homeId, sessionId: 'retained-session' },
                pendingRequestId: 'original-input', requestedAt: Date.now() } });
        let rearmed = false;
        let failedActivation: ReturnType<typeof PendingActivationAuthorizationV1Schema.parse> | undefined;
        type ArtifactWire = { id: string; header: string; body: string; dataEncryptionKey: string;
            headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number; provenance?: unknown };
        let artifact: ArtifactWire | undefined;
        const retirementArtifacts = new Map<string, ArtifactWire>();
        const ensureRetirementArtifacts = () => {
            if (retirementArtifacts.size > 0 || !artifact) return;
            const content = decodePlainArtifactStoredContent(artifact.body);
            const original = StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object'
                ? Reflect.get(content, 'body') : null)));
            for (const [id, managedId] of [['matching-delete-approval', machine.id], ['other-delete-approval', 'other-managed']] as const) {
                const request = StoredApprovalRequestSchema.parse({ ...original, status: 'open', decision: undefined, execution: undefined,
                    actionArgs: { homeId: machine.homeId, managedId, intent: 'delete', when: 'now', expectedRevision: 1, reviewedDependencies: true },
                    summary: 'Delete managed Machine' });
                retirementArtifacts.set(id, { id,
                    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), dataEncryptionKey: artifact.dataEncryptionKey,
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
        };
        const readRetirementApproval = (id: string) => {
            const row = retirementArtifacts.get(id);
            if (!row) return null;
            const content = decodePlainArtifactStoredContent(row.body);
            return StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
        };
        const storedApproval = () => {
            if (!artifact) throw new Error('Cleanup approval was not persisted');
            const content = decodePlainArtifactStoredContent(artifact.body);
            return StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
        };
        let waiting!: () => void;
        const held = new Promise<void>(resolve => { waiting = resolve; });
        const controllerPaths: string[] = [];
        const unexpectedHomeReads: string[] = [];
        const policyFailures: unknown[] = [];
        onTestFailed(() => console.error('Managed policy approval boundary', JSON.stringify({
            controllerPaths, unexpectedHomeReads, policyFailures, effects, artifactPresent: Boolean(artifact),
            controllerDiagnostics: controllerDiagnostics.mock.calls.filter(([message]) => message === '[MANAGED MACHINE] Controller request failed'),
            executor: artifact ? resolveApprovalExecutor(storedApproval()) : null,
            waiters: artifact ? getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id) : null,
            diagnostics: diagnostics.mock.calls.flatMap(([, fields]) => fields && typeof fields === 'object'
                ? [{ phase: Reflect.get(fields, 'phase'), category: Reflect.get(fields, 'category'),
                    reasonCode: Reflect.get(fields, 'reasonCode'), path: Reflect.get(fields, 'path'), httpStatus: Reflect.get(fields, 'httpStatus') }] : []),
        })));
        // Home/Artifact HTTP and the update socket are the substituted boundaries.
        // Action policy, the two executors, replay, operation and native owner stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const parsedUrl = new URL(String(url));
            const path = parsedUrl.pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({ v: 1,
                encryptionMode: 'plain', nativeEmail: null,
                password: { status: 'not_enrolled', revision: null } }) };
            if (artifact && path === `/v1/artifacts/${artifact.id}`) {
                // Creation also re-reads the open Artifact before it returns.
                // Only the coordinator's initial read follows waiter registration.
                if (storedApproval().status === 'open'
                    && getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id) === 1) waiting();
                return { status: 200, data: { ...artifact, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' } };
            }
            if (path === '/v1/artifacts') {
                ensureRetirementArtifacts();
                const kinds = parsedUrl.searchParams.get('kinds');
                expect(kinds && JSON.parse(kinds)).toEqual([managedDeleteApprovalIndexedKindV1(
                    deriveManagedDeleteApprovalSubjectKeyV1({ homeId: machine.homeId, managedId: machine.id }))]);
                const matching = retirementArtifacts.get('matching-delete-approval');
                return { status: 200, data: { items: matching ? [{ ...matching,
                    ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' }] : [],
                    hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } } };
            }
            const retirement = [...retirementArtifacts.values()].find(row => path === `/v1/artifacts/${row.id}`);
            if (retirement) return { status: 200, data: { ...retirement,
                ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' } };
            // Approval creation first reads its deterministic identity before
            // the Artifact exists; this is an ordinary not-found response.
            if (path.startsWith('/v1/artifacts/')) return { status: 404, data: {} };
            unexpectedHomeReads.push(path);
            throw new Error(`Unexpected cleanup GET ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/artifacts/read') {
                const artifactIds = (body as { artifactIds?: unknown }).artifactIds;
                if (!Array.isArray(artifactIds) || artifactIds.some(id => typeof id !== 'string')) {
                    throw new Error('Invalid selected Artifact read');
                }
                return { status: 200, data: { items: artifactIds.map(id => {
                    const row = retirementArtifacts.get(id);
                    if (!row) throw new Error(`Missing selected Artifact ${id}`);
                    return { artifactId: id, ok: true, artifact: { ...row, ownerAccountId: 'account', access: 'owner',
                        encryptionMode: 'plain', publicAudience: 'none' }, recipientCensus: null };
                }) } };
            }
            if (path === '/v1/artifacts' || artifact && path === `/v1/artifacts/${artifact.id}`) {
                const record = body as { id?: string; header: string; body: string; dataEncryptionKey?: string;
                    expectedHeaderVersion?: number; expectedBodyVersion?: number; provenance?: unknown };
                if (path === '/v1/artifacts') {
                    if (!record.id || !record.dataEncryptionKey) throw new Error('Missing canonical approval Artifact fields');
                    artifact = { id: record.id, header: record.header, body: record.body, dataEncryptionKey: record.dataEncryptionKey,
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, provenance: record.provenance };
                    ensureRetirementArtifacts();
                    return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
                }
                if (!artifact) throw new Error('No cleanup Artifact to update');
                expect(record.expectedHeaderVersion).toBe(artifact.headerVersion);
                expect(record.expectedBodyVersion).toBe(artifact.bodyVersion);
                artifact = { ...artifact, header: record.header, body: record.body, provenance: record.provenance,
                    headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1, seq: artifact.seq + 1, updatedAt: artifact.updatedAt + 1 };
                publishApprovalArtifactUpdate(artifact);
                return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
            }
            const retirementEntry = [...retirementArtifacts.entries()].find(([id]) => path === `/v1/artifacts/${id}`);
            if (retirementEntry) {
                const [id, current] = retirementEntry;
                const record = body as { header: string; body: string; expectedHeaderVersion?: number; expectedBodyVersion?: number; provenance?: unknown };
                expect(record.expectedHeaderVersion).toBe(current.headerVersion);
                expect(record.expectedBodyVersion).toBe(current.bodyVersion);
                const updated = { ...current, header: record.header, body: record.body, provenance: record.provenance,
                    headerVersion: current.headerVersion + 1, bodyVersion: current.bodyVersion + 1,
                    seq: current.seq + 1, updatedAt: current.updatedAt + 1 };
                retirementArtifacts.set(id, updated);
                return { status: 200, data: { success: true, headerVersion: updated.headerVersion, bodyVersion: updated.bodyVersion } };
            }
            controllerPaths.push(path);
            if (path.endsWith('/activation-failed')) {
                const report = ManagedPendingActivationFailureRequestV1Schema.parse(body);
                expect(report.target).toEqual(target);
                failedActivation = PendingActivationAuthorizationV1Schema.parse({ requestId: target.origin.kind === 'session-input' ? target.origin.pendingRequestId : '',
                    requestedAt: target.origin.kind === 'session-input' ? target.origin.requestedAt : 0,
                    status: 'failed', failureCode: report.failureCode, managedWakeTargetV1: target });
                return { status: 200, data: { ok: true, didFail: true } };
            }
            if (path.endsWith('/policies')) return { status: 200, data: { machines: [machine], targets: rearmed ? [target] : [] } };
            if (path.endsWith('/actions/get')) return { status: 200, data: machine };
            if (path.endsWith('/prepare-policy')) return { status: 200, data: ManagedPolicyAdmissionOutputV1Schema.parse({
                machine: wake ? { ...machine, desired: 'start' } : machine,
                requestId: ManagedPolicyAdmissionInputV1Schema.parse(body).requestId, replayed: false,
            }) };
            if (path.endsWith('/admit-policy')) machine = ManagedMachineV1Schema.parse({ ...machine, desired: wake ? 'start' : 'delete', intentRevision: 2 });
            if (path.endsWith('/submit-intent')) return { status: 200, data: { machine, submitted: true } };
            if (path.endsWith('/report-intent') && !nativeRefused) machine = ManagedMachineV1Schema.parse({ ...machine,
                ...(wake ? { observation: { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained' } }
                    : { allocation: 'confirmed-absent', observation: { observedAt: Date.now(), availability: 'absent' } }) });
            return { status: 200, data: { machine, ...(path.endsWith('/admit-policy') ? { requestId: 'cleanup', replayed: false } : {}) } };
        });
        const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: 'controller', serverId: configuration.activeServerId,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl, resolveCurrentMachineId: () => 'controller' }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: ownCredentials }), isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }) });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'cleanup-operation' });
        const executorParams = { sessionId: 'cleanup', token, credentials: ownCredentials, serverId: configuration.activeServerId,
            serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, mode: 'plain' as const, ctx: null,
            pluginActionExecutionOwner: 'current_process' as const, isApprovalExecutionOriginCurrent: currentness,
            runActionOperation: operations.runActionOperation };
        const managed = createDaemonManagedMachineActionAdapter({ credentials: ownCredentials, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: signing.secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl, resolveCurrentMachineId: () => 'controller' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: async (current, context, runApproved, purpose) => {
                try { return await executeManagedMachinePolicyAction({ machine: current, purpose, runApproved,
                context: wake ? context : { ...context, surface: 'cli', runtimeAccountId: 'account', serverIdentityId: 'srv_home', defaultSessionMachineId: 'controller' },
                serverId: configuration.activeServerId, createExecutor: overrides => wake
                    ? createCliActionExecutorFromCredentials({ ...executorParams, serverApiUrl: serverUrl, machineId: 'controller',
                        readCredentials: async () => ownCredentials, ...overrides })
                    : createCliActionExecutor({ ...executorParams, ...overrides }) }); }
                catch (error) {
                    policyFailures.push(error && typeof error === 'object'
                        ? Object.fromEntries(['code', 'message', 'details', 'actionFailure', 'stack'].map(key => [key, Reflect.get(error, key)])) : error);
                    throw error;
                }
            },
        });
        const app = createActionExecutor({ ...createCliActionDeps(executorParams),
            isApprovalExecutionOriginCurrent: currentness });
        let execution: Promise<ActionExecuteResult> = Promise.resolve({ ok: true, result: null });
        const runtime = wake ? createDaemonManagedMachinePolicyRuntime({
            readCensus: signal => readManagedMachinePolicyCensus({ homeId: machine.homeId, controller,
                custodianAccountId: 'account', privateKey: signing.secretKey, token, serverUrl, signal }),
            executePolicy: request => { execution = managed.executePolicy(request); return execution; },
        }) : null;
        if (runtime) {
            // Home HTTP is the boundary: the failed authorization has no wake
            // target until the original input is explicitly rearmed.
            runtime.notifyChanged();
            await vi.waitFor(() => expect(controllerPaths).toContain('/v1/machines/managed/controller/policies'));
            expect(artifact).toBeUndefined();
            rearmed = true;
            runtime.notifyChanged();
            await vi.waitFor(() => expect(controllerPaths).toContain('/v1/machines/managed/controller/prepare-policy'));
            await Promise.race([held, execution]);
        } else execution = managed.executePolicy({ machine, purpose: { kind: 'creation-cleanup' } });
        const settled = execution.then(result => ({ result }), error => ({ error }));
        try {
            expect(await Promise.race([held.then(() => 'held' as const), settled])).toBe('held');
            expect(storedApproval()).toMatchObject({ status: 'open', approval: { flow: 'blocking' },
                executionOriginV1: { authority: 'account_automation', surface: 'cli', machineId: 'controller', caller: { kind: 'host' } } });
            expect(effects).toEqual([]);
            expect(controllerPaths.some(path => path.endsWith('/admit-policy'))).toBe(false);
            if (!artifact) throw new Error('Missing cleanup Artifact');
            const asked = storedApproval();
            if (asked.v !== 2) throw new Error('Expected live CLI approval request');
            if (wake) {
                expect(asked.actionArgs).toEqual({ homeId: machine.homeId, managedId: machine.id, intent: 'start', when: 'now', expectedRevision: 1 });
                expect(resolveApprovalRequestExecutionInput(asked)).toEqual({ ok: true, input: asked.actionArgs });
                expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id)).toBe(1);
                expect(diagnostics).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
                    phase: 'approval.wait', status: 'started', artifactId: artifact.id,
                    operationId: 'cleanup-operation', executionRequestId: asked.v === 2 ? asked.executionOriginV1.requestId : undefined,
                    signalMatchesHostLifetime: true,
                }));
                const later = Date.now() + 180_000;
                vi.spyOn(Date, 'now').mockReturnValue(later);
                runtime!.notifyChanged();
                await vi.waitFor(() => expect(controllerPaths.filter(path => path.endsWith('/policies'))).toHaveLength(3));
                expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id)).toBe(1);
            }
            const decisionContext = {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', actionRequestId: 'separate-approval',
            } satisfies ActionExecutorContext;
            // This remote adapter receives the original OPEN request. The
            // original invocation, not a deciding-process executor, owns CAS.
            // The actual UI default owner selects its local waiter in one
            // process; its independent-app journey is a separate UI gate.
            // A guest reconnect removes its compute wake from Home's census.
            // Withdrawing that scheduler job must preserve Pending's independent
            // authorization for the guest's imminent Session activation.
            if (reconnected) {
                rearmed = false;
                runtime!.notifyChanged();
            }
            const replay = reconnected ? undefined : retired ? await operations.handlers.cancel({ operationId: 'cleanup-operation' })
                : denied ? await app.execute('approval.request.decide', { artifactId: artifact.id, decision: 'reject' }, decisionContext)
                    : await replayLiveCliApproval({ artifactId: artifact.id, request: asked, decision: 'approve',
                        context: decisionContext, account: approvingAccount });
            if (!retired && !reconnected) expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true });
            const outcome = await settled;
            expect(outcome, JSON.stringify({ outcome, effects, controllerPaths })).toMatchObject({ result: retired || reconnected ? { ok: false, errorCode: 'cancelled' }
                : denied ? { ok: false, errorCode: 'approval_rejected' }
                    : nativeRefused ? { ok: false, errorCode: 'provider_unavailable', details: nativeDetails } : { ok: true } });
            expect(effects).toEqual(denied || retired || reconnected ? [] : wake ? ['power', 'bootstrap'] : ['destroy']);
            if (!wake && !nativeRefused) {
                expect(readRetirementApproval('matching-delete-approval')).toMatchObject({ status: 'canceled' });
                expect(readRetirementApproval('other-delete-approval')).toMatchObject({ status: 'open' });
            }
            if (wake && (denied || retired)) {
                expect(failedActivation).toMatchObject({ status: 'failed', failureCode: denied ? 'managed_start_denied' : 'managed_start_failed' });
            } else expect(failedActivation).toBeUndefined();
            if (!retired && !reconnected) expect(storedApproval()).toMatchObject(denied ? { status: 'rejected' }
                : nativeRefused ? { status: 'failed', execution: { ok: false, errorCode: 'provider_unavailable' } }
                    : { status: 'executed', execution: { ok: true } });
            expect(await operations.handlers.getV2({ operationId: 'cleanup-operation', waitForTerminal: true }))
                .toMatchObject({ kind: 'found', operation: { state: retired || reconnected ? 'cancelled' : denied || nativeRefused ? 'failed' : 'succeeded',
                    ...(nativeRefused ? { error: { errorCode: 'provider_unavailable', details: nativeDetails } } : {}) } });
        } finally {
            await operations.handlers.cancel({ operationId: 'cleanup-operation' });
            await settled;
            await runtime?.stop();
        }
    });
    it('refuses a foreign finite requester without controller-scoped C42 custody before using custodian policy or native IO', async () => {
        const custodian = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'alice', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
        const signing = nacl.sign.keyPair();
        const effects: string[] = [];
        const native = nativeFixture({ privateNative: true, supportedIntents: ['start'], onNativeRole: role => { effects.push(role); } });
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'alice',
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        const actionOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-bob-finite-origin', binding: {
            accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            machineId: 'guest', installationId: 'guest-installation', serverIdentityId: 'srv_home', actionId: 'projects.script.run',
            requestId: 'original-finite', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
        } });
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest', expectedIntentRevision: machine.intentRevision,
            controller: machine.controller, origin: { kind: 'finite-command' as const, actionRequestId: 'original-finite' }, reason: 'admitted-work' as const };
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'alice' });
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/admit-policy')) return { status: 200, data: { machine: { ...machine, desired: 'start', intentRevision: 2 }, requestId: 'wake', replayed: false } };
            return { status: 200, data: { machine } };
        });
        const policy = createDaemonManagedMachineActionAdapter({ credentials: custodian, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: signing.secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl, resolveCurrentMachineId: () => 'controller' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved, purpose) => executeManagedMachinePolicyAction({ machine: current, purpose, context,
                serverId: configuration.activeServerId, runApproved, createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }) }),
        });
        const rpc = new RpcHandlerManager({ scopePrefix: 'controller', encryptionMode: 'plain', logger: () => {} });
        registerManagedFiniteWake(rpc, { readCurrent: async () => machine, executePolicy: policy.executePolicy });
        expect(await rpc.handleRequest({ method: `controller:${MANAGED_FINITE_WAKE_RPC_METHOD}`, params: { target, actionOrigin },
            authorization: ACTION_API_SERVER_ORIGIN })).toMatchObject({ ok: false, errorCode: 'requester_account_context_unavailable' });
        expect(effects).toEqual([]); expect(post).not.toHaveBeenCalled();
    });
    it('moves the admitted controller without rewriting legacy FIN scope bindings', async () => {
        const custodianCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
        const provider = createPluginContributionIdentity({ pluginId: 'acme.compute', localId: 'vm' });
        const movedController = { machineId: 'new-controller', installationId: 'new-installation' };
        const moved = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} }, controller: movedController, enrolledMachineId: 'guest',
            allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const paths: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            if (path.endsWith('/admit-control')) return { status: 200, data: { machine: moved, replayed: false } };
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            throw new Error(`Unexpected Move HTTP ${path}`);
        });
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const actionId = 'machines.managed.controller.update' as const;
        const moveInput = { homeId: 'srv_home', managedId: 'managed', expectedIntentRevision: 1,
            controller: movedController, reviewedPendingEffects: true };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'foreign-manage', binding: {
            accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_home',
            machineId: 'controller', custodianAccountId: 'account', installationId: 'installation', actionId, requestId: 'move', target,
            accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'move', target, input: moveInput }) } });
        const result = await adapter(true, undefined, undefined, nacl.sign.keyPair().secretKey, custodianCredentials)({ actionId,
            input: moveInput, context: { actionRequestId: 'move', surface: 'rpc', authority: 'account_automation',
                externalActionExecutionAuthorization: authorization, externalActionTarget: target }, signal: new AbortController().signal });
        expect(result).toEqual(moved);
        expect(paths.some(path => path.startsWith('/v3/automations'))).toBe(false);
    });
    beforeEach(async () => {
        await storeHome('srv_home');
        // HTTP is the only identity boundary substituted; profile resolution,
        // current-origin resolution and the acquisition driver remain real.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
            features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        await serverScopedRpcSocketPool.stopAll();
        resetScopedMachineTransportCacheForTests();
        vi.restoreAllMocks(); vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests();
    });

    it.each([
        ['turn-ended-during-mint', 'machines.managed.acquire'], ['natural-end', 'machines.managed.acquire'],
        ['source-replaced', 'machines.managed.acquire'], ['permission-withdrawn', 'machines.managed.acquire'],
        ['managed-retired', 'machines.managed.acquire'], ['operation-canceled', 'machines.managed.acquire'],
        ['natural-end', 'machines.managed.bootstrap.retry'], ['source-replaced', 'machines.managed.bootstrap.retry'],
        ['permission-withdrawn', 'machines.managed.bootstrap.retry'], ['operation-canceled', 'machines.managed.bootstrap.retry'],
    ] as const)(
        'rechecks accepted Session origin through the incumbent policy owner after %s for %s without requiring the old turn to stay active', async (phase, actionId) => {
        const sessionId = 'c111111111111111111111111';
        const retained = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.runner', pluginVersion: '1.0.0', agentId: 'coding', localAgentId: 'coding',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'localPath' },
            locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 }, normalizedModulePath: 'runtime.mjs', loadMode: 'immutable-js' });
        const runner = { pid: 42, processStartTimeMs: 123, processCommandHash: '5'.repeat(64), snapshotIdentity: 'fixture' };
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(41), pid: 41, sessionRunnerPid: runner.pid, startedBy: 'daemon', happySessionId: sessionId,
            runnerProcessIdentity: runner,
            processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash, runnerAgentSourceCustodyV1: retained.sourceCustody,
            activeTurnId: 'turn', agentRuntimeDaemonServiceAdmittedTurnId: 'turn', agentRuntimeDaemonServiceAdmittedInputId: 'input',
            agentRuntimeDaemonServiceAdmittedUserMessageSeq: 1, agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [1] };
        const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1] };
        const currentTurn = () => authorizeTrackedRunnerAgentDaemonServiceOperation({ tracked, sessionId, runner, retainedAgent: retained,
            witness, allowIdleCurrentGeneration: false });
        const operation = new AbortController();
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const sourceCredentials = { token, encryption: null };
        const accountSettings = AccountSettingsSchema.parse({});
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettings, settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(sourceCredentials) });
        const installation = await readOrCreateInstallationIdentity();
        const caller = { kind: 'session' as const, sessionId, starterDepth: 1, turnDepth: 2 };
        const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
        const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller, sourceTurnId: 'turn', callerPermissionMode: 'yolo',
            causalPermissionAuthority, requestId: 'session-acquire' });
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const input = actionId === 'machines.managed.bootstrap.retry'
            ? { homeId: 'srv_home', managedId: 'retained', expectedIntentRevision: 0 }
            : { enrollmentIdentity, selection: { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: installation.installationId },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        let currentPermission = 'yolo';
        let homeCurrent = true;
        // Network and the marker filesystem are substituted; lifecycle,
        // retained-source admission, permission/causal policy and proof verification stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/profile')
            ? { status: 200, data: AccountProfileSchema.parse({ id: 'account' }) }
            : String(url).endsWith('/encryption/currentness')
            ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
            : { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null,
                metadata: JSON.stringify({ machineId: 'controller', path: '/repo', permissionMode: currentPermission }) }) } });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method === 'POST' && request.url === `${serverUrl}${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}`) {
                return { status: 200, data: AccountApiTokensListActionOutputV1Schema.parse({ tokens: [] }) };
            }
            throw new Error(`Unexpected accepted-origin HTTP request: ${request.method} ${request.url}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/verify')) return { status: homeCurrent ? 200 : 403, data: homeCurrent ? { ok: true } : {} };
            if (!String(url).endsWith('/execution-authorization')) return { status: 200, data: { tokens: [] } };
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (phase === 'turn-ended-during-mint') await applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId,
                event: 'assistant_message_end', turnId: 'turn', updateSessionMarkerActiveTurn: async () => true });
            return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'accepted-session-proof', binding: {
                serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account', machineId: 'controller',
                installationId: installation.installationId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
                actionId, requestId: sessionActionOrigin.requestId, target, sessionActionOrigin,
                sessionActionSource: { machineId: 'controller', installationId: installation.installationId },
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        });
        const acceptedCurrentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials: sourceCredentials,
            machineId: 'controller', serverId: configuration.activeServerId, serverApiUrl: serverUrl,
            isSessionCallerCurrent: async ({ caller: source, signal }) => source.sessionId === sessionId && !signal?.aborted
                && authorizeTrackedRunnerAgentDaemonServiceOperation({ tracked, sessionId, runner, retainedAgent: retained,
                    witness: undefined, allowIdleCurrentGeneration: true }),
        });
        expect(acceptedCurrentness).toBeDefined();
        let acceptedOrigin: ReturnType<typeof buildApprovalExecutionOriginV1> | undefined;
        const args = { actionId, input, requestId: sessionActionOrigin.requestId, target, machineId: 'controller',
            accountId: 'account', accountEncryptionMode: 'plain' as const, tokenEpochHint: 0, token,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            installationId: installation.installationId, privateKey: installation.privateKey, sessionActionOrigin, sourceMachineId: 'controller', isCurrent: async () => currentTurn(),
            isContinuationCurrent: async (authorization: NonNullable<Awaited<ReturnType<typeof prepareExternalActionRequesterAccountAuthorization>>>) => {
                const origin = acceptedOrigin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
                    surface: 'agent', authority: 'account_automation', actionCaller: caller, defaultSessionId: sessionId,
                    serverId: configuration.activeServerId, serverIdentityId: 'srv_home', runtimeAccountId: 'account',
                    actionRequestId: sessionActionOrigin.requestId, externalActionTarget: target, callerPermissionMode: 'yolo', causalPermissionAuthority,
                    sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', via: 'action' },
                    sessionAgentSpawnPolicyV1: accountSettings.sessionAgentSpawnPolicyV1, externalActionExecutionAuthorization: authorization,
                    signExternalActionApprovalInput: ({ actionId, input: signedInput, target: signedTarget }) => signExternalActionApprovalInputV1({
                        authorizationToken: authorization.token, actionId, input: signedInput, target: signedTarget, privateKey: installation.privateKey }),
                },
                });
                if (!origin) return false;
                return await acceptedCurrentness!({ origin, actionInput: input, signal: operation.signal });
            },
        };
        expect(currentTurn()).toBe(true);
        const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
        if (phase === 'turn-ended-during-mint') {
            expect(prepared).toBeNull();
            expect(currentTurn()).toBe(false);
            return;
        }
        if (actionId === 'machines.managed.acquire') {
            expect(acceptedOrigin).toMatchObject({ surface: 'agent', authority: 'account_automation', caller });
        }
        expect(prepared).not.toBeNull();
        expect(currentTurn()).toBe(true);
        await expect(applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId, event: 'assistant_message_end', turnId: 'turn',
            updateSessionMarkerActiveTurn: async () => true })).resolves.toMatchObject({ status: 'recorded', activeTurnId: null });
        expect(currentTurn()).toBe(false);
        if (phase === 'source-replaced') tracked.runnerProcessIdentity = { ...runner, processStartTimeMs: runner.processStartTimeMs + 1 };
        if (phase === 'permission-withdrawn') currentPermission = 'default';
        if (phase === 'managed-retired') homeCurrent = false;
        if (phase === 'operation-canceled') operation.abort();
        const headers = await prepared!.requesterHttpProjection!.createRequestHeaders({ effectActionId: actionId,
            method: 'POST', path: '/v1/machines/managed/controller/current', body: {}, signal: operation.signal });
        expect(headers !== null).toBe(phase === 'natural-end');
        if (actionId === 'machines.managed.bootstrap.retry') return;
        // Ordinary Session creation's native boundary is substituted; the
        // canonical Agent permission/depth admission and result parser stay real.
        const starts: number[] = [];
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } };
        const spawn = createActionExecutor({ sessionSpawnNew: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0]) => {
            starts.push(args.workDepth ?? -1);
            return { type: 'success', disposition: 'created', sessionId: 'child', executionTarget: args.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'initial' } };
        } } as unknown as ActionExecutorDeps);
        if (headers) expect(await spawn.execute('session.spawn_new', { creationKey: 'session-acquire',
            executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' }, directory: { kind: 'managed' },
            agentTarget, initialInput: { text: 'Continue on guest' } }, {
            surface: 'agent', authority: 'account_automation', actionCaller: caller, defaultSessionId: sessionId,
            serverId: configuration.activeServerId, runtimeAccountId: prepared!.binding.accountId,
            sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' },
            callerPermissionMode: 'yolo', causalPermissionAuthority,
            sessionAgentSpawnPolicyV1: accountSettings.sessionAgentSpawnPolicyV1, signal: operation.signal,
            agentStartContext: { caller, baseline: { machineId: 'controller', directory: '/repo', configuration: { agentTarget } },
                roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo' },
        })).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'child' } });
        expect(starts).toEqual(phase === 'natural-end' ? [3] : []);
    });

    it.each(['reviewed-waiver', 'default-ask', 'foreign-controller', 'cancel-default-ask'] as const)('preserves original Session authority through the Home minter under %s policy', async policy => {
        const actionId = policy === 'cancel-default-ask' ? 'machines.managed.cancel' as const : 'machines.managed.acquire' as const;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const sourceCredentials = { token, encryption: null };
        const accountSettings = AccountSettingsSchema.parse(policy === 'reviewed-waiver' ? {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.acquire': ['agent'] } },
        } : {});
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettings, settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(sourceCredentials) });
        const controller = policy === 'foreign-controller'
            ? { machineId: 'different-controller', installationId: 'different-installation' }
            : { machineId: 'controller', installationId: 'installation' };
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller,
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const machine = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity, launch: selection.launch,
            controller: selection.controller, allocation: 'may-exist', creationState: 'active', desired: 'start',
            desiredWhen: 'now', intentRevision: 0, retention: selection.retention, wakeOnAcceptedMessage: false };
        const input = policy === 'cancel-default-ask'
            ? { homeId: 'srv_home', managedId: 'managed', expectedIntentRevision: 0 } : { enrollmentIdentity, selection };
        const target = { kind: 'machine' as const, machineId: controller.machineId };
        const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: 'c111111111111111111111111', starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: 'session-acquire' });
        const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
        const requests: string[] = [];
        const approvalRequests: ReturnType<typeof StoredApprovalRequestSchema.parse>[] = [];
        let storedApproval: Readonly<{ id: string; dataEncryptionKey: string }> | undefined;
        // Only Home HTTP is substituted. Session access, original minting,
        // Action policy, operation acceptance and managed reconciliation stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path.startsWith('/v1/artifacts/')) {
                if (!storedApproval || path !== `/v1/artifacts/${storedApproval.id}`) return { status: 404, data: {} };
                // The external approver rejects the stored request. Agent Ask
                // keeps its incumbent blocking lifecycle; no compute is approved.
                const original = approvalRequests[0];
                const rejected = StoredApprovalRequestSchema.parse({ ...original, status: 'rejected',
                    updatedAtMs: original.updatedAtMs + 1,
                    decision: { kind: 'reject', decidedAtMs: original.updatedAtMs + 1 } });
                return { status: 200, data: { ...storedApproval, ownerAccountId: 'account', access: 'owner',
                    encryptionMode: 'plain', publicAudience: 'none', headerVersion: 2, bodyVersion: 2,
                    seq: 2, createdAt: original.createdAtMs, updatedAt: rejected.updatedAtMs,
                    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected,
                        { legacyServerId: configuration.activeServerId })),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }) } };
            }
            return { status: 200, data: { session: createSessionRecordFixture({ id: 'c111111111111111111111111', share: null,
                encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'controller', path: '/workspace', flavor: 'claude' }) }) } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const path = new URL(String(url)).pathname;
            requests.push(path);
            if (path.endsWith('/execution-authorization')) {
                expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(body).toMatchObject({ sessionActionOrigin });
                return { status: 200, data: { v: 1, token: 'original-home-proof', binding: {
                    accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                    serverIdentityId: 'srv_home', machineId: controller.machineId, custodianAccountId: 'account',
                    installationId: controller.installationId, actionId, requestId: 'session-acquire',
                    target, accountEncryptionMode: 'plain', sessionActionOrigin: request.sessionActionOrigin,
                    sessionActionSource: { machineId: 'controller', installationId: 'installation' },
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } } };
            }
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/admit')) return { status: 200, data: { machine, replayed: true } };
            if (path === '/v1/artifacts') {
                // Artifact POST is the genuine persisted-content HTTP boundary.
                const record = body as Readonly<{ id: string; body: string; dataEncryptionKey: string }>;
                const content = decodePlainArtifactStoredContent(record.body);
                expect(content).toMatchObject({ body: expect.any(String) });
                const stored = typeof content === 'object' && content !== null ? Reflect.get(content, 'body') : null;
                approvalRequests.push(StoredApprovalRequestSchema.parse(JSON.parse(String(stored))));
                storedApproval = { id: record.id, dataEncryptionKey: record.dataEncryptionKey };
                return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
            }
            throw new Error(`Unexpected managed Session producer path ${path}`);
        });
        const managedMachineAction = adapter(true, undefined, undefined, signing.secretKey, sourceCredentials);
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'session-operation' });
        const executor = createCliActionExecutorFromCredentials({ credentials: sourceCredentials,
            serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: 'srv_home',
            // The live original Session factory has no Machine selector. Its
            // private source identity comes from the Home-verified Session proof.
            externalActionMachineRequestPrivateKey: signing.secretKey, externalActionMachineInstallationId: 'installation',
            managedMachineAction, pluginActionExecutionOwner: 'current_process' });
        const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl, token,
            prepareExternalActionAuthorization: async admission => {
                const { operation, isCallerCurrent, authority: source } = admission;
                const args = { actionId: operation.actionId, input: operation.input,
                    requestId: operation.requestId, target, machineId: controller.machineId, accountId: 'account', accountEncryptionMode: 'plain',
                    tokenEpochHint: 0, token, serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
                    serverHttpBaseUrl: serverUrl, installationId: 'installation', privateKey: signing.secretKey,
                    sessionActionOrigin: SessionActionRpcOriginV1Schema.parse(Reflect.get(admission, 'sessionActionOrigin')),
                    sourceMachineId: 'controller',
                    isCurrent: isCallerCurrent, signal: source.signal } as const;
                const authorization = await prepareExternalActionRequesterAccountAuthorization(args);
                return authorization ? { authorization, target } : null;
            },
            createExecutor: () => ({ execute: (actionId, actionInput, context) => operations.observeExecution({ actionId, input: actionInput,
                actionRequestId: context?.actionRequestId, execute: operationContext => executor.execute(actionId, actionInput, { ...context, ...operationContext }) }) }),
        });
        const result = await execute({ kind: 'action.execute', actionId, requestId: 'session-acquire', input,
            witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
                callerPermissionMode: 'yolo',
                agentStartCaller: { kind: 'session', sessionId: 'c111111111111111111111111', starterDepth: 1, turnDepth: 2 } } },
        { sessionId: 'c111111111111111111111111', isCurrent: async () => true });
        if (policy === 'foreign-controller') {
            expect(result).toEqual({ ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable', requestId: 'session-acquire' });
            expect(approvalRequests).toEqual([]);
            expect(requests).not.toContain('/v1/machines/managed/controller/admit');
            return;
        }
        if (policy === 'default-ask' || policy === 'cancel-default-ask') {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created', actionId, artifactId: storedApproval?.id } });
            expect(approvalRequests).toHaveLength(1);
            expect(approvalRequests[0]).toMatchObject({ v: 2, actionId, executionOriginV1: { authority: 'account_automation', surface: 'agent',
                accountId: 'account', caller: sessionActionOrigin.caller,
                sessionInputSource: { sourceSessionId: 'c111111111111111111111111', sourceTurnId: 'turn', via: 'action' },
                externalActionExecutionAuthorization: { binding: { sessionActionOrigin } },
                externalActionInputSignature: expect.any(String) } });
            const approval = approvalRequests[0];
            if (approval.v !== 2 || !approval.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed approval origin');
            expect(verifyExternalActionApprovalInputV1({ authorizationToken: 'original-home-proof',
                actionId, input: approval.actionArgs, target,
                publicKey: signing.publicKey, signature: approval.executionOriginV1.externalActionInputSignature })).toBe(true);
            expect(requests).not.toContain('/v1/machines/managed/controller/admit');
            expect(requests).not.toContain('/v1/machines/managed/actions/cancel');
            return;
        }
        expect(result).toEqual({ ok: true, result: { managedId: 'managed', operation: { operationId: 'session-operation' } } });
        expect(await operations.handlers.getV2({ operationId: 'session-operation', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'succeeded', domainRef: { kind: 'managedMachine', id: 'managed' } } });
        const predecessorObservation = await operations.handlers.get({ operationId: 'session-operation' });
        expect(predecessorObservation).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        if (predecessorObservation.kind === 'found') expect(predecessorObservation.operation).not.toHaveProperty('domainRef');
        expect(requests).toContain('/v1/machines/managed/controller/admit');
        expect(requests.some(path => path.endsWith('/submit'))).toBe(false);
    });

    it('preserves Account Voice automation through parent Ask approval replay into signed managed setup', async () => {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const ownCredentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
            settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(ownCredentials) });
        const installation = await readOrCreateInstallationIdentity();
        const signing = { secretKey: Buffer.from(installation.privateKey, 'base64url'), publicKey: Buffer.from(installation.publicKey, 'base64url') };
        const native = nativeFixture({ privateNative: true });
        const presetId = 'preset';
        const retention = { kind: 'until-delete' as const };
        const controller = { machineId: 'controller', installationId: installation.installationId };
        const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} };
        const resource = { contributionRef: launch.provider, schemaVersion: launch.schemaVersion, value: {} };
        const reviewedFacts = ManagedConfigurationFactsV1Schema.parse({ launch, optionStatus: 'current', prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'unknown' }, retentionCapabilities: { supportedIntents: ['delete'] },
            retention, wakeOnAcceptedMessage: false });
        const authored = sealManagedMachinePresetContentV1({ presetId, mode: 'plain', content: {
            v: 1, name: 'Voice setup preset', launch,
            setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }] },
        } });
        const snapshotContent = replaceManagedMachinePresetLaunchNameV1({ presetId, mode: 'plain', content: authored.content,
            launchName: launch.name, reviewedFacts, nativeResult: { kind: 'bound', resource } });
        if (!snapshotContent) throw new Error('Could not create the Voice opaque preset snapshot');
        const presetContent = { ...authored, content: snapshotContent };
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain',
            projection: projectManagedMachinePresetForRecipientV1({ content: presetContent.content,
                recipients: presetContent.recipients, recipientAccountId: 'account' }),
            enrollmentIdentity,
        });
        if (!presetContentOverride) throw new Error('Could not create the Voice opaque preset override');
        const input = { selection: { kind: 'preset' as const, homeId: 'srv_home', id: presetId, revision: 4 }, controller,
            retention, wakeOnAcceptedMessage: false, presetContentOverride };
        let readMachine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller, preset: { id: presetId, revision: 4, contentEncryptionMode: 'plain' }, enrolledMachineId: 'actual-guest',
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention, wakeOnAcceptedMessage: false, machineSetup: { state: 'pending' } });
        const readerProjection = projectManagedMachinePresetForRecipientV1({ content: presetContentOverride.content,
            recipients: [], recipientAccountId: 'account' });
        let machine = ManagedMachineFullV1Schema.parse({ ...readMachine, enrollmentIdentity, launch, resource, reviewedFacts,
            machineSetup: { setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }] }, state: 'pending' } });
        type ArtifactWire = { id: string; header: string; body: string; dataEncryptionKey: string;
            headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number; provenance?: unknown };
        let artifact: ArtifactWire | undefined;
        const storedApproval = () => {
            if (!artifact) throw new Error('Voice acquisition approval was not persisted');
            const content = decodePlainArtifactStoredContent(artifact.body);
            return StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
        };
        let approvalCreated!: () => void;
        const persisted = new Promise<void>(resolve => { approvalCreated = resolve; });
        let approvalWaitRead!: () => void;
        const liveApprovalWait = new Promise<void>(resolve => { approvalWaitRead = resolve; });
        let approved = false;
        const controllerPaths: string[] = [];
        const setupContexts: ActionExecutorContext[] = [];
        let childHeaders: unknown;
        let setupChildInput: unknown;
        // Home and private Artifact HTTP are the substituted boundaries. Policy,
        // approval transitions/replay, signatures, the adapter and driver stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'account' }) };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) };
            if (path === ACCOUNT_SECURITY_PATH_V1) return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({ v: 1,
                encryptionMode: 'plain', nativeEmail: null,
                password: { status: 'not_enrolled', revision: null } }) };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (artifact && path === `/v1/artifacts/${artifact.id}`) {
                // The real coordinator registers its live waiter before this
                // initial durable read. Decide only after that boundary.
                if (storedApproval().status === 'open') approvalWaitRead();
                return { status: 200, data: { ...artifact,
                    ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' } };
            }
            if (path.startsWith('/v1/artifacts/')) return { status: 404, data: {} };
            throw new Error(`Unexpected Voice approval GET ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/execution-authorization')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                return { status: 200, data: { v: 1, token: 'voice-parent-proof', binding: { accountId: 'account',
                    custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
                    serverIdentityId: 'srv_home', machineId: 'controller', installationId: installation.installationId, actionId: 'machines.managed.acquire',
                    requestId: 'voice-acquire', target: { kind: 'machine', machineId: 'controller' },
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
            }
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path === '/v1/artifacts' || artifact && path === `/v1/artifacts/${artifact.id}`) {
                const record = body as { id?: string; header: string; body: string; dataEncryptionKey?: string;
                    expectedHeaderVersion?: number; expectedBodyVersion?: number; provenance?: unknown };
                if (path === '/v1/artifacts') {
                    if (!record.id || !record.dataEncryptionKey) throw new Error('Missing canonical approval Artifact fields');
                    artifact = { id: record.id, header: record.header, body: record.body, dataEncryptionKey: record.dataEncryptionKey,
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, provenance: record.provenance };
                    approvalCreated();
                    return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
                }
                if (!artifact) throw new Error('No approval Artifact to update');
                expect(record.expectedHeaderVersion).toBe(artifact.headerVersion);
                expect(record.expectedBodyVersion).toBe(artifact.bodyVersion);
                artifact = { ...artifact, header: record.header, body: record.body, provenance: record.provenance,
                    headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1,
                    seq: artifact.seq + 1, updatedAt: artifact.updatedAt + 1 };
                if (storedApproval().status === 'approved') approved = true;
                publishApprovalArtifactUpdate(artifact);
                return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
            }
            if (path === '/v1/actions/machines.setup.apply') {
                expect(approved).toBe(true);
                childHeaders = config?.headers;
                const request = ChildRequestSchema.parse(body);
                expect(request.managedContinuation).toEqual({ managedId: machine.id, creationRequestId: 'voice-acquire', expectedIntentRevision: 0 });
                expect(request.envelope).not.toHaveProperty('sessionSpawnAdmission');
                setupChildInput = request.envelope.v === 1 ? request.envelope.input : request.envelope;
                machine = ManagedMachineFullV1Schema.parse({ ...machine, machineSetup: { ...machine.machineSetup!, state: 'succeeded' } });
                readMachine = ManagedMachineV1Schema.parse({ ...readMachine,
                    machineSetup: { ...readMachine.machineSetup!, state: 'succeeded' } });
                return { status: 200, data: { v: 1, actionId: 'machines.setup.apply', requestId: request.envelope.requestId,
                    execution: { ok: true, result: { operationId: 'actual-setup' } } } };
            }
            if (path.startsWith('/v1/machines/managed/')) {
                expect(approved).toBe(true);
                controllerPaths.push(path);
                return { status: 200, data: path.endsWith('/admit') ? { machine: readMachine, presetContent, presetContentOverride, replayed: true }
                    : path === '/v1/machines/managed/actions/get' ? { machine: readMachine, presetContent: readerProjection }
                        : { machine: readMachine } };
            }
            throw new Error(`Unexpected Voice approval POST ${path}`);
        });
        const root = await prepareExternalActionRequesterAccountAuthorization({ actionId: 'machines.managed.acquire', input, requestId: 'voice-acquire',
            target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller', accountId: 'account', accountEncryptionMode: 'plain',
            tokenEpochHint: 0, token, serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            installationId: installation.installationId, privateKey: signing.secretKey });
        if (!root) throw new Error('Original Voice Account proof was not admitted');
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'voice-parent' });
        const managed = adapter(true, undefined, undefined, signing.secretKey, ownCredentials, undefined, async (current, context) => {
            setupContexts.push(context);
            const authorization = context.externalActionExecutionAuthorization;
            if (!authorization) throw new Error('Approved acquisition lost its original proof');
            const target = { homeId: current.homeId, machineId: current.enrolledMachineId! };
            const input = await prepareManagedMachineSetupApplyInput({ target, creation: {
                preset: current.preset!, setup: current.machineSetup!.setup,
            }, readPlan: async planInput => ({ ok: true, result: MachineSetupPlanResultV1Schema.parse({
                desiredRevision: 0,
                sources: planInput.sources ?? [
                    { kind: 'accountPresetOpaque', presetId: current.preset!.id, presetRevision: current.preset!.revision,
                        contentEncryptionMode: current.preset!.contentEncryptionMode },
                    { kind: 'direct', setup: {} },
                ],
                exclusions: [], support: [],
                ...(planInput.mode === 'effects' ? { recipePlans: [] } : {}),
            }) }) });
            if ('ok' in input) return input;
            return dispatchManagedMachineSetup({ input, authority: context.authority,
                authorization, serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl,
                continuation: { managedId: current.id, creationRequestId: authorization.binding.requestId, expectedIntentRevision: current.intentRevision },
                installationId: installation.installationId, privateKey: signing.secretKey, signal: context.signal });
        }, operations.observeExecution, native.runtimeRegistry, installation.installationId);
        const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: 'controller', serverId: configuration.activeServerId,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl, resolveCurrentMachineId: () => 'controller' }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: ownCredentials }), isAccountCurrent: async () => true, listAccountApiTokens: unavailable,
            externalActionMachinePublicKey: signing.publicKey,
            verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
                privateKey: signing.secretKey, installationId: installation.installationId, serverHttpBaseUrl: serverUrl }) });
        let executor: ReturnType<typeof createCliActionExecutor> | undefined;
        const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl, resolveCurrentMachineId: () => 'controller' });
        const execution = operations.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'voice-acquire', execute: async operation => {
            const prepareApprovalExecutionAuthorization = createDaemonApprovalExecutionAuthorizationPreparer({ machineId: 'controller',
                serverId: configuration.activeServerId, serverBaseUrl: serverUrl, resolveCurrentMachineExecutionOriginContext: resolveOrigin,
                daemonWorkSignal: operation.signal,
                prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
                    purpose: { kind: 'external_action' }, machineId: 'controller', serverId: configuration.activeServerId,
                    serverHttpBaseUrl: serverUrl, ownCredentials, resolveCurrentMachineExecutionOriginContext: resolveOrigin,
                    createExecutor: () => { if (!executor) throw new Error('Voice executor unavailable'); return executor; } }),
            });
            executor = createCliActionExecutor({ sessionId: 'voice-approval-replay', token, credentials: ownCredentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null,
                pluginActionExecutionOwner: 'current_process', managedMachineAction: managed, isApprovalExecutionOriginCurrent: currentness,
                prepareApprovalExecutionAuthorization,
                runActionOperation: operations.runActionOperation,
                hostActionApprovalLifetime: { operationId: operation.operationAcceptance!.operationId, signal: operation.signal } });
            // Voice reaches the daemon through native Account/UI admission;
            // its captured automation ceiling, not a Voice physical surface,
            // is the authority that the managed parent must retain.
            return executor.execute('machines.managed.acquire', input, { ...operation, surface: 'ui', authority: 'account_automation',
                actionCaller: { kind: 'host' }, runtimeAccountId: 'account', actionRequestId: 'voice-acquire',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', externalActionExecutionAuthorization: root,
                externalActionTarget: root.binding.target, signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({
                    authorizationToken: root.token, actionId: args.actionId, input: args.input, target: args.target, privateKey: signing.secretKey }) });
        } });
        await Promise.race([Promise.all([persisted, liveApprovalWait]), execution.then(result => {
            throw new Error(`Voice acquisition settled before Ask: ${JSON.stringify(result)}`);
        })]);
        const request = storedApproval();
        if (request.v !== 2) throw new Error('Original Voice authority requires the canonical immutable approval origin');
        expect(request).toMatchObject({ status: 'open', actionId: 'machines.managed.acquire', approval: { flow: 'blocking' },
            executionOriginV1: { authority: 'account_automation', surface: 'ui', caller: { kind: 'host' } } });
        expect(request.executionOriginV1).not.toHaveProperty('sessionInputSource');
        expect(root.binding).not.toHaveProperty('sessionActionOrigin');
        expect(controllerPaths).toEqual([]);
        expect(setupContexts).toEqual([]);
        if (!executor || !artifact) throw new Error('Live parent approval owner was not captured');
        // This factory owns a stored terminal credential, not the UI's signed
        // Account admission. Approve through its real present-user CLI surface.
        const decision = await executor.execute('approval.request.decide', { artifactId: artifact.id, decision: 'approve' },
            { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account' });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
        const executionResult = await execution;
        expect(executionResult, JSON.stringify(executionResult)).toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'voice-parent' } } });
        const voiceOperation = await operations.handlers.getV2({ operationId: 'voice-parent', waitForTerminal: true });
        expect(voiceOperation, JSON.stringify({ voiceOperation, setupChildInput })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        const setupInput = MachineSetupApplyInputV1Schema.parse(setupChildInput);
        expect(setupInput.targets[0]?.sources).toEqual([
            { kind: 'accountPresetOpaque', presetId: machine.preset!.id, presetRevision: machine.preset!.revision,
                contentEncryptionMode: 'plain' },
            { kind: 'direct', setup: {} },
        ]);
        expect(JSON.stringify(setupInput)).not.toContain('echo reviewed');
        expect(setupContexts).toMatchObject([{ authority: 'account_automation', surface: 'ui', actionRequestId: 'voice-acquire',
            externalActionExecutionAuthorization: { token: root.token, binding: { requestId: 'voice-acquire' } } }]);
        expect(childHeaders).toMatchObject({ [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
        expect(controllerPaths.filter(path => path === '/v1/machines/managed/actions/get')).toEqual([
            '/v1/machines/managed/actions/get',
        ]);
    });

    it('uses ordinary exact-Machine availability for a fresh guest instead of the controller receiver', async () => {
        // HTTP is the real remote Machine availability boundary. A missing
        // guest must not be replaced by the locally available controller.
        const readMachine = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
        const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'lead', mode: 'plain', ctx: null });
        const result = await deps.sessionSpawnNew({ creationKey: SessionCreationKeyV1Schema.parse('guest-start'),
            sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'guest-start' }),
            executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' },
            directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } },
            actionCaller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
        });
        expect(result).toMatchObject({ type: 'error', code: 'incompatible_target' });
        expect(readMachine.mock.calls.map(([url]) => String(url))).toEqual([
            expect.stringContaining('/v1/machines/actual-guest'),
        ]);
    });

    it('re-enters ordinary Session admission with the actual enrolled Machine and retained private input', async () => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity, launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        const bodies: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            bodies.push(body);
            return { status: 200, data: String(url).endsWith('/admit') ? { machine: enrolled, replayed: false } : { machine: enrolled } };
        });
        // Ordinary spawn's daemon/network boundary is substituted; schema,
        // permission and Agent-start admission are the real Action executor.
        const started: unknown[] = [];
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSpawnNew: async (input: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0]) => {
            started.push(input);
            return { type: 'success', disposition: 'created', sessionId: 'session', executionTarget: input.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'message' } };
        } });
        const start = { creationKey: SessionCreationKeyV1Schema.parse('start'), directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } }, initialInput: { text: 'Private task' } };
        const managedMachineAction = adapter(true, (input, context) => executor.execute('session.spawn_new', input, context));
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'operation' });
        await expect(operations.observeExecution({ actionId: 'machines.managed.acquire', input: { enrollmentIdentity, selection, agentStart: start }, actionRequestId: 'request',
            execute: async (context) => ({ ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input: { enrollmentIdentity, selection, agentStart: start },
                context: { ...context, surface: 'agent', authority: 'account_automation', callerPermissionMode: 'yolo',
                    serverId: configuration.activeServerId, runtimeAccountId: 'account', actionCaller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
                    defaultSessionId: 'lead', sessionInputSource: { sourceSessionId: 'lead', sourceTurnId: 'turn', via: 'action' },
                    agentStartContext: { caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
                        baseline: { machineId: 'parent', directory: '/repo', configuration: { agentTarget: start.agentTarget } },
                        roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo' },
                }, signal: context.signal }) }),
        })).resolves.toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'operation' } } });
        const terminal = await operations.handlers.get({ operationId: 'operation', waitForTerminal: true });
        if (terminal.kind === 'found') expect(terminal.operation.error).toBeUndefined();
        expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        expect(started).toMatchObject([{ executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' },
            actionCaller: { kind: 'session', sessionId: 'lead' }, workDepth: 1, initialInput: start.initialInput,
            managedCreation: { homeId: enrolled.homeId, managedId: enrolled.id, controller: enrolled.controller } }]);
        expect(JSON.stringify(bodies)).not.toContain('Private task');
    });

    it.each(['success', 'success-update-pending', 'success-update-failed', 'error', 'not-ready', 'cancel'] as const)('retains a pending guest start and observes %s on the same parent request without buying again', async settlement => {
        const updateNotice = settlement === 'success-update-pending' ? { agentId: 'coding', status: 'pending' as const }
            : settlement === 'success-update-failed' ? { agentId: 'coding', status: 'failed' as const } : undefined;
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity, launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        const paths: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            return { status: 200, data: path.endsWith('/admit') ? { machine: enrolled, replayed: true } : { machine: enrolled } };
        });
        const childOperations = createHostActionOperationRuntime({ machineId: 'actual-guest', resolveAccountId: async () => 'account',
            generateOperationId: () => 'actual-child-operation' });
        const nativeModes: Array<boolean | undefined> = [];
        // HTTP and native Session creation are the boundaries. Both operation
        // owners, the acquisition driver and ordinary Action admission stay real.
        const spawn = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            sessionSpawnNew: async (input: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0]) => {
            expect(input.executionTarget).toEqual({ serverId: configuration.activeServerId, machineId: 'actual-guest' });
            nativeModes.push(input.resumeActionRequest);
            if (!input.resumeActionRequest) return { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'unknown' as const };
            if (settlement === 'error') return { type: 'error' as const, code: 'agent_cli_missing' as const, retryable: false, agentId: 'coding' };
            if (settlement === 'not-ready') return { type: 'error' as const, code: 'agent_cli_not_ready' as const, retryable: false, agentId: 'coding' };
            if (settlement === 'cancel') return { type: 'error' as const, code: 'cancelled' as const, retryable: false };
            return { type: 'success' as const, disposition: 'rejoined' as const, sessionId: 'actual-session', executionTarget: input.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const },
                ...(updateNotice ? { agentUpdate: updateNotice } : {}) };
        } });
        const managedMachineAction = adapter(true, (input, context) => childOperations.observeExecution({
            actionId: 'session.spawn_new', input, actionRequestId: 'request', execute: childContext => spawn.execute('session.spawn_new', input,
                { ...context, ...childContext, presentUserConfirmation: { actionId: 'session.spawn_new' } }),
        }));
        const parent = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'actual-parent-operation' });
        const input = { enrollmentIdentity, selection, agentStart: { directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } } };
        const invoke = async () => {
            let finished!: () => void;
            const completion = new Promise<void>(resolve => { finished = resolve; });
            const response = await parent.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'request',
                execute: async context => {
                    try { return { ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input,
                        context: { ...context, surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId,
                            presentUserConfirmation: { actionId: 'session.spawn_new' } }, signal: context.signal }) }; }
                    finally { finished(); }
                } });
            await completion;
            // Acceptance can precede the runner's terminal/uncertainty update.
            // Let that same invocation relinquish custody before exact replay.
            await new Promise<void>(resolve => setImmediate(resolve));
            return response;
        };
        expect(await invoke()).toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'actual-parent-operation' } } });
        expect(await parent.handlers.getV2({ operationId: 'actual-parent-operation' })).toMatchObject({ kind: 'found', operation: {
            state: 'running', domainRef: { kind: 'managedMachine', id: 'managed' },
            observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
        } });
        await invoke();
        const terminal = await parent.handlers.getV2({ operationId: 'actual-parent-operation', waitForTerminal: true });
        expect(terminal).toMatchObject({ kind: 'found', operation: {
            state: settlement.startsWith('success') ? 'succeeded' : settlement === 'cancel' ? 'cancelled' : 'failed',
            ...(updateNotice ? { domainRef: { kind: 'managedMachine', id: 'managed', agentUpdate: updateNotice } } : {}),
            ...(settlement === 'error' || settlement === 'not-ready' ? { error: { errorCode: settlement === 'error' ? 'agent_cli_missing' : 'agent_cli_not_ready',
                details: { kind: 'managedAgentStart', machineId: 'actual-guest', agentId: 'coding' } } } : {}),
        } });
        if (terminal.kind === 'found') expect(terminal.operation).not.toHaveProperty('observation');
        expect(nativeModes).toEqual([undefined, true]);
        expect(paths.some(path => path.endsWith('/submit'))).toBe(false);
    });


    it.each(['success', 'error', 'cancel', 'foreign-source-success', 'foreign-source-home-withdrawal'] as const)('keeps the original managed parent pending until the guest records %s through requester-private approval custody', async scenario => {
        const settlement = scenario === 'error' || scenario === 'cancel' ? scenario : 'success';
        const foreignSource = scenario.startsWith('foreign-source');
        const sourceMachineId = foreignSource ? 'original-source' : 'controller';
        const sourceInstallationId = foreignSource ? 'source-installation' : 'installation';
        let requesterHomeCurrent = true;
        const temporary = await mkdtemp(join(tmpdir(), 'c50-requester-approval-'));
        const lifetime = new AbortController();
        let completeNative!: () => void;
        const nativeCompletion = new Promise<void>(resolve => { completeNative = resolve; });
        let nativeEntered!: () => void;
        const nativeEntry = new Promise<void>(resolve => { nativeEntered = resolve; });
        try {
            const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const sourceCredentials = { token, encryption: null };
            const settings = AccountSettingsSchema.parse({});
            // The genuine captured Account settings publication includes its
            // observed role row. The loader/role resolver remain real; absence
            // of this authority must not be interpreted as empty overrides.
            const promptLibraryCatalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
                readRows: async () => PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ key: 'role-overrides',
                    revision: 1, content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }] }) });
            setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: Date.now(),
                settingsSecretsReadKeys: [], promptLibraryCatalog, scopeKey: resolveAccountSettingsScopeKey(sourceCredentials) });
            const sourceKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
            const controllerKeys = foreignSource ? nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(33)) : sourceKeys;
            const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
            const caller = { kind: 'session' as const, sessionId: 'c222222222222222222222222', starterDepth: 1, turnDepth: 2 };
            const cause = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
            const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller, sourceTurnId: 'accepted-turn',
                callerPermissionMode: 'yolo', causalPermissionAuthority: cause, requestId: 'original-acquire' });
            const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
            const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity, launch: selection.launch,
                controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
                creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
            const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } };
            const input = { enrollmentIdentity, selection, agentStart: { directory: { kind: 'path' as const, path: join(temporary, 'new-guest-project') }, agentTarget } };
            type ArtifactWire = { id: string; header: string; body: string; dataEncryptionKey: string;
                headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number; provenance?: unknown };
            let artifact: ArtifactWire | undefined;
            const storedApproval = () => {
                if (!artifact) throw new Error('Guest approval was not persisted');
                const content = decodePlainArtifactStoredContent(artifact.body);
                return StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
            };
            let approvalPending!: () => void;
            const pendingObservation = new Promise<void>(resolve => { approvalPending = resolve; });
            const paths: string[] = [];
            let childExecution: ActionExecuteResult | undefined;
            let childTransportError: string | undefined;
            let fixtureStage = 'constructing';
            const guestStartPhases: unknown[] = [];
            onTestFailed(() => console.error('[managed-inline-fixture]', JSON.stringify({
                fixtureStage, paths, guestStartPhases, childExecution, childTransportError,
            })));
            const sourceExecutor = createCliActionExecutorFromCredentials({ credentials: sourceCredentials,
                serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: 'srv_home', pluginActionExecutionOwner: 'current_process' });
            const guestCurrentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: 'actual-guest',
                serverId: configuration.activeServerId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'actual-guest' }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: sourceCredentials }),
                isAccountCurrent: async () => true,
                listAccountApiTokens: async () => AccountApiTokensListActionOutputV1Schema.parse({ tokens: [] }),
                externalActionMachinePublicKey: guestKeys.publicKey,
                verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
                    privateKey: guestKeys.secretKey, installationId: 'guest-installation', serverHttpBaseUrl: serverUrl }),
                isSessionCallerCurrent: async () => false,
                resolveCurrentPermissionMode: async () => 'yolo',
                resolveCurrentSessionAgentSpawnPolicyV1: async () => settings.sessionAgentSpawnPolicyV1,
            });
            const sourceBackendTarget = readBackendTargetRefV2({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' });
            const guestAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ machineId: 'actual-guest', installationId: 'guest-installation',
                actorAccountId: 'account', custodianAccountId: 'account', role: 'manage', encryptionMode: 'plain' });
            const guestRpc = new RpcHandlerManager({ scopePrefix: 'actual-guest', encryptionMode: 'plain', logger: () => {},
                authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
                    machineId: 'actual-guest', resolveHomeServerIdentityId: async () => 'srv_home',
                    resolveCustodianAccountId: async () => 'account', resolveInstallationId: () => 'guest-installation',
                    verifyMachineAdmission: admission => readMachineRpcAdmissionCurrent({ ...admission,
                        privateKey: guestKeys.secretKey, daemonToken: token, serverHttpBaseUrl: serverUrl }),
                }, source),
            });
            registerSessionCreationDirectoryPreflightRpc({ rpcHandlerManager: guestRpc });
            const guest = createCliActionExecutorHarness({ token, credentials: sourceCredentials, sessionId: 'c222222222222222222222222',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null,
                externalActionMachineRequestPrivateKey: guestKeys.secretKey, externalActionMachineInstallationId: 'guest-installation',
                getCurrentSessionMetadata: () => ({ machineId: sourceMachineId, path: temporary, flavor: 'claude', permissionMode: 'yolo' }),
                getCurrentSessionBackendTarget: () => sourceBackendTarget,
                // The native Agent boundary supplies its actual applied selection,
                // not metadata intent. Role/source/caller admission stays real.
                getCurrentAppliedChildSelection: () => ({ status: 'applied', backendTarget: sourceBackendTarget,
                    modelId: null, connectedServices: null }),
                getCurrentSessionWorkDepth: () => caller.starterDepth,
                rawSession: { machineId: sourceMachineId, path: temporary },
                machineActionDirectTargetTransport: { machineId: 'actual-guest', invoke: (method, request, options) => guestRpc.invokeLocal(method, request, options) },
                sessionSpawnDirectTargetTransport: { machineId: 'actual-guest', prepare: async (request, options) =>
                    prepareSessionCreationTarget({ request, signal: options?.signal }),
                    spawnedSession: { spawn: unavailable, resolveSpawnSessionByNonce: unavailable } },
            }, { isApprovalExecutionOriginCurrent: guestCurrentness,
                // Native Agent process creation is the only Session-start substitution.
                sessionSpawnNew: async request => {
                    const observed = { executionTarget: request.executionTarget, actionCaller: request.actionCaller, workDepth: request.workDepth,
                        sessionCreationDirectoryApproval: request.sessionCreationDirectoryApproval };
                    expect(observed, JSON.stringify(observed)).toMatchObject({ executionTarget: { serverId: 'srv_home', machineId: 'actual-guest' }, actionCaller: { kind: 'session', sessionId: caller.sessionId }, workDepth: 3,
                        sessionCreationDirectoryApproval: { v: 1, executionTarget: { serverId: 'srv_home', machineId: 'actual-guest' },
                            directory: input.agentStart.directory.path } });
                    nativeEntered();
                    await nativeCompletion;
                    if (settlement !== 'success') return { type: 'error', code: settlement === 'cancel' ? 'cancelled' : 'spawn_failed', retryable: false };
                    return { type: 'success', disposition: 'created', sessionId: 'actual-session', executionTarget: request.executionTarget,
                        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
                },
            });
            vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                const path = new URL(String(url)).pathname;
                paths.push(`GET ${path}`);
                if (path === '/v1/account/encryption') return { status: 200,
                    data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
                if (path === '/v1/machines/actual-guest') return { status: 200, data: { machine: {
                    ...createAvailableSessionSpawnMachineSnapshot('actual-guest'), installationId: 'guest-installation',
                    access: { custodian: { accountId: 'account', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                } } };
                if (path === '/v1/account/entity-rows/acp') return { status: 200,
                    data: AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                        content: { t: 'plain', v: { v: 1, definitions: [] } } }) };
                if (path === '/v1/artifacts') {
                    const query = new URL(String(url)).searchParams;
                    const filtered = query.has('kind') || query.has('kinds') || query.has('unclassified');
                    return { status: 200, data: filtered ? { items: [], hasUnclassified: false,
                        ...(query.has('kinds') || query.has('unclassified')
                            ? { coverage: { status: 'complete', unclassifiedCount: 0 } } : {}) } : [] };
                }
                if (path.startsWith('/v1/artifacts/')) {
                    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                    return { status: artifact && path === `/v1/artifacts/${artifact.id}` ? 200 : 404,
                        data: artifact ? { ...artifact, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' } : {} };
                }
                if (path.startsWith('/v1/sessions/') || path === `/v2/sessions/${caller.sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: caller.sessionId,
                    encryptionMode: 'plain', share: null, metadata: JSON.stringify({ machineId: sourceMachineId, path: temporary, flavor: 'claude', permissionMode: 'yolo' }) }) } };
                throw new Error(`Unexpected requester-private GET ${path}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                const path = new URL(String(url)).pathname;
                paths.push(path);
                if (path === `/v2/sessions/${caller.sessionId}/pending`) return { status: 200, data: { didWrite: true } };
                if (path === '/v1/machines/actual-guest/admission/verify') return { status: 200, data: { v: 1, ok: true } };
                if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
                if (path === '/v1/actions/machines.managed.acquire/execution-authorization') {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    return { status: 200, data: { v: 1, token: 'root-proof', binding: { serverIdentityId: 'srv_home', accountId: 'account',
                        custodianAccountId: 'account', machineId: 'controller', installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 0 },
                        accountEncryptionMode: 'plain', actionId: 'machines.managed.acquire', requestId: sessionActionOrigin.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: { kind: 'machine', machineId: 'controller' },
                        sessionActionOrigin, sessionActionSource: { machineId: sourceMachineId, installationId: sourceInstallationId } } } };
                }
                if (path.endsWith('/admit')) return { status: 200, data: { machine: enrolled, replayed: true } };
                if (path === '/v1/machines/managed/controller/current') return { status: 200, data: { machine: enrolled } };
                if (path === '/v1/actions/session.spawn_new') {
                    try {
                        const request = ChildRequestSchema.parse(body);
                        if (request.envelope.v !== 1 || !request.managedContinuation) throw new Error('Expected a Plain managed child wrapper');
                        const root = original!.binding;
                        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'child-proof', binding: {
                            ...root, machineId: 'actual-guest', installationId: 'guest-installation', actionId: 'session.spawn_new', target: request.envelope.target,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                            managedContinuation: { ...request.managedContinuation, controller: selection.controller, acquireRequestEnvelopeDigest: root.requestEnvelopeDigest },
                        } });
                        const childInput = SessionSpawnNewInputV2Schema.parse(request.envelope.input);
                        const childContext: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
                            recordActionStartDiagnostic: event => { guestStartPhases.push(event); },
                            actionCaller: caller, defaultSessionId: caller.sessionId, runtimeAccountId: 'account', actionRequestId: request.envelope.requestId,
                            externalActionTarget: request.envelope.target, externalActionExecutionAuthorization: authorization,
                            // Home HTTP is the admission boundary; retain its receiving-Machine custody for the native directory read.
                            machineAdmission: guestAdmission,
                            sessionInputSource: { sourceSessionId: caller.sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' },
                            callerPermissionMode: 'yolo', causalPermissionAuthority: cause, sessionAgentSpawnPolicyV1: settings.sessionAgentSpawnPolicyV1,
                            signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                                ...args, privateKey: guestKeys.secretKey }), signal: lifetime.signal };
                        fixtureStage = 'guest-origin-context';
                        expect(await guest.deps.resolveAgentStartContext?.(childContext), 'The credentialed guest must observe the real source context before approval')
                            .toMatchObject({ caller: { kind: 'session', sessionId: caller.sessionId } });
                        fixtureStage = 'guest-executor';
                        const execution = childExecution = await guest.executor.execute('session.spawn_new', childInput, childContext);
                        expect(execution).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'session.spawn_new' } });
                        return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: request.envelope.requestId, execution } };
                    } catch (error) {
                        childTransportError = error instanceof Error ? error.stack ?? error.message : String(error);
                        throw error;
                    }
                }
                if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/')) {
                    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                    // Persistent HTTP is the boundary; parsing, CAS transitions,
                    // signatures and the approval coordinator remain production owners.
                    const record = body as { id?: string; header: string; body: string; dataEncryptionKey?: string;
                        expectedHeaderVersion?: number; expectedBodyVersion?: number; provenance?: unknown };
                    if (path === '/v1/artifacts') {
                        if (!record.id || !record.dataEncryptionKey) throw new Error('Missing canonical Artifact create fields');
                        artifact = { id: record.id, header: record.header, body: record.body, dataEncryptionKey: record.dataEncryptionKey,
                            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, provenance: record.provenance };
                        return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
                    }
                    if (!artifact) throw new Error('No persisted Artifact to update');
                    expect(record.expectedHeaderVersion).toBe(artifact.headerVersion);
                    expect(record.expectedBodyVersion).toBe(artifact.bodyVersion);
                    artifact = { ...artifact, header: record.header, body: record.body, provenance: record.provenance,
                        headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1, seq: artifact.seq + 1, updatedAt: artifact.updatedAt + 1 };
                    return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
                }
                throw new Error(`Unexpected requester-private POST ${path}`);
            });
            // Agent inventory requires observed configured-catalog authority,
            // including an empty catalog. Hydrate through its real HTTP owner.
            fixtureStage = 'catalog';
            expect(await refreshActiveAcpCatalog({ credentials: sourceCredentials })).toMatchObject({ status: 'ready' });
            fixtureStage = 'source-authorization';
            const preparedOriginal = await prepareExternalActionRequesterAccountAuthorization({ actionId: 'machines.managed.acquire', input,
                requestId: sessionActionOrigin.requestId, target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller', accountId: 'account',
                accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
                serverHttpBaseUrl: serverUrl, installationId: sourceInstallationId, privateKey: sourceKeys.secretKey, sessionActionOrigin,
                sourceMachineId, isCurrent: async () => !lifetime.signal.aborted });
            expect(preparedOriginal).not.toBeNull();
            const original = foreignSource ? await projectExternalActionRequesterHttpAuthorization({ authorization: preparedOriginal!,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
                target: { kind: 'machine', machineId: 'controller' }, installationId: 'installation', privateKey: controllerKeys.secretKey,
                isCurrent: async () => requesterHomeCurrent && !lifetime.signal.aborted }) : preparedOriginal;
            expect(original).not.toBeNull();
            const managed = adapter(true, (spawnInput, context, machine) => dispatchManagedSessionStart({ authorization: original!, input: spawnInput,
                context, observeRecordedApprovalExecution: args => sourceExecutor.observeRecordedApprovalExecution(args),
                continuation: { managedId: machine.id, creationRequestId: sessionActionOrigin.requestId, expectedIntentRevision: machine.intentRevision },
                serverHttpBaseUrl: serverUrl, installationId: 'installation', privateKey: controllerKeys.secretKey,
                signal: context.signal }), async context => Boolean(context.externalActionExecutionAuthorization?.requesterHttpProjection),
                controllerKeys.secretKey, sourceCredentials, args => sourceExecutor.observeRecordedApprovalExecution(args));
            let parentSettled!: () => void;
            const parentSettlement = new Promise<void>(resolve => { parentSettled = resolve; });
            const parent = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
                generateOperationId: () => 'original-parent', publishSnapshot: snapshot => {
                    if (snapshot.observation?.code === 'approval_pending'
                        || snapshot.progress?.kind === 'phase' && snapshot.progress.phase === 'waiting_for_approval') approvalPending();
                    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') parentSettled();
                } });
            fixtureStage = 'parent-admission';
            const accepted = await parent.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: sessionActionOrigin.requestId,
                execute: async context => ({ ok: true, result: await managed({ actionId: 'machines.managed.acquire', input, signal: context.signal,
                    context: { ...context, actionCaller: caller, surface: 'agent', authority: 'account_automation', runtimeAccountId: 'account',
                        defaultSessionId: caller.sessionId, serverId: configuration.activeServerId, externalActionTarget: { kind: 'machine', machineId: 'controller' },
                        externalActionExecutionAuthorization: original! } }) }) });
            expect(accepted).toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'original-parent' } } });
            fixtureStage = 'guest-approval';
            await Promise.race([pendingObservation, parent.handlers.getV2({ operationId: 'original-parent', waitForTerminal: true })
                .then(result => { throw new Error(`Parent settled before observing guest approval: ${JSON.stringify({ result, childExecution, childTransportError })}`); })]);
            const approval = storedApproval();
            expect(approval).toMatchObject({ status: 'open', approval: { flow: 'deferred' }, actionId: 'session.spawn_new',
                sessionCreationDirectoryApproval: { executionTarget: { serverId: 'srv_home', machineId: 'actual-guest' },
                    directory: input.agentStart.directory.path } });
            // The existing in-flow decision consumes this SAME guest Artifact;
            // a code-only uncertain observation cannot render its decision.
            expect(await parent.handlers.getV2({ operationId: 'original-parent' })).toMatchObject({ kind: 'found', operation: {
                state: 'running', progress: { kind: 'phase', phase: 'waiting_for_approval',
                    approval: { kind: 'approval_request_created', actionId: 'session.spawn_new', artifactId: artifact!.id } },
            } });
            fixtureStage = 'explicit-decision';
            const decision = guest.executor.execute('approval.request.decide', { artifactId: artifact!.id, decision: 'approve' },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account', signal: lifetime.signal,
                    // The authenticated UI decision arrives at this same admitted guest.
                    machineAdmission: guestAdmission });
            await Promise.race([nativeEntry, decision.then(result => { throw new Error(`Guest replay did not reach native creation: ${JSON.stringify(result)}`); })]);
            expect(storedApproval()).toMatchObject({ status: 'executing' });
            expect(await parent.handlers.getV2({ operationId: 'original-parent' })).toMatchObject({ kind: 'found', operation: {
                state: 'running', domainRef: { kind: 'managedMachine', id: 'managed' },
                progress: { kind: 'phase', phase: 'waiting_for_approval', approval: { artifactId: artifact!.id } } } });
            if (scenario === 'foreign-source-home-withdrawal') requesterHomeCurrent = false;
            completeNative();
            expect(await decision).toMatchObject({ ok: true });
            if (!artifact) throw new Error('Missing guest approval Artifact');
            publishApprovalArtifactUpdate(artifact);
            // Public waits may return an unresolved approval observation. The
            // existing publication boundary tells us when this parent settles.
            await parentSettlement;
            expect(await parent.handlers.getV2({ operationId: 'original-parent' })).toMatchObject({ kind: 'found', operation: {
                state: scenario === 'foreign-source-home-withdrawal' ? 'failed' : settlement === 'success' ? 'succeeded' : settlement === 'cancel' ? 'cancelled' : 'failed',
                ...(scenario === 'foreign-source-home-withdrawal' ? { error: { errorCode: 'approval_stale' } }
                    : settlement === 'error' ? { error: { errorCode: 'spawn_failed' } } : {}),
                domainRef: { kind: 'managedMachine', id: 'managed' } } });
            const terminal = await parent.handlers.getV2({ operationId: 'original-parent' });
            if (terminal.kind === 'found') expect(terminal.operation).not.toHaveProperty('observation');
            expect(storedApproval()).toMatchObject(settlement === 'success'
                ? { status: 'executed', execution: { ok: true, result: { type: 'success', sessionId: 'actual-session' } } }
                : { status: 'executed', execution: { ok: true, result: { type: 'error',
                    code: settlement === 'cancel' ? 'cancelled' : 'spawn_failed', retryable: false } } });
            expect(paths.some(path => path.endsWith('/submit'))).toBe(false);
        } finally {
            lifetime.abort();
            completeNative();
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it('replays an offered bootstrap retry on its controller and persists the shared bootstrap failure', async () => {
        const actionId = 'machines.managed.bootstrap.retry' as const;
        const input = { homeId: 'srv_home', managedId: 'retained-running-guest', expectedIntentRevision: 1 };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', decidingAccountId: 'account' },
            createdBy: { surface: 'system' }, requestedSurface: 'cli', actionId, actionArgs: input,
            summary: 'Retry guest connection', approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', accountId: 'account',
                machineId: 'controller', target: { kind: 'machine', machineId: 'controller' }, actionId, requestId: 'approved-retry' } });
        expect(resolveApprovalExecutor(request)).toEqual({ kind: 'daemon', machineId: 'controller' });
        let machine = ManagedMachineV1Schema.parse({ id: input.managedId, homeId: input.homeId, custodianAccountId: 'account',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            observation: { observedAt: 1, availability: 'present', power: 'running' },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const roles: string[] = [];
        const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
        const native = nativeFixture({ privateNative: true, credentialPurposes: [], onNativeRole: role => {
            roles.push(role);
            if (role === 'bootstrap') throw new PluginError({ code: 'native_access_refused',
                details: { nativeCause, message: 'private provider response' } });
        } });
        // Home persistence and authored provider IO are the external boundaries.
        // Action admission, operation ownership, driver and shared bootstrap stay real.
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: 'original-acquire' } };
            if (path.endsWith('/current')) return { status: 200, data: { machine, current: true } };
            if (path.endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                machine = ManagedMachineV1Schema.parse({ ...machine, observation: report.observation });
                return { status: 200, data: { machine } };
            }
            throw new Error(`Unexpected bootstrap retry HTTP ${path}`);
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'retry-operation' });
        const managed = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
                resolveCurrentMachineId: () => 'controller' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: args => operations.observeExecution(args) });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), managedMachineAction: managed });
        expect(await executor.execute(actionId, request.actionArgs, { surface: 'cli', authority: 'present_user',
            actionCaller: { kind: 'host' }, runtimeAccountId: 'account', serverId: configuration.activeServerId,
            actionRequestId: request.executionOriginV1.requestId, presentUserConfirmation: { actionId } }))
            .toMatchObject({ ok: true, result: { managedId: machine.id, operation: { operationId: 'retry-operation' } } });
        expect(await operations.handlers.getV2({ operationId: 'retry-operation', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'native_access_refused' } } });
        expect(machine).toMatchObject({ allocation: 'bound', observation: {
            availability: 'unavailable', reason: 'bootstrap.native_access_refused', nativeCause } });
        expect(machine.enrolledMachineId).toBeUndefined();
        expect(roles).toEqual(['bootstrap']);
        expect(JSON.stringify(machine)).not.toContain('private provider response');
    });

    it('refuses a bootstrap retry approval naming another Account\'s controller at Home replay without native IO', async () => {
        const actionId = 'machines.managed.bootstrap.retry' as const;
        const input = { homeId: 'srv_home', managedId: 'foreign-guest', expectedIntentRevision: 1 };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', decidingAccountId: 'account' },
            createdBy: { surface: 'system' }, requestedSurface: 'cli', actionId, actionArgs: input,
            summary: 'Retry guest connection', approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', accountId: 'account',
                machineId: 'foreign-controller', target: { kind: 'machine', machineId: 'foreign-controller' }, actionId,
                requestId: 'foreign-retry' } });
        // Location only: the named daemon still needs Home custody for this exact retry.
        expect(resolveApprovalExecutor(request)).toEqual({ kind: 'daemon', machineId: 'foreign-controller' });
        const roles: string[] = [];
        const native = nativeFixture({ privateNative: true, credentialPurposes: [], onNativeRole: role => { roles.push(role); } });
        const homePaths: string[] = [];
        // Home is the external boundary: the retained managed record belongs to
        // another Account's controller, so its custody read refuses this replay.
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            homePaths.push(path);
            return { status: 403, data: { code: 'permission_denied' } };
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'foreign-retry-operation' });
        const managed = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
                resolveCurrentMachineId: () => 'controller' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: args => operations.observeExecution(args) });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), managedMachineAction: managed });
        const result = await executor.execute(actionId, request.actionArgs, { surface: 'cli', authority: 'present_user',
            actionCaller: { kind: 'host' }, runtimeAccountId: 'account', serverId: configuration.activeServerId,
            actionRequestId: request.executionOriginV1.requestId, presentUserConfirmation: { actionId } });
        const settled = result.ok ? await operations.handlers.getV2({ operationId: 'foreign-retry-operation', waitForTerminal: true }) : null;
        expect(result.ok === false || settled?.kind === 'found' && settled.operation.state === 'failed').toBe(true);
        expect(roles).toEqual([]);
        expect(homePaths.some(path => path.endsWith('/report'))).toBe(false);
    });

    it('owns an acquisition operation when an approved detached Ask reaches the native adapter without a live parent', async () => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity, launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false });
        // Home admission is the network boundary; the native adapter, driver and operation owner are real.
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine, replayed: true } });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'detached-acquire' });
        const managedMachineAction = adapter(true, undefined, undefined, nacl.sign.keyPair().secretKey, credentials,
            undefined, undefined, request => operations.observeExecution(request));
        await expect(managedMachineAction({ actionId: 'machines.managed.acquire', input: { enrollmentIdentity, selection },
            context: { actionRequestId: 'original-cli-ask', surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId },
        })).resolves.toEqual({ managedId: 'managed', operation: { operationId: 'detached-acquire' } });
        expect(await operations.handlers.getV2({ operationId: 'detached-acquire', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            state: 'succeeded', domainRef: { kind: 'managedMachine', id: 'managed' },
        } });
    });

    it('keeps detached Delete dispatch under the durable operation after the approving request ends', async () => {
        const outer = new AbortController();
        let destroys = 0;
        const native = nativeFixture({ privateNative: true, supportedIntents: ['delete'],
            onNativeRole: role => { if (role === 'destroy') destroys += 1; } });
        let machine = ManagedMachineV1Schema.parse({ id: 'managed-delete', homeId: 'srv_home', custodianAccountId: 'account',
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound',
            resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/admit-control')) return { status: 200, data: { machine, replayed: false } };
            if (path.endsWith('/submit-intent')) {
                machine = ManagedMachineV1Schema.parse({ ...machine, submittedNativeEffect: {
                    intent: 'delete', intentRevision: machine.intentRevision, requestId: 'approved-delete', controller: machine.controller,
                } });
                return { status: 200, data: { machine, submitted: true } };
            }
            if (path.endsWith('/report-intent')) {
                machine = ManagedMachineV1Schema.parse({ ...machine, allocation: 'confirmed-absent', resource: undefined,
                    nativeOperationRef: undefined, submittedNativeEffect: undefined,
                    observation: { observedAt: 2, availability: 'absent' } });
            }
            return { status: 200, data: { machine } };
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'durable-delete' });
        const managed = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl, resolveCurrentMachineId: () => 'controller',
            }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution({ ...request, execute: operation => request.execute({
                ...operation,
                ...(operation.operationAcceptance ? { operationAcceptance: { ...operation.operationAcceptance, accept: result => {
                    operation.operationAcceptance?.accept(result);
                    outer.abort();
                } } } : {}),
            }) }),
        });
        await expect(managed({ actionId: 'machines.managed.delete', input: { homeId: machine.homeId, managedId: machine.id,
            when: 'now', expectedRevision: 0, intent: 'delete', reviewedDependencies: true },
            context: { actionRequestId: 'approved-delete', surface: 'ui', authority: 'present_user', serverId: configuration.activeServerId,
                signal: outer.signal }, signal: outer.signal })).resolves.toMatchObject({ kind: 'accepted' });
        await expect(operations.handlers.getV2({ operationId: 'durable-delete', waitForTerminal: true })).resolves.toMatchObject({
            kind: 'found', operation: { state: 'succeeded' },
        });
        expect(destroys).toBe(1);
    });

    it('refuses an unavailable managed-operation authority before admitting any compute', async () => {
        const post = vi.spyOn(axios, 'post');
        await expect(adapter(false)({ actionId: 'machines.provisioners.list', input: { homeId: 'srv_home' },
            context: { actionRequestId: 'request' } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('refuses an unbound operation scope without recursively attempting acquisition', async () => {
        const post = vi.spyOn(axios, 'post');
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => null });
        const managedMachineAction = adapter(true, undefined, undefined, nacl.sign.keyPair().secretKey, credentials,
            undefined, undefined, request => operations.observeExecution(request));
        await expect(managedMachineAction({ actionId: 'machines.managed.acquire', input: {
            enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        },
            context: { actionRequestId: 'unbound-ask', surface: 'cli', authority: 'present_user' },
        })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('refuses a known continuation without its operation observation owner before admitting compute', async () => {
        const post = vi.spyOn(axios, 'post');
        const spawn = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null }));
        await expect(adapter(true, (input, context) => spawn.execute('session.spawn_new', input, context))({
            actionId: 'machines.managed.acquire', input: {
                enrollmentIdentity,
                selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
                agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
            }, context: { actionRequestId: 'request', surface: 'cli', authority: 'present_user' },
        })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it.each(['setup', 'session', 'setup-recovered'] as const)('preserves child %s Action diagnostics in the retained managed operation', async phase => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        let machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity,
            launch: selection.launch, controller: selection.controller, allocation: 'bound',
            resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0, enrolledMachineId: 'actual-guest',
            retention: selection.retention, wakeOnAcceptedMessage: false,
            ...(phase !== 'session' ? { preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
                machineSetup: { state: 'pending', setup: { scripts: [{ body: 'echo setup', affects: 'none' }] } } } : {}) });
        // The guest Action HTTP transport is the boundary; adapter, driver and operation projection remain real.
        const childPhase = phase !== 'session' ? 'machines.setup.apply' : 'session.spawn_new';
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
            failureCause: projectActionFailureCauseV1(Object.assign(new Error('private native response'), { code: 'credential_unavailable' }), childPhase),
            details: { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } } });
        vi.spyOn(axios, 'post').mockImplementation(async url => ({ status: 200,
            data: String(url).endsWith('/child-action') ? failure : String(url).endsWith('/admit')
                ? { machine, replayed: false } : { machine } }));
        const child = async () => {
            const result = (await axios.post<ActionExecuteResult>(`${serverUrl}/child-action`)).data;
            if (phase === 'setup-recovered') machine = ManagedMachineFullV1Schema.parse({ ...machine,
                machineSetup: { ...machine.machineSetup, state: 'succeeded' } });
            return result;
        };
        const managed = adapter(true, phase === 'session' ? child : phase === 'setup-recovered'
            ? async () => ({ ok: true, result: SessionSpawnNewActionResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'recovered-session',
                executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' },
                organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } }) }) : undefined,
            undefined, nacl.sign.keyPair().secretKey, credentials, undefined, phase !== 'session' ? child : undefined);
        const input = { enrollmentIdentity, selection, ...(phase !== 'setup' ? { agentStart: { directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } } } : {}) };
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'child-diagnostic' });
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'request',
            execute: async context => ({ ok: true, result: await managed({ actionId: 'machines.managed.acquire', input,
                context: { ...context, surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId }, signal: context.signal }) }) });
        const settled = await operations.handlers.getV2({ operationId: 'child-diagnostic', waitForTerminal: true });
        if (phase === 'setup-recovered') {
            expect(settled, JSON.stringify(settled)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            return;
        }
        expect(settled).toMatchObject({ kind: 'found', operation: {
            state: 'failed', error: { errorCode: failure.errorCode, failureCause: failure.failureCause, details: failure.details },
        } });
    });

    it('projects a real ordinary Session-start domain refusal into the retained managed operation', async () => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrollmentIdentity, launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        vi.spyOn(axios, 'post').mockImplementation(async url => ({ status: 200,
            data: String(url).endsWith('/admit') ? { machine: enrolled, replayed: false } : { machine: enrolled } }));
        // Session start is a real Action executor; only its native start
        // boundary returns the canonical Agent setup refusal.
        const spawn = createActionExecutor({ sessionSpawnNew: async () => ({
            type: 'error', code: 'agent_cli_missing', retryable: false, agentId: 'coding',
        }) } as unknown as ActionExecutorDeps);
        const managedMachineAction = adapter(true, (input, context) => spawn.execute('session.spawn_new', input, context));
        const input = { enrollmentIdentity, selection, agentStart: { directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } } };
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'operation' });
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'request',
            execute: async context => ({ ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input,
                context: { ...context, surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId,
                    presentUserConfirmation: { actionId: 'session.spawn_new' } }, signal: context.signal }) }) });
        expect(await operations.handlers.getV2({ operationId: 'operation', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            state: 'failed', domainRef: { kind: 'managedMachine', id: 'managed' }, error: { errorCode: 'agent_cli_missing' },
        } });
    });

    it('binds the credentialed factory to the observed Home and refuses a changed profile', async () => {
        const managedMachineAction = adapter();
        const executor = createCliActionExecutorFromCredentials({ credentials,
            serverId: configuration.activeServerId, serverApiUrl: serverUrl,
            managedMachineAction, pluginActionExecutionOwner: 'current_process',
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
        });
        expect(await executor.execute('machines.provisioners.list', { homeId: 'srv_home' },
            { surface: 'cli', actionRequestId: 'request' })).toEqual({ ok: true, result: { controller: { machineId: 'controller', installationId: 'installation' }, provisioners: [] } });
        await storeHome('srv_different_home');
        await expect(managedMachineAction({ actionId: 'machines.provisioners.list', input: { homeId: 'srv_home' },
            context: { actionRequestId: 'request' } })).rejects.toMatchObject({ code: 'controller_unavailable' });
    });
    it.each([
        ['cli', false], ['agent', false], ['mcp', false],
        ['cli', true], ['agent', true], ['mcp', true],
    ] as const)('invokes installed provisioner checks and managed retention through the real %s executor (unbound observer: %s)', async (surface, withUnboundObserver) => {
        const native = nativeFixture({ privateNative: true });
        const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => null });
        const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials,
            machineId: 'controller', serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
            installationIdentity: { installationId: 'installation', privateKey: signing.secretKey },
            managedProviderOperationAuthority: authority,
            ...(withUnboundObserver ? { observeActionExecution: (request: Parameters<typeof operations.observeExecution>[0]) => operations.observeExecution(request) } : {}),
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl, resolveCurrentMachineId: () => 'controller',
            }),
            // Only installed module acquisition is substituted. The fixture
            // contains the real contribution registry and invocation owner.
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
        });
        const policy = normalizeActionsSettingsV1({ v: 1, actions: {},
            approvalWaivedSurfaces: { 'machines.managed.retention.update': ['cli', 'agent', 'mcp'] } });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: policy }),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (new URL(String(url)).pathname !== '/v1/account/encryption') throw new Error(`Unexpected Account read: ${url}`);
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        const cli = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'parity-session',
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            getCurrentSessionMetadata: () => ({ machineId: 'controller', path: '/workspace', flavor: 'claude' }),
            rawSession: { machineId: 'controller', path: '/workspace' },
            mode: 'plain', ctx: null, managedMachineAction, pluginActionExecutionOwner: 'current_process' });
        const bridge = createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy });
        const invoke = (actionId: 'machines.provisioners.check' | 'machines.managed.retention.update', input: unknown) => surface === 'cli'
            ? cli.execute(actionId, input, { surface, actionsSettings: policy, authority: 'account_automation', actionRequestId: 'parity-request' })
            : bridge.executeActionByToolName('action_execute',
                { actionId, input }, 'parity-session', { actionRequestId: 'parity-request' });
        const probe = { homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            contribution: { pluginId: 'acme.compute', localId: 'vm' } };
        await expect(invoke('machines.provisioners.check', probe)).resolves.toEqual({ ok: true, result: { available: true } });
        expect(native.effects()).toBe(1);
        const changed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller: probe.controller, launch: { provider: probe.contribution, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: probe.contribution, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        const seen: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (new URL(String(url)).pathname !== '/v1/machines/managed/controller/admit-control') throw new Error(`Unexpected native lifecycle request: ${url}`);
            seen.push(body);
            return { status: 200, data: { machine: changed, replayed: false } };
        });
        const update = { homeId: 'srv_home', managedId: 'managed', expectedIntentRevision: 1,
            retention: changed.retention, wakeOnAcceptedMessage: true };
        await expect(invoke('machines.managed.retention.update', update)).resolves.toEqual({ ok: true, result: changed });
        expect(seen).toEqual([{ action: 'machines.managed.retention.update', requestId: 'parity-request', input: update }]);
        expect(native.effects()).toBe(1);
    });
    it.each(['cli', 'mcp', 'cua'] as const)('routes standalone %s provisioner discovery through the installed native contribution', async surface => {
        await withConfiguredDaemonTestHome({ prefix: 'managed-provisioner-parity-' }, async () => {
            await storeHome('srv_home');
            const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const accountCredentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
            await writeStoredCredentialsForServerId(configuration.activeServerId, accountCredentials);
            setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}),
                settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(accountCredentials) });
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                throw new Error(`Unexpected Account read: ${path}`);
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                if (String(request.url).endsWith('/v1/machines/managed/actions/list')) return { status: 200, data: { machines: [] } };
                throw new Error(`Unexpected Account request: ${request.url}`);
            });
            // HTTP and installed module acquisition are the boundaries. The
            // control server, target resolver, approval and plugin executor stay real.
            const realFetch = vi.mocked(globalThis.fetch).getMockImplementation();
            vi.mocked(globalThis.fetch).mockRestore();
            const networkFetch = globalThis.fetch;
            vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => String(url).startsWith('http://127.0.0.1:')
                ? networkFetch(url, options) : realFetch!(url, options));
            const authored = surface === 'cua' ? await createPluginTestkit({ manifest: CUA_PLUGIN.manifest, module: CUA_PLUGIN }) : undefined;
            const cuaManifest = normalizePluginManifestV2(CUA_PLUGIN.manifest);
            const unavailableServices = createUnavailablePluginServicesFactory();
            const native = surface === 'cua' ? nativeFixture({ fixtureManifest: cuaManifest,
                actionHandlers: new Map(cuaManifest.contributes.actions.map(action => {
                    const handler = authored?.registration('actions', action.id);
                    if (!handler) throw new Error('Missing authored Cua Action');
                    return [action.id, handler];
                })),
                createServices(seed, binding) {
                    const services = unavailableServices(seed, binding);
                    return { ...services, exec: { ...services.exec, async run(request) {
                        const args = request.args ?? [];
                        const digest = `sha256:${'a'.repeat(64)}`;
                        const value = args.includes('doctor') ? { host: { os: 'linux', arch: 'x86_64', kvm: true,
                            accel: { x86_64: 'kvm', aarch64: 'tcg' } }, backends: [{ backend: 'qemu', ready: true, provisionable: false }],
                            qemu: { version: '10.1.0' }, lume: { version: null }, container: { reachable: false, gvisor: false, runtimes: [] } }
                            : args.includes('images') ? [{ ref: 'ghcr.io/trycua/linux:24.04-disk', os: 'linux', arch: ['amd64'],
                                local: 'qemu', published: true, spacesd: true, digest,
                                sizes: { digest, platforms: [{ arch: 'amd64', disk: 20 * 1024 ** 3 }] } }] : undefined;
                        if (!value) throw new Error('Options must only inspect native capabilities');
                        return { termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
                            stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
                    } }, managedServices: { ...services.managedServices, dependencies: { ...services.managedServices.dependencies,
                        status: async () => ({ state: 'ready' as const, id: 'cua-cli', version: '0.5.0', sourceId: 'system',
                            executable: { kind: 'managedDependency' as const, id: { pluginId: cuaManifest.id, localId: 'cua-cli' } } }) } } };
                },
            }) : nativeFixture({ privateNative: true });
            const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials: accountCredentials,
                machineId: 'controller', serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
                installationIdentity: { installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey },
                managedProviderOperationAuthority: authority,
                resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                    serverUrl, resolveCurrentMachineId: () => 'controller',
                }),
                acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            });
            const receiver = createCliActionExecutor({ token, credentials: accountCredentials, sessionId: '',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
                mode: 'plain', ctx: null, managedMachineAction, pluginActionExecutionOwner: 'current_process' });
            const app = createDaemonControlApp({ getChildren: () => [], machineId: 'controller', controlToken: 'parity-control',
                stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
                requestShutdown: () => {}, onHappySessionWebhook: () => {}, externalActionApi: {
                    currentServerId: configuration.activeServerId, executor: receiver,
                    verifyPat: async () => { throw new Error('Stored Account ingress must not use PAT admission'); },
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials: accountCredentials, serverApiUrl: serverUrl }),
                } });
            await app.listen({ host: '127.0.0.1', port: 0 });
            const address = app.server.address();
            if (!address || typeof address === 'string') throw new Error('Missing daemon address');
            const daemonControlTarget = { pid: process.pid, httpPort: address.port, controlToken: 'parity-control' };
            writeDaemonState({ ...daemonControlTarget, machineId: 'controller', accountId: 'account', startedAt: Date.now(), startedWithCliVersion: 'test' });
            const cli = createCliActionExecutorFromCredentials({ credentials: accountCredentials,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: serverUrl,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) } });
            const { mcp } = runWithServerHttpBaseUrl(serverUrl, () => createExternalMcpServer({
                credentials: accountCredentials, machineId: 'controller', daemonControlTarget,
            }));
            const client = new Client({ name: 'provisioner-parity', version: '1' });
            const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
            try {
                await mcp.connect(serverTransport); await client.connect(clientTransport);
                const controller = { machineId: 'controller', installationId: 'installation' };
                const invoke = async (actionId: 'machines.provisioners.list' | 'machines.provisioners.check' | 'machines.provisioners.options', input: unknown) => {
                    if (surface !== 'mcp') {
                        const result = await cli.execute(actionId, input, { surface: 'cli', actionRequestId: 'parity-request' });
                        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                        if (!result.ok) throw new Error('CLI discovery failed');
                        return result.result;
                    }
                    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
                    expect(result.isError, JSON.stringify(result)).not.toBe(true);
                    const content = result.content.find(item => item.type === 'text');
                    if (!content || content.type !== 'text') throw new Error('Missing MCP result');
                    return JSON.parse(content.text);
                };
                if (surface === 'cua') {
                    const contribution = { pluginId: cuaManifest.id, localId: 'local-sandbox' };
                    const input = { homeId: 'srv_home', controller, contribution, selectors: { size: { cpu: 4, memoryBytes: 4 * 1024 ** 3 } } };
                    const options = MachineProvisionerOptionsResultV1Schema.parse(await invoke('machines.provisioners.options', input));
                    const selection = Object.fromEntries(Object.entries(options.dimensions).flatMap(([key, entries]) => entries[0] ? [[key, entries[0].id]] : []));
                    const descriptor = cuaManifest.contributes.machineProvisioners.find(value => value.id === contribution.localId);
                    if (!descriptor) throw new Error('Missing Cua declaration');
                    const projected = projectMachineProvisionerSelectionV1({ options, selection, launchSchema: descriptor.launchSchema });
                    if (projected.kind !== 'ready') throw new Error('Cua options must produce a complete strict launch');
                    expect(CuaLocalLaunchV1Schema.parse(projected.launch)).toMatchObject({ runtimeId: 'qemu', imageId: 'ghcr.io/trycua/linux:24.04-disk' });
                    expect(await cli.execute('machines.provisioners.options', { ...input, controller: { ...controller, installationId: 'unavailable' } },
                        { surface: 'cli', actionRequestId: 'unavailable-controller' })).toMatchObject({ ok: false });
                    expect(await cli.execute('machines.provisioners.options', { ...input, contribution: { ...contribution, localId: 'misbound' } },
                        { surface: 'cli', actionRequestId: 'misbound-contribution' })).toMatchObject({ ok: false });
                    return;
                }
                expect(await invoke('machines.provisioners.list', { homeId: 'srv_home', controller })).toMatchObject({
                    controller, provisioners: [expect.objectContaining({ contribution: { pluginId: 'acme.compute', localId: 'vm' } })],
                });
                expect(await invoke('machines.provisioners.options', { homeId: 'srv_home', controller,
                    contribution: { pluginId: 'acme.compute', localId: 'vm' }, selectors: {} })).toEqual({
                    dimensions: { size: [], image: [], location: [], network: [], duration: [] },
                });
                expect(await invoke('machines.provisioners.check', { homeId: 'srv_home', controller,
                    contribution: { pluginId: 'acme.compute', localId: 'vm' } })).toEqual({ available: true });
                expect(native.effects()).toBe(2);
            } finally {
                await client.close(); await mcp.close(); await app.close();
            }
        });
    });

    it('refuses a continuation whose original external credential cannot authorize a new enrolled Machine', async () => {
        const post = vi.spyOn(axios, 'post');
        await expect(adapter()({ actionId: 'machines.managed.acquire', input: {
            enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
        }, context: { actionRequestId: 'request', externalActionCredential: {
            principalId: 'principal', credentialId: 'token-id', accountId: 'account', grant: API_TOKEN_FULL_GRANT_V1,
        } } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('checks genuine signed continuation availability before admitting compute', async () => {
        const post = vi.spyOn(axios, 'post');
        const managedMachineAction = adapter(true, async () => ({ ok: true, result: {} }));
        await expect(managedMachineAction({ actionId: 'machines.managed.acquire', input: {
            enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
        }, context: { actionRequestId: 'request', externalActionExecutionAuthorization: { v: 1, token: 'signed-root', binding: {
            serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
            authentication: { kind: 'account', tokenEpoch: 0 }, machineId: 'controller', installationId: 'installation',
            actionId: 'machines.managed.acquire', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: 'e2ee',
        } } } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('does not erase a real Session-origin continuation on the public guest hop before compute', async () => {
        const post = vi.spyOn(axios, 'post');
        // Real credential-material availability is read by the production
        // transport owner; it is not a replacement for Session-origin proof.
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
        const managedMachineAction = adapter(true, async () => ({ ok: true, result: {} }), async context => {
            const { isManagedSessionStartTransportAvailable } = await import('@/api/externalActionExecutionAuthorization');
            return isManagedSessionStartTransportAvailable({ authorization: context.externalActionExecutionAuthorization,
                installationId: 'installation', material });
        });
        await expect(managedMachineAction({ actionId: 'machines.managed.acquire', input: {
            enrollmentIdentity,
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
        }, context: { actionRequestId: 'request', actionCaller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
            agentStartWorkDepth: 1, agentStartWorkspaceWrites: 'deny', externalActionExecutionAuthorization: {
                v: 1, token: 'signed-root', binding: { serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
                    authentication: { kind: 'account', tokenEpoch: 0 }, machineId: 'controller', installationId: 'installation',
                    actionId: 'machines.managed.acquire', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: 'e2ee' },
            },
        } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });
});
