import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SignKeyPair } from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import {
    DeploymentEnvironmentCreateResultV1Schema, DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1,
    type ActionExecutorContext, type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalExecutionV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AutomationDefinitionListResponseSchema, AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReportActionInputV1Schema,
    PluginAvailabilityMaterializationsReportActionOutputV1Schema, PluginAvailabilityCollectionWritersClaimActionInputV1Schema,
    PluginAvailabilityCollectionWritersClaimActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { projectPluginMachineMaterializationReportFactsV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import * as cloudflare from '../../../plugins/deploy-cloudflare/src/index';
import * as machineServices from '../../../plugins/machine-services/src/index';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { createRequesterBoundDeploymentActionDeps } from '../../../../apps/cli/src/daemon/externalActions/deploymentActionDeps';
import { createCliActionDeps } from '../../../../apps/cli/src/session/actions/createCliActionDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '../../../../apps/cli/src/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '../../../../apps/cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../../../../apps/cli/src/plugins/projection/registry/fullProjection';
import {
    createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader, listRuntimeContributedActionDefinitions,
} from '../../../../apps/cli/src/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createFilesystemEffectAdmission } from '../../../../apps/cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createActionSettingsProvider } from '../../../../apps/cli/src/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { createPluginRegistryStateStore } from '../../../../apps/cli/src/plugins/store/registry/currentState';
import { projectPluginInstalledAvailabilityInventory } from '../../../../apps/cli/src/plugins/availability/releaseLessDeclarations';
import { signPluginInstallationPublisherHeader } from '../../../../apps/cli/src/plugins/installations/publisherProof';
import {
    prepareExternalActionRequesterAccountAuthorizationWithEnvelope,
    verifyExternalActionExecutionAuthorizationCurrent,
} from '../../../../apps/cli/src/api/externalActionExecutionAuthorization';
import { prepareRequesterAccountActionContext } from '../../../../apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver }
    from '../../../../apps/cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import * as installationStore from '../../../../apps/cli/src/daemon/identity/store';

// The currentness update channel is a network boundary; Account admission,
// issuance, signing, HTTP validation and persistence all use the real owners.
vi.mock('socket.io-client', async original => {
    const actual = await original<typeof import('socket.io-client')>();
    const { createApiSessionSocketStub } = await import('../../../../apps/cli/src/testkit/backends/apiSessionSocketHarness');
    return { ...actual, io: () => createApiSessionSocketStub() };
});

type ServerBoundary = Readonly<{
    accountId: string; tokenEpoch: number; token: string; homeId: string; baseUrl: string;
    machines: readonly Readonly<{ id: string; installationId: string; keys: SignKeyPair }>[];
    createDeploymentProjectSource(): Promise<{ projectSourceId: string }>;
    createDeploymentArtifact(input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>): Promise<{
        contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number;
    }>;
    close(): Promise<void>;
}>;
// Keep the server's implementation and @/* alias behind its existing testkit.
const serverTestkitPath = '../../../../apps/server/sources/testkit/workflowApprovedOperationServer.testkit';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it('enrolls generic failure and success observers after a real Home-admitted Cloudflare Link through reviewed setup children', async () => {
    const { startWorkflowApprovedOperationServer } = await import(serverTestkitPath) as {
        startWorkflowApprovedOperationServer(input: { workflowSessions: true }): Promise<ServerBoundary>;
    };
    const server = await startWorkflowApprovedOperationServer({ workflowSessions: true });
    cleanups.push(() => server.close());
    const machine = server.machines[0]!;
    const credentials = { token: server.token, encryption: null };
    const serverId = server.homeId;
    const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
    // The installation key file is the OS boundary, not a substitute for the
    // server-issued authorization or the private reviewed-child proof.
    const installation = { version: 1 as const, createdAt: 1,
        installationId: machine.installationId, publicKey: Buffer.from(machine.keys.publicKey).toString('base64url'),
        privateKey: Buffer.from(machine.keys.secretKey).toString('base64url') };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
    const project = await server.createDeploymentProjectSource();
    const document = 'services: {}';
    const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Pages observer', retainPreviousDeployments: 1,
        definition: { kind: 'stored', document, contentRevision: 1,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: [] },
        bindings: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } });
    const artifact = await server.createDeploymentArtifact({ header: { kind: 'deployment-environment.v1', title: content.name },
        body: JSON.stringify(content) });
    const createdResponse = await fetch(`${server.baseUrl}/v1/deployments/environments`, { method: 'POST', headers,
        body: JSON.stringify({ serverId, projectSourceId: project.projectSourceId, requestKey: randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id, ...artifact }) });
    expect(createdResponse.status).toBe(200);
    const created = DeploymentEnvironmentCreateResultV1Schema.parse(await createdResponse.json());
    if (!created.ok) throw new Error(created.error);

    const mounted = await runWithServerHttpBaseUrl(server.baseUrl, async () => createAuthoredAdmittedPluginRuntimeFixture({
        runtimeOptions: {
            scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false }) },
            externalActionHomeBinding: { serverId, serverIdentityId: server.homeId },
            resolveCurrentMachineId: () => machine.id,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: server.homeId, machineId: machine.id }),
        },
        plugins: [{ manifest: cloudflare.manifest, includeAvailability: true,
            files: { '.happier-plugin/daemon.js': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: cloudflare.activate }) },
        { manifest: machineServices.manifest, includeAvailability: true,
            files: { '.happier-plugin/daemon.js': 'export function activate() {}',
                ...Object.fromEntries(await Promise.all((machineServices.manifest.contributes.resources ?? [])
                    .filter(resource => resource.kind === 'asset').map(async resource => [resource.path,
                        await readFile(new URL(`../../../plugins/machine-services/${resource.path}`, import.meta.url))]))) },
            instantiateCommittedModule: () => ({ activate: machineServices.activate }) }],
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    }));
    cleanups.push(() => mounted.dispose());
    // The isolated OS installation supplies its real registered key. Publish
    // the persisted serving census through Home's real signature/admission
    // boundary, then claim the exact admitted release-less declaration.
    const inventory = await createPluginRegistryStateStore({ happyHomeDir: mounted.happyHomeDir }).readAvailabilityInventory();
    const complete = projectPluginInstalledAvailabilityInventory({ inventory, registry: mounted.registry.contributes,
        registryRevision: mounted.lease.durableRevision,
        runtimeMaterializations: mounted.registry.readReleaseLessMaterializations?.() ?? [] });
    const reportPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.report'];
    const report = PluginAvailabilityMaterializationsReportActionInputV1Schema.parse({ expectedRevision: null,
        snapshot: { serverIdentityId: server.homeId, machineId: machine.id,
            materializations: complete.materializations.map(materialization => projectPluginMachineMaterializationReportFactsV1({
                ...materialization, serverIdentityId: server.homeId, machineId: machine.id })) } });
    const reported = await fetch(`${server.baseUrl}${reportPath}`, { method: 'POST',
        headers: { ...headers, [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: signPluginInstallationPublisherHeader({
            identity: installation, machineId: machine.id, path: reportPath, body: report }) }, body: JSON.stringify(report) });
    expect(reported.status).toBe(200);
    expect(PluginAvailabilityMaterializationsReportActionOutputV1Schema.parse(await reported.json()).outcome).toBe('replaced');
    const materialization = complete.materializations.find(item => item.pluginId === machineServices.manifest.id);
    if (!materialization) throw new Error('machine_services_materialization_unavailable');
    for (const installed of complete.materializations) {
        const claim = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse({ manifest: installed.declaredManifest });
        const claimed = await fetch(`${server.baseUrl}${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim']}`,
            { method: 'POST', headers, body: JSON.stringify(claim) });
        expect(claimed.status).toBe(200);
        PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(await claimed.json());
    }
    const source = { kind: 'plugin' as const, contribution: { pluginId: cloudflare.manifest.id, localId: 'pages' } };
    const input = DeploymentActionInputSchemasV1['deployments.targets.link'].parse({ serverId, environmentId: created.environmentId,
        expectedRevision: created.revision, requestKey: randomUUID(), source, targetId: 'pages', targetKind: 'cloudflare-pages',
        role: 'runtime', machines: [], provider: {
            credentialPrincipal: { kind: 'account', accountId: server.accountId,
                purpose: { consumer: { pluginId: cloudflare.manifest.id, localId: 'pages-link' }, purpose: 'deploy.manage' },
                target: { kind: 'account', account: { service: { pluginId: cloudflare.manifest.id, localId: 'cloudflare' },
                    accountId: 'linked-cloudflare-account' } } },
            providerIdentity: { providerAccountId: 'a'.repeat(32), providerResourceId: 'pages-observer', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' },
        } });
    const target = { kind: 'machine' as const, machineId: machine.id };
    const requestId = randomUUID();
    const minted = await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({ actionId: 'deployments.targets.link', input,
        requestId, target, machineId: machine.id, accountId: server.accountId, accountEncryptionMode: 'plain',
        tokenEpochHint: server.tokenEpoch, token: server.token, serverId, serverIdentityId: server.homeId,
        serverHttpBaseUrl: server.baseUrl, installationId: machine.installationId, privateKey: machine.keys.secretKey });
    if (!minted) throw new Error('link_home_admission_unavailable');
    const lifetime = new AbortController();
    cleanups.push(async () => { lifetime.abort(); });
    let executor: ReturnType<typeof createActionExecutor>;
    const prepareRequester = (retained: typeof minted.authorization) => prepareRequesterAccountActionContext({ authorization: retained,
        purpose: { kind: 'external_action' }, ownCredentials: credentials,
        machineId: machine.id, installationId: machine.installationId, installationPrivateKey: machine.keys.secretKey,
        serverId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl, signal: lifetime.signal,
        isCustodyCurrent: async () => !lifetime.signal.aborted,
        isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: retained,
            effectActionId: 'deployments.targets.link', target, privateKey: machine.keys.secretKey,
            installationId: machine.installationId, serverHttpBaseUrl: server.baseUrl }),
        createExecutor: () => ({ execute: (...args) => executor.execute(...args) }) });
    const requester = await prepareRequester(minted.authorization);
    if (!requester) throw new Error('link_requester_custody_unavailable');
    cleanups.push(() => requester.dispose());
    const authorization = requester.authorization;

    const filesystem = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => server.homeId,
        resolveHostIdentity: async () => ({ machineId: machine.id, installationId: machine.installationId,
            custodianAccountId: server.accountId }) });
    const acquire = () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry });
    const deployment = createRequesterBoundDeploymentActionDeps({ credentials, serverId, serverHttpBaseUrl: server.baseUrl, machineId: machine.id,
        runtime: { async acquire() { throw new Error('Provider Link cannot acquire a native runtime'); } },
        acquirePluginRuntimeRegistryLease: acquire,
        resolveRequesterIdentity: async context => {
            const current = await filesystem.resolveActionRequester!(context);
            try { return current.identity; } finally { await current.dispose(); }
        } });
    const cli = createCliActionDeps({ token: server.token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: server.baseUrl, token: credentials.token }),
        externalActionMachineInstallationId: machine.installationId, externalActionMachineRequestPrivateKey: machine.keys.secretKey,
        acquireAutomationEventObservationRegistry: acquire });
    const list: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> = selection =>
        listRuntimeContributedActionDefinitions(mounted.registry, selection);
    executor = createActionExecutor({ ...cli, ...deployment, listContributedActionDefinitions: list,
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: server.accountId,
            machineId: machine.id, serverId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: server.homeId, machineId: machine.id }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: server.baseUrl }),
            resolveCurrentPermissionMode: async () => 'default', externalActionMachinePublicKey: machine.keys.publicKey,
            verifyExternalExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                privateKey: machine.keys.secretKey, installationId: machine.installationId, serverHttpBaseUrl: server.baseUrl }),
            isAccountCurrent: async () => (await fetch(`${server.baseUrl}/v1/account/encryption`, { headers })).ok,
            listAccountApiTokens: async () => { throw new Error('Account Link has no API-token origin'); } }),
        prepareApprovalExecutionAuthorization: async ({ authorization: retained }) => {
            // Approval Artifact decoding drops private ports. Reacquire them
            // through the same real requester admission/projection as ingress.
            const custody = await prepareRequester(retained);
            if (!custody) return null;
            return { authorization: custody.authorization, dispose: () => custody.dispose(),
                actionsSettings: normalizeActionsSettingsV1(custody.actionsSettings),
                signExternalActionApprovalInput: ({ authorization: signed, ...request }) => signExternalActionApprovalInputV1({
                    ...request, authorizationToken: signed.token, privateKey: machine.keys.secretKey }) };
        },
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquire }) });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: server.accountId, serverId, serverIdentityId: server.homeId, actionRequestId: requestId,
        externalActionTarget: target, externalActionExecutionAuthorization: authorization, originalActionEnvelope: minted.envelope,
        signal: lifetime.signal, callerPermissionMode: 'default', actionsSettings: normalizeActionsSettingsV1(undefined),
        signExternalActionApprovalInput: ({ authorization: signed, ...request }) => signExternalActionApprovalInputV1({
            ...request, authorizationToken: signed.token, privateKey: machine.keys.secretKey }),
    };
    const proposed = await runWithServerHttpBaseUrl(server.baseUrl, () => executor.execute('deployments.targets.link', input, context));
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
    if (!proposed.ok) throw new Error(proposed.errorCode);
    const approval = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
    const decision = await runWithServerHttpBaseUrl(server.baseUrl, () => executor.execute('approval.request.decide', {
        artifactId: approval.artifactId, decision: 'approve',
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: server.accountId,
        serverId, serverIdentityId: server.homeId, signal: lifetime.signal }));
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
    if (!decision.ok || !decision.result || typeof decision.result !== 'object') throw new Error('link_approval_not_executed');
    const result = ApprovalExecutionV2Schema.parse(Reflect.get(decision.result, 'execution'));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.errorCode);
    const linked = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(result.result);
    expect(linked).toMatchObject({ ok: true, environmentId: created.environmentId });
    expect(linked).not.toHaveProperty('failureObserver');
    if (!linked.ok) throw new Error(linked.error);
    const response = await fetch(`${server.baseUrl}/v3/automations`, { headers });
    expect(response.status).toBe(200);
    const definitions = AutomationDefinitionListResponseSchema.parse(await response.json());
    expect(definitions.automations).toHaveLength(2);
    const enrolled = await Promise.all(definitions.automations.map(async definition => {
        const detailResponse = await fetch(`${server.baseUrl}/v3/automations/${definition.id}`, { headers });
        expect(detailResponse.status).toBe(200);
        return AutomationDefinitionDetailSchema.parse(await detailResponse.json());
    }));
    expect(enrolled).toEqual(expect.arrayContaining(Object.values(DEPLOYMENT_RECEIPT_EVENT_REFS_V1).map(eventRef =>
        expect.objectContaining({ observationOnly: { kind: 'observationOnly', deploymentEnvironment: {
            serverId, environmentId: created.environmentId, projectSourceId: project.projectSourceId } }, triggers: [expect.objectContaining({
            kind: 'pluginEvent', enabled: true, eventRef,
            observation: { kind: 'checkpointedPull', watcher: { machineId: machine.id,
                machineInstallationId: machine.installationId, pluginId: machineServices.manifest.id,
                materializationId: materialization.materializationId } },
        })] }))));
});
