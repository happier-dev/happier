import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
// This composed CLI/UI seam needs the UI harness's canonical native boundaries.
import '../../../../ui/sources/dev/vitestSetup';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'socket.io';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createCliProviderActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliProviderActionDeps';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import codexManifest from '../../../assets/bundled-plugin-manifests/codex.json';
import gatewayManifest from '../../../assets/bundled-plugin-manifests/cliproxyapi.json';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../packages/plugins/codex/src/agent/providerBinding/adapter';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/cliproxyapi/src/provider/contribution';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerMachineProviderRpcHandlers } from '@/api/machine/rpcHandlers.providers';
import { resolveTeamCredentialSourceModelCatalog } from '@/providers/broker/resourceTestCandidate';
import { projectManagedProviderBrokerApplication, resolveManagedProviderBrokerPurpose } from '@/providers/broker/applicationProjection';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RpcHandlerManager } from './RpcHandlerManager';
import type { RpcRequest } from './types';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary,
    installProviderConnectionsCatalogHttpBoundary } from '../../../../ui/sources/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal => {
    const { createSocketIoClientBoundary } = await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness');
    return createSocketIoClientBoundary(importOriginal);
});
// Keep Account admission and the registered CLI handler real while replacing
// the selected Machine's network delivery, as in the owning UI hook harness.
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: import('../../../../ui/sources/dev/testkit/harness/providerSettingsHarness').ProviderRpcRequest) => recipientRpc.machineRpc(request),
}));

const recipientRpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(recipientRpc);
const recipientAccount = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();

// The CLI harness resolves each host's source aliases from its importing file.
const forwarderPath = '../../../../server/sources/app/api/socket/serverRpcForwarder';
const eligibilityPath = '../../../../server/sources/app/teams/credentials/poolSourceEligibility';
const projectionPath = '../../../../server/sources/app/teams/credentials/providerModelProjection';
const { createServerRpcForwarder }: typeof import('../../../../server/sources/app/api/socket/serverRpcForwarder') = await import(forwarderPath);
const { createTeamCredentialPoolSourceEligibilityReader }: typeof import('../../../../server/sources/app/teams/credentials/poolSourceEligibility') = await import(eligibilityPath);
const { projectTeamCredentialProviderModels }: typeof import('../../../../server/sources/app/teams/credentials/providerModelProjection') = await import(projectionPath);

const accountId = 'account-1';
const machineId = 'machine-1';
const method = `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`;
const input = { machineId, teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 1,
    source: { kind: 'provider_connection' as const, connectionId: 'connection-1',
        connectionSecurityFingerprint: 'fingerprint-1', credentialSlotId: 'slot-1' }, scope: 'source_any' as const };
const eligible = { status: 'eligible' as const };

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });

function createDaemon() {
    let executions = 0;
    const manager = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId,
        encryptionKey: new Uint8Array(32).fill(43), encryptionVariant: 'dataKey', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId,
            // Model the installed identity and authenticated Home boundaries only.
            resolveCustodianAccountId: async () => accountId,
            resolveInstallationId: () => 'installation-1',
            verifyMachineAdmission: async () => true,
        }),
    });
    manager.registerHandler(RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY, params => {
        expect(params).toEqual(input);
        executions += 1;
        return eligible;
    });
    return { manager, executions: () => executions };
}

function createTransport(manager: RpcHandlerManager, replies: unknown[] = []) {
    // Socket.IO discovery/delivery is the only modeled server-to-daemon boundary.
    const target = { id: 'daemon-socket', timeout: () => ({ emitWithAck: async (event: string, request: RpcRequest) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.REQUEST);
        const reply = await manager.handleRequest(request);
        replies.push(reply);
        return reply;
    } }) };
    return { sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
        in: (room: string) => ({ timeout: () => ({ fetchSockets: async () =>
        room.startsWith(`rpc:${accountId}:${machineId}:`) ? [target] : [] }) }) } as unknown as Server;
}

describe('server-origin Machine reads across the E2EE RPC seam', () => {
    const verifyWorkerOnlySource = async (scenario: 'connected_source' | 'saved_provider') => {
        // The source uses upstream bearer auth; the brokered worker authenticates
        // to the local carrier with its raw capability header.
        const worker = await createManagedRunLaunchFixture({ acceptedCredentialFormats: ['bearer', 'raw'] });
        const home = await mkdtemp(join(tmpdir(), 'worker-only-source-catalog-'));
        try {
            const captured = readLeasedAgentProviderBindingAdapter({ lease: worker.lease, agentId: worker.agentId });
            if (!captured) throw new Error('Expected real external worker adapter');
            const registry = {
                generation: 7,
                contributes: {
                    agentDefinitionsById: worker.lease.registry.contributes.agentDefinitionsById,
                    providersByContributionKey: new Map([[`${gatewayManifest.id}/${CLIPROXYAPI_PROVIDER_CONTRIBUTION.id}`, {
                        identity: { pluginId: gatewayManifest.id, localId: CLIPROXYAPI_PROVIDER_CONTRIBUTION.id },
                        pluginId: gatewayManifest.id, definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
                        provenance: 'bundled', source: { kind: 'path' },
                    }]]),
                },
                activateContributionsOnDemand: async () => [],
                agentRuntimesByAgentId: worker.lease.registry.agentRuntimesByAgentId,
            } as unknown as ResolvedExecutablePluginRuntimeRegistry;
            const sourceOnlyRegistry = { ...registry, contributes: { ...registry.contributes,
                agentDefinitionsById: new Map(),
            }, agentRuntimesByAgentId: new Map() } as ResolvedExecutablePluginRuntimeRegistry;
            const target = { kind: 'group' as const, service: { pluginId: codexManifest.id, localId: 'openai-codex' }, groupId: 'source-pool' };
            const selectedAccount = { service: target.service, accountId: 'source-account' };
            const unused = async (): Promise<never> => { throw new Error('Unexpected source mutation or credential read'); };
            const purposeOwner = createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
                selectTarget: unused, materializeAccount: unused, projectTargetAccounts: unused,
                assertTargetAccountMaterializable: unused,
                resolveTarget: async (_target, signal) => { signal.throwIfAborted(); return {
                    account: selectedAccount, displayName: 'Source Pool', group: { groupId: target.groupId, generation: 1 },
                }; },
            });
            const { catalog } = splitProviderSettingsV1(ProviderSettingsV1Schema.parse(DEFAULT_PROVIDER_SETTINGS_V1));
            const snapshot = { ...worker.snapshot, providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog } };
            let installedAtBroker = true;
            const runtime = createRuntimeProviderModelManagementServices({ machineId, happyHomeDir: home,
                featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
                acquireRuntimeLease: async () => ({ registry: installedAtBroker ? registry : sourceOnlyRegistry,
                    source: 'active', durableRevision: -1, release: async () => {} }),
                resolveManagedPurposeBindingIntentSelection: purposeOwner.resolveBindingIntentSelection,
                modelSettingsMutation: unused,
            });
            const request = { machineId, agentTargetKey: worker.agentTargetKey,
                connectedAccountTarget: target, sourceCatalog: true as const, refreshPolicy: 'current_only' as const };
            const local = await runtime.projectModels(request);
            expect(local).toMatchObject({ status: 'success' });
            if (local.status !== 'success' || !local.groups[0]?.rows[0]?.application) throw new Error('Expected real source catalog');
            installedAtBroker = false;
            const application = local.groups.flatMap(group => group.rows)
                .find(row => row.application?.protocol === captured.support.acceptsProtocols[0])!.application!;
            const remote = await runtime.projectModels({ ...request, application });
            expect(remote).toMatchObject({ status: 'success' });
            if (remote.status !== 'success') throw new Error('Expected worker-only source projection');
            expect(remote.groups.map(group => ({ connectionId: group.connectionId, sourceRevision: group.sourceRevision,
                rows: group.rows.map(row => ({ descriptor: row.descriptor, compatibility: row.compatibility })) })))
                .toEqual(local.groups.filter(group => group.rows[0]?.application?.protocol === application.protocol)
                    .map(group => ({ connectionId: group.connectionId, sourceRevision: group.sourceRevision,
                        rows: group.rows.map(row => ({ descriptor: row.descriptor, compatibility: row.compatibility })) })));
            expect(remote.groups.every(group => group.rows.every(row =>
                JSON.stringify(row.application) === JSON.stringify(application)))).toBe(true);
            await expect(runtime.resolveTeamCredentialBrokerEligibility({ machineId, teamId: 'team-1', resourceId: 'resource-1',
                expectedResourceRevision: 1, scope: 'source_any', source: { v: 1, kind: 'connected_pool', target,
                    poolIncarnation: 'pool-incarnation' },
            })).resolves.toEqual({ status: 'eligible' });
            if (scenario === 'connected_source') {
            const offered = projectTeamCredentialProviderModels({ response: remote, resourceId: 'resource-1', teamId: 'team-1',
                resourceRevision: 1, agentTargetKey: worker.agentTargetKey, application, allowedModelIds: null,
                source: { v: 1, kind: 'connected_pool', target, poolIncarnation: 'pool-incarnation' }, deliveryMode: 'brokered' });
            expect(offered.status).toBe('success');
            const teamModel = offered.models[0]!;
            expect(teamModel.sourceFacts?.endpoint.protocol).toBe(application.protocol);
            const custodianSnapshot = { ...worker.snapshot };
            const recipientRuntime = createRuntimeProviderModelManagementServices({ machineId: worker.machineId,
                happyHomeDir: home, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => custodianSnapshot,
                acquireRuntimeLease: async () => ({ registry: worker.lease.registry, source: 'active', durableRevision: -1, release: async () => {} }),
                modelSettingsMutation: unused,
            });
            const workerRequest = { machineId: worker.machineId, agentTargetKey: worker.agentTargetKey,
                teamCredentialResources: [TeamCredentialResourceCatalogEntryV1Schema.parse({
                    id: 'resource-1', teamId: 'team-1', displayName: 'Team source', resourceRevision: 1,
                    readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
                    directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
                    connectedServiceSelections: [], sourcePresentation: null,
                    deliveryPolicy: { preferredAllowedModes: ['brokered'] }, allowedRoutes: ['brokered'],
                    providerModels: [teamModel],
                })], refreshPolicy: 'current_only' as const };
            const manager = new RpcHandlerManager({ scopePrefix: worker.machineId, localMachineId: worker.machineId,
                encryptionKey: new Uint8Array(32).fill(43), encryptionVariant: 'dataKey', logger: () => {} });
            registerMachineProviderRpcHandlers({ rpcHandlerManager: manager, machineId: worker.machineId,
                featureGate: { isEnabled: () => true }, services: { ...recipientRuntime,
                    prepareProfileMigrationSource: unused, describeConnections: unused, mutateConnection: unused,
                    previewProfileMigration: unused, confirmProfileMigration: unused, confirmProfileMigrationConflict: unused } });
            // Only Home HTTP and Socket delivery are substituted. B's captured
            // Account Action and C's registered worker projector are both real.
            const emptyCatalog = splitProviderSettingsV1(ProviderSettingsV1Schema.parse(DEFAULT_PROVIDER_SETTINGS_V1)).catalog;
            const { serverId } = await recipientAccount.restore({ accountId: 'requester-B', catalog: emptyCatalog });
            const recipientRow = installProviderConnectionsCatalogHttpBoundary({ home: recipientAccount.home, serverId, catalog: emptyCatalog });
            // CLI/MCP use their real Account catalog transport, independently
            // of the UI adapter, against the same B-owned persisted row.
            const credentials = { token: 'requester-B', encryption: null };
            const serverHttpBaseUrl = 'https://requester-b.invalid';
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
                snapshot: { ...worker.snapshot, scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
            const cliCatalog = () => recipientRow.catalog;
            const accountReads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
                expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
                expect(options?.headers).toMatchObject({ Authorization: 'Bearer requester-B' });
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                    mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
                    status: 'present', revision: 1, content: { t: 'plain', v: cliCatalog() } } };
                throw new Error(`Unexpected requester catalog read: ${path}`);
            });
            const cliExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                providerActionExecute: createCliProviderActionExecuteV1({ credentials, serverId, serverHttpBaseUrl, operationContext,
                    callMachineAction: request => manager.invokeLocal(request.method, request.request) }) });
            const { refreshPolicy, ...refreshRequest } = workerRequest;
            const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'providers.models.refresh': ['cli', 'mcp'] } });
            const readCli = (surface: 'cli' | 'mcp', actionId: 'providers.models.projection' | 'providers.models.refresh') =>
                cliExecutor.execute(actionId, { ...refreshRequest,
                    ...(actionId === 'providers.models.refresh' ? { forceRefresh: true } : { refreshPolicy }) },
                    { surface, serverId, authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings });
            recipientRpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request => {
                expect(request.accountId).toBe('requester-B');
                return manager.invokeLocal(request.method, request.payload);
            });
            const { describeProviderModels } = await import('../../../../ui/sources/providers/actions/client');
            const read = () => describeProviderModels({ ...workerRequest, serverId });
            const before = await read();
            expect(before, JSON.stringify(before)).toMatchObject({ status: 'success', groups: [], teamCredentialResources: [{ providerModels: [{
                selection: { modelId: teamModel.descriptor.id }, compatibility: { result: { status: 'experimental' }, confirmed: true },
            }] }] });
            if (before.status !== 'success') throw new Error('Expected worker admission projection');
            // D23: the worker qualifies Team models without reading or writing either Account's consent.
            expect(recipientRow.catalog.experimentalBindingConfirmations).toEqual([]);
            expect(custodianSnapshot.providerConnectionsCatalog?.catalog.experimentalBindingConfirmations ?? []).toEqual([]);
            for (const surface of ['cli', 'mcp'] as const) {
                for (const actionId of ['providers.models.projection', 'providers.models.refresh'] as const) {
                    const projected = await readCli(surface, actionId);
                    expect(projected, JSON.stringify(projected)).toMatchObject({ ok: true, result: {
                        status: 'success', groups: [], teamCredentialResources: [{ providerModels: [{ compatibility: { confirmed: true } }] }],
                    } });
                }
            }
            expect(recipientRow.catalog.experimentalBindingConfirmations).toEqual([]);
            expect(accountReads).not.toHaveBeenCalled();
            return;
            }
            // A saved Provider source must also describe its catalog without
            // the worker's executable contribution on the broker.
            const sourceContribution = worker.lease.registry.contributes.providersByContributionKey.values().next().value;
            if (!sourceContribution) throw new Error('Expected external source declaration');
            const nativeDefinition = { ...sourceContribution.definition };
            delete nativeDefinition.managedRuntime;
            const sourceProviders = new Map([...sourceOnlyRegistry.contributes.providersByContributionKey,
                [`${sourceContribution.identity.pluginId}/${sourceContribution.identity.localId}`, { ...sourceContribution, definition: nativeDefinition }] as const]);
            const sourceSettings = ProviderSettingsV1Schema.parse({ ...worker.providerSettings, machineGrants: [],
                connections: worker.providerSettings.connections.map(connection => ({ ...connection, deployment: { kind: 'external' } })) });
            const resolved = resolveProviderConnectionForMachine({ connectionId: worker.record.connectionId, machineId,
                providerSettings: sourceSettings, registry: { providersByContributionKey: sourceProviders },
                dnsEvidenceByEndpointUrl: new Map(nativeDefinition.endpointTemplates.flatMap(endpoint => endpoint.baseUrl
                    ? [[endpoint.baseUrl, ['1.1.1.1']] as const] : [])),
            });
            if (resolved.status !== 'resolved') throw new Error('Expected native Provider source');
            const providerSettings = ProviderSettingsV1Schema.parse({ ...sourceSettings, accountGrants: [{ v: 1,
                connectionId: worker.record.connectionId, connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
                confirmedAt: 1 }] });
            const providerSourceSnapshot = { ...worker.snapshot, providerConnectionsCatalog: { status: 'ready' as const,
                revision: 1, catalog: splitProviderSettingsV1(providerSettings).catalog } };
            const providerSourceRuntime = createRuntimeProviderModelManagementServices({ machineId, happyHomeDir: home,
                featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => providerSourceSnapshot,
                resolveAddresses: async () => ['1.1.1.1'], acquireRuntimeLease: async () => ({
                    registry: { ...sourceOnlyRegistry, contributes: { ...sourceOnlyRegistry.contributes,
                        providersByContributionKey: sourceProviders } },
                    source: 'active', durableRevision: -1, release: async () => {},
                }), modelSettingsMutation: unused });
            const sourceProjection = await providerSourceRuntime.projectModels({ machineId, agentTargetKey: worker.agentTargetKey,
                sourceCatalog: true, providerConnection: { connectionId: worker.record.connectionId,
                    expectedConnectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint },
                application, refreshPolicy: 'current_only',
            });
            expect(sourceProjection, JSON.stringify(sourceProjection)).toMatchObject({ status: 'success', groups: [{ rows: [{ descriptor: { id: 'model-a' } }] }] });
            await expect(providerSourceRuntime.resolveTeamCredentialBrokerEligibility({ machineId,
                teamId: 'team-1', resourceId: 'resource-provider', expectedResourceRevision: 1, scope: 'source_any',
                source: { v: 1, kind: 'provider_connection', connectionId: worker.record.connectionId,
                    connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, credentialSlotId: 'apiKey' },
            })).resolves.toEqual({ status: 'eligible' });
        } finally {
            recipientRpc.reset();
            await recipientAccount.reset();
            await worker.cleanup();
            await rm(home, { recursive: true, force: true });
        }
    };
    it('preserves source catalog and compatibility facts for an external Agent installed only on the worker', () => verifyWorkerOnlySource('connected_source'));
    it('preserves saved Provider source facts for an external Agent installed only on the worker', () => verifyWorkerOnlySource('saved_provider'));

    const verifyConnectedSource = async (scenario: 'admit' | 'admit_pool' | 'account' | 'pool' | 'installed' | 'saved_gateway' | 'revoked' | 'removed' | 'different_service' | 'no_selection') => {
        const home = await mkdtemp(join(tmpdir(), 'connected-codex-eligibility-'));
        try {
            // OPS8/OPS9's source picker selects this qualified Connected Account.
            // resourceSourceCandidates pins the credential row id as its incarnation.
            const service = { pluginId: 'happier.agent.codex', localId: scenario === 'different_service' ? 'other-service' : 'openai-codex' };
            const selectedAccount = { service, accountId: '97bd5614-8970-4068-87f2-1447de69d604' };
            const source = TeamCredentialSourceBindingV1Schema.parse(scenario === 'admit_pool' || scenario === 'pool' || scenario === 'removed' ? {
                v: 1, kind: 'connected_pool', target: { kind: 'group', service, groupId: 'pool-1' }, poolIncarnation: 'pool-incarnation-1',
            } : {
                v: 1, kind: 'connected_account',
                target: { kind: 'account', account: selectedAccount },
                credentialIncarnation: 'cmuwo1t4m000etm32p8ydij7j',
            });
            if (source.kind === 'provider_connection') throw new Error('Expected Connected Account/Pool source');
            const { catalog } = splitProviderSettingsV1(ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
                ...(scenario === 'saved_gateway' ? { connections: [{ v: 1, id: 'saved-gateway',
                    source: { kind: 'contribution', contributionKey: `${gatewayManifest.id}/${CLIPROXYAPI_PROVIDER_CONTRIBUTION.id}` },
                    role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', deployment: { kind: 'managedLocal' },
                    purposeBindingDefaults: { 'openai-upstream': source.target }, revision: 1, createdAt: 1, updatedAt: 1,
                }] } : {}),
            }));
            const snapshot = {
                source: 'cache' as const, settings: AccountSettingsSchema.parse({}),
                providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
                savedSecretResources: [], savedSecretCatalogState: 'ready' as const,
                settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'connected-codex-account',
            };
            setActiveAccountSettingsSnapshot(snapshot);
            const agent = codexManifest.contributes.agents.find(candidate => candidate.id === 'codex')!;
            const gateway = CLIPROXYAPI_PROVIDER_CONTRIBUTION;
            // Loaded-plugin and OS/storage boundaries only: use the actual bundled
            // declarations and Codex adapter, with no mocked projector/eligibility.
            const executable = {
                generation: 7,
                contributes: {
                    agentDefinitionsById: new Map([['codex', { id: 'codex', pluginId: codexManifest.id,
                        identity: { pluginId: codexManifest.id, localId: 'codex' }, definition: agent }]]),
                    providersByContributionKey: new Map([[`${gatewayManifest.id}/${gateway.id}`, {
                        identity: { pluginId: gatewayManifest.id, localId: gateway.id }, pluginId: gatewayManifest.id,
                        definition: gateway, provenance: scenario === 'installed' ? 'installed' : 'bundled', source: { kind: 'path' },
                    }]]),
                },
                activateContributionsOnDemand: async () => [],
                agentRuntimesByAgentId: new Map([['codex', {
                    pluginId: codexManifest.id, pluginVersion: codexManifest.version, agentId: 'codex',
                    generation: 'connected-codex-fixture', providerBinding: CODEX_PROVIDER_BINDING_ADAPTER_V1,
                    isCurrent: () => true, retirementSignal: new AbortController().signal,
                }]]),
            } as unknown as ResolvedExecutablePluginRuntimeRegistry;
            const unused = async (): Promise<never> => { throw new Error('Unexpected effect during eligibility'); };
            let targetReads = 0;
            const connectedAccounts = createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
                selectTarget: unused,
                resolveTarget: async (target, signal) => {
                    signal.throwIfAborted();
                    targetReads += 1;
                    if (scenario === 'no_selection' || ((scenario === 'revoked' || scenario === 'removed') && targetReads > 1)) return null;
                    return { account: selectedAccount, displayName: 'Happier Devs',
                        ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: 1 } } : {}),
                    };
                },
                materializeAccount: unused, projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
            });
            const runtime = createRuntimeProviderModelManagementServices({ machineId, happyHomeDir: home,
                featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
                runtimeStore: createProviderRuntimeStateStore({ happyHomeDir: home, machineId }),
                acquireRuntimeLease: async () => ({ registry: executable, source: 'active', durableRevision: -1, release: async () => {} }),
                resolveManagedPurposeBindingIntent: connectedAccounts.resolveBindingIntent,
                resolveManagedPurposeBindingIntentSelection: connectedAccounts.resolveBindingIntentSelection,
                modelSettingsMutation: unused,
            });
            const agentTargetKey = `agent:${codexManifest.id}/${agent.id}`;
            if (scenario === 'admit' || scenario === 'admit_pool') {
                const before = await runtime.projectModels({ machineId, agentTargetKey,
                    connectedAccountTarget: source.target, refreshPolicy: 'current_only', mode: 'management' });
                if (before.status !== 'success') throw new Error('Expected source catalog before confirmation');
                const group = before.groups[0]!;
                const row = group.rows.find(candidate => candidate.ref.modelId === 'gpt-5.5')!;
                expect(row.compatibility).toMatchObject({ result: { status: 'experimental' }, confirmed: false });
                await expect(runtime.resolveTeamCredentialResourceTestCandidate({ machineId,
                    teamId: input.teamId, resourceId: input.resourceId, expectedResourceRevision: 1,
                    source, refreshPolicy: 'current_only',
                })).resolves.toMatchObject({ status: 'success' });
                // The Account-row transport is in-memory; the actual Action parser,
                // confirmation semantics, strict catalog and CAS writer stay real.
                const confirmationSnapshot = snapshot;
                const confirm = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 2,
                    readCatalog: async () => confirmationSnapshot.providerConnectionsCatalog,
                    readDefinitions: async () => [],
                    writeCatalog: async value => {
                        expect(value.expectedRevision).toBe(confirmationSnapshot.providerConnectionsCatalog.revision);
                        confirmationSnapshot.providerConnectionsCatalog = { status: 'ready',
                            revision: value.expectedRevision + 1, catalog: value.catalog };
                        return { status: 'updated' };
                    },
                });
                expect(await confirm(parseProviderActionRequestV1('providers.models.experimental.confirm', {
                    action: 'confirmExperimental', connectionId: group.connectionId,
                    expectedConnectionRevision: group.connectionRevision, connectedAccountTarget: source.target,
                    agentTargetKey, modelId: row.ref.modelId,
                    compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
                }), {})).toMatchObject({ ok: true, result: { status: 'success' } });
                expect(snapshot.providerConnectionsCatalog.catalog.connections).toEqual([]);
            }
            const daemon = createDaemon();
            registerMachineProviderRpcHandlers({ rpcHandlerManager: daemon.manager, machineId,
                featureGate: { isEnabled: () => true }, services: { ...runtime,
                    prepareProfileMigrationSource: unused, describeConnections: unused, mutateConnection: unused,
                    previewProfileMigration: unused, confirmProfileMigration: unused, confirmProfileMigrationConflict: unused,
                },
            });
            const replies: unknown[] = [];
            const forward = createServerRpcForwarder({
                io: createTransport(daemon.manager, replies),
            });
            const readEligibility = createTeamCredentialPoolSourceEligibilityReader(forward);
            const result = await readEligibility({ custodianAccountId: accountId, machineIds: [machineId],
                teamId: input.teamId, resourceId: input.resourceId, resourceRevision: 1, source,
                scope: 'source_any', signal: new AbortController().signal });
            const projection = await runtime.projectModels({ machineId, agentTargetKey,
                connectedAccountTarget: source.target, refreshPolicy: 'current_only', mode: 'picker' });
            if (scenario === 'revoked' || scenario === 'removed' || scenario === 'different_service' || scenario === 'no_selection') {
                expect(projection).toMatchObject({ status: 'error', error: { code: 'provider_catalog_unavailable' } });
                expect(replies).toEqual([{ status: 'unavailable', reason: 'source_unavailable' }]);
                expect([...result.eligibleMachineIds]).toEqual([]);
                return;
            }
            expect(projection).toMatchObject({ status: 'success', agentTargetKey });
            if (scenario !== 'admit' && scenario !== 'admit_pool') {
                if (projection.status !== 'success') throw new Error('Expected source model projection');
                if (scenario === 'account' || scenario === 'pool' || scenario === 'installed' || scenario === 'saved_gateway') {
                    expect(projection.groups.length).toBeGreaterThan(0);
                    expect(projection.groups.every(group => group.authorization.authorized && group.rows.length > 0)).toBe(true);
                    const rows = projection.groups.flatMap(group => group.rows);
                    // CLIProxyAPI publishes the pinned SDK's explicit image-only capability.
                    // Unknown chat support still uses experimental confirmation.
                    const unsupported = rows.filter(row => row.descriptor.capabilities?.toolRoundTrips === 'unsupported');
                    expect(new Set(unsupported.map(row => row.ref.modelId))).toEqual(new Set(['gpt-image-1.5', 'gpt-image-2']));
                    for (const row of rows) {
                        expect(row.confidence).toBe('account_unverified');
                        expect(row.compatibility.confirmed).toBe(false);
                        expect(row.compatibility.result.status).toBe(
                            row.descriptor.capabilities?.toolRoundTrips === 'unsupported' ? 'incompatible' : 'experimental');
                        if (row.compatibility.result.status === 'incompatible') {
                            expect(row.compatibility.result.reasons).toContain('model_capability_toolRoundTrips_unsupported');
                        }
                    }
                    expect(projection.groups.map(group => group.connectionId)).not.toContain('saved-gateway');
                    expect(new Set(projection.groups.map(group => JSON.stringify(group.rows[0]?.application))).size).toBe(projection.groups.length);
                }
                expect(replies).toEqual([eligible]);
                expect([...result.eligibleMachineIds]).toEqual([machineId]);
                return;
            }
            const application = projectManagedProviderBrokerApplication({
                registry: resolveProviderContributionRegistryView(executable.contributes, executable.generation!),
                implementationIdentity: { pluginId: gatewayManifest.id, localId: gateway.id },
                agentTargetKey, protocol: 'openai-responses',
            });
            expect(application).not.toBeNull();
            if (!application) throw new Error('Expected admitted managed broker application');
            const family = resolveManagedProviderBrokerPurpose({
                registry: resolveProviderContributionRegistryView(executable.contributes, executable.generation!),
                application, service,
            });
            if (!family) throw new Error('Expected the declared Connected Account purpose');
            const selection = await connectedAccounts.resolveBindingIntentSelection({
                purpose: { consumer: application.implementationIdentity, purpose: family.purpose },
                target: source.target, serviceRefs: [service], signal: new AbortController().signal,
            });
            expect(await selection.isCurrent()).toBe(true);
            expect(replies).toEqual([eligible]);
            expect([...result.eligibleMachineIds]).toEqual([machineId]);
            if (projection.status !== 'success') throw new Error('Expected source model projection');
            expect(projection.groups.some(group => group.authorization.authorized && group.rows.length > 0)).toBe(true);
            const candidate = await forward({ userId: accountId,
                method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE}`,
                params: { machineId, teamId: input.teamId, resourceId: input.resourceId, expectedResourceRevision: 1,
                    source, refreshPolicy: 'current_only' },
            });
            expect(candidate.ok).toBe(true);
            if (!candidate.ok) throw new Error('Expected the registered candidate RPC to complete');
            expect(DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema.parse(candidate.result))
                .toMatchObject({ status: 'success' });
            await expect(forward({ userId: accountId,
                method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT}`,
                params: { machineId, source, refreshPolicy: 'current_only' },
            })).resolves.toMatchObject({ ok: true, result: { status: 'success' } });
            await expect(resolveTeamCredentialSourceModelCatalog({ machineId,
                teamId: input.teamId, resourceId: input.resourceId, resourceRevision: 1,
                source, application, projectModels: request => runtime.projectModels({ ...request, refreshPolicy: 'current_only' }),
            })).resolves.not.toBeNull();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    };

    it('admits a connected Codex source through the real model projector without a saved Provider connection', () => verifyConnectedSource('admit'));
    it('admits a confirmed connected Codex Pool through the same real projector', () => verifyConnectedSource('admit_pool'));
    it.each(['account', 'pool', 'installed', 'saved_gateway', 'revoked', 'removed', 'different_service', 'no_selection'] as const)(
        'projects only the current source-qualified SDK catalog, preserving experimental confirmation: %s', verifyConnectedSource,
    );

    it('composes the real server eligibility caller and forwarder with the E2EE daemon', async () => {
        const daemon = createDaemon();
        const replies: unknown[] = [];
        const io = createTransport(daemon.manager, replies);
        const readEligibility = createTeamCredentialPoolSourceEligibilityReader(createServerRpcForwarder({ io }));
        const result = await readEligibility({ custodianAccountId: accountId, machineIds: [machineId],
            teamId: input.teamId, resourceId: input.resourceId, resourceRevision: 1, source: input.source,
            scope: 'source_any', signal: new AbortController().signal });
        expect(replies).toEqual([eligible]);
        expect([...result.eligibleMachineIds]).toEqual([machineId]);
        expect(daemon.executions()).toBe(1);
    });

    it.each([
        RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE,
        RPC_METHODS.DAEMON_EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE,
        SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
    ])('admits the adjacent real server read through the same E2EE seam: %s', async readMethod => {
        const { manager } = createDaemon();
        const projection = { status: 'current', value: readMethod };
        manager.registerHandler(readMethod, () => projection);
        const forward = createServerRpcForwarder({ io: createTransport(manager) });
        expect(await forward({ userId: accountId, method: `${machineId}:${readMethod}`, params: { machineId } }))
            .toEqual({ ok: true, result: projection });
    });

    it('keeps arbitrary server-forwarded methods encrypted even with a valid read stamp', async () => {
        const { manager } = createDaemon();
        let executed = false;
        manager.registerHandler('demo.other', () => { executed = true; return { ok: true }; });
        const forward = createServerRpcForwarder({ io: createTransport(manager) });
        expect(await forward({ userId: accountId, method: `${machineId}:demo.other`, params: {} }))
            .toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED } });
        expect(await manager.handleRequest({ method: `${machineId}:demo.other`, params: {},
            authorization: { kind: 'machine.read.serverOrigin', accountId, machineId } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        expect(executed).toBe(false);
    });

    it('requires the installed Machine authorization boundary before opening a Home read', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId,
            encryptionKey: new Uint8Array(32).fill(43), encryptionVariant: 'dataKey', logger: () => {} });
        const forward = createServerRpcForwarder({ io: createTransport(manager) });
        expect(await forward({ userId: accountId, method, params: input }))
            .toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED } });
    });

    it('distinguishes retired RPC material from object rejection by the E2EE codec', async () => {
        const { manager } = createDaemon();
        expect(await manager.handleRequest({ method, params: input })).toEqual({
            error: 'Encrypted RPC binding is unavailable or invalid; update all Happier components',
            errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED,
        });
        manager.retireEncryptionContext();
        expect(await manager.handleRequest({ method, params: input })).toEqual({
            error: 'RPC encryption material is unavailable', errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED,
        });
    });

    it.each([
        { authorization: undefined, errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
        { authorization: { kind: 'machine.read.serverOrigin', accountId, machineId: 'machine-2' }, errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
        { authorization: { kind: 'machine.read.serverOrigin', accountId: 'account-2', machineId }, errorCode: RPC_ERROR_CODES.FORBIDDEN },
        { authorization: { kind: 'machine.read.serverOrigin', accountId, machineId, forged: true }, errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
    ])('refuses raw eligibility with absent or mis-bound authority: $authorization', async ({ authorization, errorCode }) => {
        const daemon = createDaemon();
        const reply = await daemon.manager.handleRequest({ method, params: input, authorization } as RpcRequest);
        expect(reply).toMatchObject({ errorCode });
        expect(daemon.executions()).toBe(0);
    });

    it('preserves ordinary encrypted eligibility calls', async () => {
        const { manager } = createDaemon();
        // Real bound codec, using an in-memory cipher boundary for the ordinary client path.
        const { encrypt, decrypt, encodeBase64, decodeBase64 } = await import('@/api/encryption');
        const key = new Uint8Array(32).fill(43);
        const content = { mode: 'e2ee' as const, cipher: {
            encryptRaw: async (value: unknown) => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async (value: string) => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const callId = '0123456789abcdef0123456789abcdef';
        const params = await socketRpcCodec.encodeParams(content, input, { method, callId });
        const result = await manager.handleRequest({ method, params });
        expect(typeof result).toBe('string');
        expect(await socketRpcCodec.decodeResult(content, { ok: true, result }, callId)).toEqual(eligible);
    });
});
