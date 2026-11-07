import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { nativeCaddyImage } from '@happier-dev/cli-common/machineSetup';
import { materializeCaddyDomainRouteV1 } from './targets/ownServer/caddyRouteMaterialization';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import axios from 'axios';
import { type ActionExecutorContext, encodeBase64,
    DeploymentEnvironmentCreateResultV1Schema, DeploymentTargetLinkResultV1Schema, DeploymentReceiptListResultV1Schema,
    DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptResultV1Schema } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createDeploymentEnvironmentV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_TEARDOWN_STEPS_V1, readDeploymentReceiptArtifactV1, type DeploymentTeardownResourceV1,
    type DeploymentTeardownStepProofV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentSocketHome, type DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { ApiClient } from '@/api/api';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import * as installationStore from '@/daemon/identity/store';
import { decodeStoredCredentials, encodeStoredCredentials, updateSettings } from '@/persistence';
import type { DeploymentTeardownBoundary } from './actions/teardown';
import type { OwnServerDeploymentRuntime } from './targets/ownServer/ownServerDeploymentTarget';
import { createOwnServerDeploymentRuntimeForHost, type OwnServerDeploymentRuntimeHostInput } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';
import { resolveOwnServerDeploymentIdentityForHost } from './targets/ownServer/paths';
import { resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerAutomationV3Routes } from '../../../server/sources/app/api/routes/automations/registerAutomationV3Routes';
import { registerWorkflowRunStorageRoutes } from '../../../server/sources/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { createS0DeploymentDaemonIngress } from './deploymentDaemonIngress.testkit';
import { createProductionDaemonWorkflowRuntime } from '@/daemon/workflows/daemonRuntime';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { resolveAutomationWorkerAccountEncryption } from '@/daemon/automation/automationWorker';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1, WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, projectExternalActionExecutionResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createDaemonExternalActionExecution, createRequesterAccountOperationContext, requiresPortableSessionSpawnServerIdentity } from '@/daemon/externalActions/execution';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { DeploymentDomainContentV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { db } from '../../../server/sources/storage/db';

// Unmounted capabilities throw if this finite native teardown reaches them.
// Every mounted domain owner below is real; only installation/process IO is supplied.
function unmounted<T>(name: string): T {
    const unavailable = () => { throw Object.assign(new Error(`Unexpected teardown capability: ${name}`),
        { code: `test_unmounted_${name.replaceAll(' ', '_')}` }); };
    return new Proxy(unavailable, { get: unavailable }) as T;
}

describe('deployment teardown through the canonical Action front door', () => {
    it('admits one irreversible general teardown Action for manual and preview callers', () => {
        const id = ActionIdSchema.safeParse('deployments.teardown');
        expect(id.success, 'General teardown must use the existing deployment Action family').toBe(true);
        if (!id.success) throw new Error('Missing general teardown Action');
        const spec = getActionSpec(id.data);
        expect(spec.serverTransport?.path).toBe('/v1/deployments/environments/:environmentId/teardown');
        expect(spec.irreversible).toBe(true);
    });

    describe('real Home receipt and Artifact custody', () => {
        let home: DeploymentSocketHomeFixture;
        beforeAll(async () => { home = await createDeploymentSocketHome({ configureApp: app => {
            registerAutomationV3Routes(app);
            registerWorkflowRunStorageRoutes(app);
        } }); }, 180_000);
        afterAll(async () => { vi.restoreAllMocks(); if (home) await home.close(); });

        const resolveRequesterIdentity: import('./readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver = async context => {
            const owner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => home.serverId,
                resolveHostIdentity: async () => ({ custodianAccountId: home.accountId, machineId: home.machineId,
                    installationId: home.installationId }) });
            const requester = await owner.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        };

        async function prepare(boundary?: DeploymentTeardownBoundary, resources: readonly DeploymentTeardownResourceV1[] = [],
            proofs: readonly DeploymentTeardownStepProofV1[] = [], options?: Readonly<{
                runtime: OwnServerDeploymentRuntime; definition: DeploymentEnvironmentContentV1['definition'];
                productionReplay?: boolean;
            }>) {
            await adoptServerProfileHomeConnectionDescriptor({
                descriptor: { v: 1, homeServerIdentityId: home.serverId, canonicalServerUrl: home.baseUrl,
                    revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
                expectedProfileId: configuration.activeServerId, createIfMissing: true, observation: 'exact',
            });
            const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: home.token, encryption: home.encryption }));
            if (!credentials) throw new Error('Canonical stored controller credentials required');
            const artifacts = createCredentialedAccountArtifactStore(credentials);
            const prepared = async (kind: string, content: unknown) => {
                const artifact = await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.create({
                    header: { kind, title: 'Teardown fixture' }, body: JSON.stringify(content),
                }));
                return { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                    contentBodyVersion: artifact.revision.bodyVersion };
            };
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                installationId: home.installationId, createdAt: 1,
                publicKey: encodeBase64(home.keys.publicKey, 'base64url'), privateKey: encodeBase64(home.keys.secretKey, 'base64url') });
            const sourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
                method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverId: home.serverId, requestKey: randomUUID(), name: 'Teardown source', audience: [],
                    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                        repository: { nameWithOwner: 'teardown/app', cloneUrl: 'https://github.com/teardown/app.git' }, protocol: 'https' } }),
            });
            const source = ProjectSourcesCreateOutputV1Schema.parse(await sourceResponse.json());
            if (!source.ok) throw new Error(source.error);
            const sample = createDeploymentEnvironmentV1();
            if (sample.content.t !== 'plain') throw new Error('Opened owner fixture required');
            if (options) sample.content.v.definition = options.definition;
            let nativeEffects = 0;
            const createDeploymentActionDeps: NonNullable<Parameters<typeof createS0DeploymentDaemonIngress>[0]['createDeploymentActionDeps']> = requester => createDaemonDeploymentActionDeps({ credentials: requester?.credentials ?? credentials, serverId: home.serverId,
                resolveRequesterIdentity,
                readOperation: (operationId, context) => ingress.actionOperations.readRestorePreparation({ operationId, context }),
                serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? home.baseUrl, machineId: home.machineId,
                ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
                ...(boundary ? { teardownBoundary: boundary } : {}),
                runtime: options?.runtime ?? { async acquire() { nativeEffects++; throw new Error('No teardown role is advertised'); } } });
            let ingress = await createS0DeploymentDaemonIngress({ home, createDeploymentActionDeps,
                resolveDeploymentRequesterIdentity: resolveRequesterIdentity });
            onTestFinished(() => ingress.close());
            const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                machineId: home.machineId, serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl });
            let teardownReviews = 0;
            const invoke = (name: string, input: unknown, unselectedCli = false) => {
                const actionId = ActionIdSchema.parse(name);
                return runWithServerHttpBaseUrl(home.baseUrl, async () => {
                    const caller = unselectedCli ? createCliActionExecutorFromCredentials({ credentials,
                        readCredentials: async () => credentials, externalActionClient: true,
                        serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl }) : executor;
                    const context = { surface: 'cli', authority: 'present_user',
                    serverId: home.serverId, serverIdentityId: home.serverId, runtimeAccountId: home.accountId,
                    actionRequestId: randomUUID(), ...(!unselectedCli ? { presentUserConfirmation: { actionId } } : {}) } satisfies ActionExecutorContext;
                    const result = await caller.execute(actionId, input, context);
                    if (result.ok && result.result !== null && typeof result.result === 'object'
                        && 'kind' in result.result && result.result.kind === 'approval_request_created'
                        && 'artifactId' in result.result) {
                        if (actionId === 'deployments.teardown') teardownReviews++;
                        const decided = options?.productionReplay && actionId === 'deployments.teardown'
                            ? await replayNativeApproval(String(result.result.artifactId))
                            : await caller.execute('approval.request.decide', {
                            artifactId: result.result.artifactId, decision: 'approve',
                        }, { ...context, actionRequestId: randomUUID() });
                        if (decided.ok && decided.result !== null && typeof decided.result === 'object'
                            && 'execution' in decided.result && decided.result.execution !== null
                            && typeof decided.result.execution === 'object' && 'executedAtMs' in decided.result.execution) {
                            const { executedAtMs: _executedAtMs, ...execution } = decided.result.execution;
                            const projected = projectExternalActionExecutionResultV1(execution);
                            if (!projected) throw new Error('Approval returned an invalid execution result');
                            return projected;
                        }
                        return decided;
                    }
                    return result;
                });
            };
            async function replayNativeApproval(artifactId: string) {
                const store = createCliApprovalsArtifactStore({ credentials, serverId: home.serverId, serverHttpBaseUrl: home.baseUrl });
                const request = await store.approvalsGet({ artifactId });
                if (!request) throw new Error('Review must retain its approval Artifact');
                expect(await store.approvalsUpdate({ artifactId, request: { ...request, status: 'approved',
                    updatedAtMs: Date.now(), decision: { kind: 'approve', decidedAtMs: Date.now(), authority: 'present_user',
                        decidingAccountId: home.accountId } } })).toMatchObject({ ok: true });
                const api = await ApiClient.create(credentials);
                const machine = await api.getMachine(home.machineId);
                if (!machine) throw new Error('The reviewed native Machine must exist');
                const client = api.machineSyncClient(machine);
                const cancellation = createDaemonShutdownCancellationDomains();
                const currentOrigin = async () => ({ machineId: home.machineId, serverIdentityId: home.serverId });
                try {
                    const createExecutor = createDaemonExternalActionExecution({
                        params: { credentials, machineId: home.machineId, serverId: home.serverId, serverBaseUrl: home.baseUrl,
                            getApiMachineForSessions: () => client, resolveCurrentMachineExecutionOriginContext: currentOrigin },
                        requiresPortableSessionSpawnServerIdentity,
                        requesterAccountOperationContext: createRequesterAccountOperationContext({ machineId: home.machineId,
                            custodianAccountId: home.accountId, installationIdentity: installationStore.readInstallationIdentityIfExistsSync() }),
                        acquireDaemonPluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                        shutdownCancellationDomains: cancellation, isSessionCallerCurrent: unmounted('Session caller'),
                        externalActionApprovalExecutionOriginCurrentness: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                            credentials, machineId: home.machineId, serverId: home.serverId, serverApiUrl: home.baseUrl,
                            resolveCurrentMachineExecutionOriginContext: currentOrigin }),
                        externalActionIngressOwner: ingress.externalActionIngressOwner, externalActionContributedApprovalReplay: null,
                        observeContributedPluginExecution: unmounted('plugin execution'), relayDiscussionAgentPublication: unmounted('discussion'),
                        externalActionInstallationIdentity: installationStore.readInstallationIdentityIfExistsSync(),
                        ownerRemainder: unmounted('process remainder'), isRuntimePublicationQuiescing: unmounted('publication'),
                        pluginRuntimeController: pluginReloadController,
                        connectedAccountRequestAuthRegistry: unmounted('Connected Account'),
                        requireConnectedAccountRequestAuthHttpPort: unmounted('Connected Account HTTP'),
                        localServicesActionFeatureGate: unmounted('local services gate'), localServicesRuntimeActionRoutes: unmounted('local services routes'),
                        localServicesRuntime: unmounted('local services runtime'), externalActionContributedInvoker: null,
                        externalActionContributedDefinitionLister: null, externalActionTranscriptFollowLeaseRegistry: null,
                    });
                    return await createExecutor(credentials).replayApprovedApprovalRequest({ artifactId,
                        callerAuthority: 'present_user', currentAccount: { accountId: home.accountId,
                            serverId: home.serverId, serverIdentityId: home.serverId } });
                } finally { client.shutdown(); }
            }
            const created = await invoke('deployments.environments.create', { serverId: home.serverId,
                projectSourceId: source.source.id, requestKey: randomUUID(), protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: home.machineId, buildMachineId: home.machineId,
                ...await prepared('deployment-environment.v1', sample.content.v) });
            if (!created.ok) throw new Error(`Fixture Environment creation: ${created.errorCode}`);
            const environment = DeploymentEnvironmentCreateResultV1Schema.parse(created.result);
            if (!environment.ok) throw new Error(environment.error);
            const linked = await invoke('deployments.targets.link', { serverId: home.serverId, environmentId: environment.environmentId,
                expectedRevision: environment.revision, requestKey: randomUUID(), role: 'runtime', targetId: 'own-server',
                machines: [{ machineId: home.machineId, installationId: home.installationId }],
                ...await prepared('deployment-target-link.v1', {}) });
            expect(linked.ok).toBe(true);
            if (!linked.ok) throw new Error(linked.errorCode);
            const link = DeploymentTargetLinkResultV1Schema.parse(linked.result);
            if (!link.ok) throw new Error(link.error);
            const content = createDeploymentReceiptDetailV1().content;
            const teardownContent = { ...content, machines: [home.machineId], buildMachineId: home.machineId,
                machineResults: [], teardown: { reason: 'manual', targetLinkRevision: link.targetLinkRevision,
                    machines: [{ machineId: home.machineId, installationId: home.installationId }], resources, proofs } };
            const input = { serverId: home.serverId, environmentId: environment.environmentId,
                expectedRevision: link.revision, targetLinkId: link.targetLinkId, expectedTargetLinkRevision: link.targetLinkRevision,
                requestKey: randomUUID(), reason: 'manual',
                ...await prepared('deployment-receipt.v1', teardownContent) };
            const freshInput = async () => {
                const current = await invoke('deployments.environments.get', { serverId: home.serverId,
                    environmentId: environment.environmentId });
                if (!current.ok) throw new Error(current.errorCode);
                const detail = DeploymentEnvironmentGetResultV1Schema.parse(current.result);
                if (!detail.ok) throw new Error(detail.error);
                return { ...input, expectedRevision: detail.environment.revision, requestKey: randomUUID(),
                    ...await prepared('deployment-receipt.v1', teardownContent) };
            };
            return { invoke, input, freshInput, environment, link, artifacts, prepared, environmentContent: sample.content.v,
                nativeEffects: () => nativeEffects, teardownReviews: () => teardownReviews,
                retainedOperation: (operationId: string) => ingress.actionOperations.store.get(
                    { accountId: home.accountId, machineId: home.machineId }, operationId),
                closeIngress: () => ingress.close(),
                reload: async () => { await ingress.close(); ingress = await createS0DeploymentDaemonIngress({ home, createDeploymentActionDeps,
                    resolveDeploymentRequesterIdentity: resolveRequesterIdentity }); } };
        }

        it.skipIf(process.platform === 'win32').each(['never-deployed', 'admitted-deployment'] as const)(
            'settles a native target with no Docker through real Home history (%s)', async scenario => {
                const root = await mkdtemp(join(tmpdir(), 'happier-teardown-no-docker-'));
                const previousHome = configuration.happyHomeDir;
                const previousSettings = configuration.settingsFile;
                const previousInstallation = configuration.installationIdentityFile;
                const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root,
                    controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
                const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: home.token, encryption: home.encryption }));
                if (!credentials) throw new Error('Canonical controller credentials required');
                try {
                    Reflect.set(configuration, 'happyHomeDir', root);
                    Reflect.set(configuration, 'settingsFile', join(root, 'settings.json'));
                    Reflect.set(configuration, 'installationIdentityFile', join(root, 'installation-identity.json'));
                    await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1,
                        installationId: home.installationId, createdAt: 1,
                        publicKey: encodeBase64(home.keys.publicKey, 'base64url'),
                        privateKey: encodeBase64(home.keys.secretKey, 'base64url') }), { mode: 0o600 });
                    const docker = scenario === 'admitted-deployment' ? await createOwnServerDockerBoundary(join(root, 'docker')) : undefined;
                    const image = docker ? await docker.registerImage('app', 'teardown') : undefined;
                    vi.stubEnv('PATH', docker ? `${join(root, 'docker')}${delimiter}${process.env.PATH ?? ''}` : join(root, 'no-tools'));
                    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: home.serverId,
                        resolveRequesterIdentity, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId,
                        async acquirePluginRuntimeRegistryLease() {
                            const lease = mounted.controller.tryAcquireRuntimeRegistry();
                            if (!lease) throw new Error('Installed runtime unavailable');
                            return lease;
                        } });
                    const document = JSON.stringify({ services: { app: { image: image?.registryReference ?? 'busybox:latest' } } });
                    const definition = { kind: 'stored' as const, contentRevision: 1, document,
                        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        services: ['app'], profiles: [] };
                    const fixture = await prepare(undefined, [], [], { runtime, definition });
                    await updateSettings(settings => ({ ...settings,
                        machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                            [configuration.activeServerId]: { ...settings.machineIdByServerIdByAccountId?.[configuration.activeServerId],
                                [home.accountId]: home.machineId } },
                        lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: home.accountId },
                    }));
                    if (scenario === 'admitted-deployment') {
                        const { reason: _reason, ...deployInput } = fixture.input;
                        const draft = { ...createDeploymentReceiptDetailV1().content, sourceIntent: definition,
                            machines: [home.machineId], buildMachineId: home.machineId, machineResults: [], images: image ? [image] : [],
                            onFailure: 'rollbackAll' as const };
                        if (docker && image) await docker.failImageHealth(image.configDigest);
                        expect(await fixture.invoke('deployments.deploy', { ...deployInput,
                            ...await fixture.prepared('deployment-receipt.v1', draft), requestKey: randomUUID() }))
                            .toMatchObject({ ok: false });
                        const listed = await fixture.invoke('deployments.receipts.list', { serverId: home.serverId,
                            environmentId: fixture.environment.environmentId });
                        if (!listed.ok) throw new Error(listed.errorCode);
                        const history = DeploymentReceiptListResultV1Schema.parse(listed.result);
                        expect(history).toMatchObject({ ok: true, items: [expect.objectContaining({ operation: 'deploy' })] });
                    }
                    vi.stubEnv('PATH', join(root, 'no-tools'));
                    const result = await fixture.invoke('deployments.teardown', { serverId: home.serverId,
                        environmentId: fixture.environment.environmentId, requestKey: randomUUID(), reason: 'manual' }, true);
                    const listed = await fixture.invoke('deployments.receipts.list', { serverId: home.serverId,
                        environmentId: fixture.environment.environmentId });
                    if (!listed.ok) throw new Error(listed.errorCode);
                    const history = DeploymentReceiptListResultV1Schema.parse(listed.result);
                    if (!history.ok) throw new Error(history.error);
                    const teardown = history.items.find(receipt => receipt.operation === 'teardown');
                    if (!teardown) throw new Error('Teardown must retain its canonical receipt');
                    const retained = readDeploymentReceiptArtifactV1(teardown, await runWithServerHttpBaseUrl(home.baseUrl,
                        () => fixture.artifacts.read(teardown.contentArtifactId,
                            { prepareRecipients: false, includeSharedAudience: false })));
                    if (!retained.ok) throw new Error(retained.error);
                    expect(retained.content.teardown?.proofs).toContainEqual(expect.objectContaining(scenario === 'never-deployed'
                        ? { step: 'removeTarget', state: 'succeeded', resources: [expect.objectContaining({ disposition: 'absent' })] }
                        : { step: 'removeTarget', state: 'outcome_unknown', reason: 'plugin_exec_system_tool_unavailable' }));
                    expect(result, JSON.stringify(result)).toMatchObject(scenario === 'never-deployed'
                        ? { ok: true, result: { ok: true, state: 'succeeded' } }
                        : { ok: false, errorCode: 'outcome_unknown', details: { step: 'removeTarget',
                            reason: 'plugin_exec_system_tool_unavailable' },
                            failureCause: { errorCode: 'plugin_exec_system_tool_unavailable' } });
                } finally {
                    Reflect.set(configuration, 'happyHomeDir', previousHome);
                    Reflect.set(configuration, 'settingsFile', previousSettings);
                    Reflect.set(configuration, 'installationIdentityFile', previousInstallation);
                    vi.unstubAllEnvs();
                    await mounted.dispose();
                    await rm(root, { recursive: true, force: true });
                }
            }, 180_000);

        it.skipIf(process.platform === 'win32').each(['manual', 'workflow', 'partial', 'healthy', 'network-in-use', 'reviewed-ingress-domains', 'reviewed-ingress-domain-retirement-fails', 'retained-retry-failed', 'retained-retry-unknown'] as const)('tears down the actual retained native generation through the Action without a supplied cleanup boundary (%s)', async caller => withSocketTempDir(async socketDirectory => {
            vi.stubEnv('HAPPIER_FEATURE_WORKFLOWS__ENABLED', '1');
            const root = await mkdtemp(join(tmpdir(), 'happier-teardown-native-'));
            const previousHome = configuration.happyHomeDir;
            const previousSettings = configuration.settingsFile;
            const previousInstallation = configuration.installationIdentityFile;
            const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root,
                controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
            const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: home.token, encryption: home.encryption }));
            if (!credentials) throw new Error('Canonical controller credentials required');
            try {
                Reflect.set(configuration, 'happyHomeDir', root);
                Reflect.set(configuration, 'settingsFile', join(root, 'settings.json'));
                Reflect.set(configuration, 'installationIdentityFile', join(root, 'installation-identity.json'));
                await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1,
                    installationId: home.installationId, createdAt: 1,
                    publicKey: encodeBase64(home.keys.publicKey, 'base64url'),
                    privateKey: encodeBase64(home.keys.secretKey, 'base64url') }), { mode: 0o600 });
                const retainedRetry = caller === 'retained-retry-failed' || caller === 'retained-retry-unknown';
                const retainedDomain = retainedRetry || caller === 'reviewed-ingress-domains' || caller === 'reviewed-ingress-domain-retirement-fails';
                let refuseDomainRemoval = caller === 'reviewed-ingress-domain-retirement-fails' || caller === 'retained-retry-failed';
                const domainRemovalReceiptStates: string[] = [];
                const socketPath = join(socketDirectory, 'admin.sock');
                const configPath = join(root, 'caddy.json');
                const nativeServer = { listen: [':9381'], automatic_https: { disable: true },
                    routes: [] as unknown[], errors: { routes: [] as unknown[] } };
                const caddyRequests: Array<{ method: string | undefined; path: string | undefined }> = [];
                const config = { admin: { listen: 'unix//run/teardown-domain/admin.sock|0660' },
                    apps: { http: { servers: { happier_private: nativeServer } } } };
                if (retainedDomain) {
                    await writeFile(configPath, JSON.stringify(config));
                    let version = 1;
                    const caddy = createServer(async (request, response) => {
                        caddyRequests.push({ method: request.method, path: request.url });
                        response.setHeader('ETag', `"${version}"`);
                        if (request.method === 'GET') {
                            response.end(JSON.stringify(request.url === '/config/' ? config : nativeServer)); return;
                        }
                        if (retainedRetry) {
                            const receipt = await db.deployment.findFirst({ where: { environmentId: fixture.environment.environmentId, operation: 'teardown' } });
                            domainRemovalReceiptStates.push(receipt?.state ?? 'missing');
                        }
                        if (refuseDomainRemoval) {
                            response.writeHead(503).end(); return;
                        }
                        const id = decodeURIComponent(request.url!.slice('/id/'.length));
                        const keep = (value: unknown) => !value || typeof value !== 'object' || !('@id' in value) || value['@id'] !== id;
                        nativeServer.routes = nativeServer.routes.filter(keep);
                        nativeServer.errors.routes = nativeServer.errors.routes.filter(keep);
                        version++; response.end();
                    });
                    await new Promise<void>((resolve, reject) => { caddy.once('error', reject); caddy.listen(socketPath, resolve); });
                    onTestFinished(() => new Promise<void>(resolve => caddy.close(() => resolve())));
                }
                const docker = await createOwnServerDockerBoundary(join(root, 'docker'), retainedDomain ? {
                    nativeCaddy: { Id: 'e'.repeat(64), Name: '/teardown-caddy', State: { Running: true },
                        Config: { Image: nativeCaddyImage, Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' },
                            Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'] },
                        HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [
                            { Type: 'bind', Source: socketDirectory, Target: '/run/teardown-domain' },
                            { Type: 'bind', Source: configPath, Target: '/etc/caddy/happier.json' } ] },
                        NetworkSettings: { Ports: {}, Networks: {} } },
                } : undefined);
                vi.stubEnv('PATH', `${join(root, 'docker')}${delimiter}${process.env.PATH ?? ''}`);
                const image = await docker.registerImage('app', 'teardown');
                const document = JSON.stringify({ services: { app: { image: image.registryReference,
                    ...(caller === 'healthy' ? { healthcheck: { test: ['CMD', 'true'] } } : {}) } } });
                const definition = { kind: 'stored' as const, contentRevision: 1, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                    services: caller === 'healthy' ? [] : ['app'], profiles: [] };
                const nativeHost = { credentials, serverId: home.serverId,
                    resolveRequesterIdentity,
                    serverHttpBaseUrl: home.baseUrl, machineId: home.machineId,
                    async acquirePluginRuntimeRegistryLease() {
                        const lease = mounted.controller.tryAcquireRuntimeRegistry();
                        if (!lease) throw new Error('Installed runtime unavailable');
                        return lease;
                    } } satisfies OwnServerDeploymentRuntimeHostInput;
                const runtime = createOwnServerDeploymentRuntimeForHost(nativeHost);
                const fixture = await prepare(undefined, [], [], { runtime, definition,
                    productionReplay: retainedDomain && !retainedRetry });
                await updateSettings(settings => ({ ...settings,
                    machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                        [configuration.activeServerId]: { ...settings.machineIdByServerIdByAccountId?.[configuration.activeServerId],
                            [home.accountId]: home.machineId } },
                    lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: home.accountId },
                }));
                const draft = { ...createDeploymentReceiptDetailV1().content, sourceIntent: definition,
                    machines: [home.machineId], buildMachineId: home.machineId, machineResults: [], images: [image], onFailure: 'rollbackAll' as const };
                if (retainedDomain) {
                    // Construct the already successful deployment at the private
                    // Home persistence boundary; deployment admission is separate
                    // from the reviewed teardown under test.
                    const deployedAt = new Date();
                    await db.deployment.create({ data: { environmentId: fixture.environment.environmentId,
                        targetLinkId: fixture.link.targetLinkId, operation: 'deploy', state: 'succeeded',
                        requestKey: randomUUID(), requestedByAccountId: home.accountId, actionOperationId: randomUUID(),
                        requestedAt: deployedAt, startedAt: deployedAt, settledAt: deployedAt,
                        ...await fixture.prepared('deployment-receipt.v1', draft) } });
                } else {
                    await docker.failImageHealth(image.configDigest);
                    const { reason: _reason, ...deployInput } = fixture.input;
                    const deployed = await fixture.invoke('deployments.deploy', { ...deployInput,
                        ...await fixture.prepared('deployment-receipt.v1', draft), requestKey: randomUUID() });
                    expect(deployed, JSON.stringify(deployed)).toMatchObject({ ok: false });
                }
                const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: root,
                    serverId: home.serverId, environmentId: fixture.environment.environmentId });
                if (retainedDomain) {
                    // The constructed successful deployment also retains its
                    // native working directory, as an actual deploy would.
                    await mkdir(identity.deploymentRoot, { recursive: true });
                }
                const historyBeforeTeardown = await fixture.invoke('deployments.receipts.list', { serverId: home.serverId,
                    environmentId: fixture.environment.environmentId });
                if (!historyBeforeTeardown.ok) throw new Error(historyBeforeTeardown.errorCode);
                const priorReceipts = DeploymentReceiptListResultV1Schema.parse(historyBeforeTeardown.result);
                if (!priorReceipts.ok || !priorReceipts.items[0]) throw new Error('The prior deployment must retain its receipt');
                const candidateProject = resolveNativeComposeCandidateProjectName(identity.projectName, priorReceipts.items[0].id);
                if (caller !== 'partial') {
                    // Native Docker is the external boundary: retain a labelled workload
                    // after the real failed receipt, including an interrupted candidate.
                    await docker.seedComposeGeneration(caller === 'manual' || caller === 'healthy' || retainedDomain ? identity.projectName
                        : candidateProject,
                    caller === 'healthy' || retainedDomain ? 'healthy' : undefined);
                }
                // Partial cleanup has only orphan networks; observing containers
                // alone must not skip removeTarget. Other callers also detach the
                // exact workload endpoint before native network removal.
                const ownedNetworks = ['a'.repeat(64), 'b'.repeat(64)];
                const retainedNetworks = ['c'.repeat(64), 'd'.repeat(64)];
                await docker.seedNetwork(ownedNetworks[0]!, identity.projectName,
                    caller === 'network-in-use' || caller === 'retained-retry-unknown' ? ['f'.repeat(64)] : caller === 'partial' ? [] : ['9'.repeat(64)]);
                await docker.seedNetwork(ownedNetworks[1]!, candidateProject);
                await docker.seedNetwork(retainedNetworks[0]!, `${identity.projectName}-other`);
                await docker.seedNetwork(retainedNetworks[1]!); // external, without project ownership
                const deletedVolume = `${identity.projectName}_delete`;
                const keptVolume = `${identity.projectName}_keep`;
                if (retainedRetry) {
                    await docker.seedVolume(deletedVolume, identity.projectName);
                    await docker.seedVolume(keptVolume, identity.projectName);
                }
                const retainedImageIds = await docker.readPruneImageIds();
                if (retainedDomain) {
                    // Persist the observed post-ingress/Domain shape at the real
                    // temporary Home database boundary. The failed add was unpublished;
                    // the later pending Domain is independent of workload ownership.
                    await db.deploymentEnvironment.update({ where: { id: fixture.environment.environmentId }, data: { revision: 5,
                        ...await fixture.prepared('deployment-environment.v1', { ...fixture.environmentContent,
                            ingress: { kind: 'cloudflareTunnel' } }),
                    } });
                    await db.deploymentTargetLink.update({ where: { id: fixture.link.targetLinkId }, data: { revision: 2,
                        state: 'deployed', activeDeploymentId: priorReceipts.items[0].id } });
                    const domainId = randomUUID();
                    const material = materializeCaddyDomainRouteV1({ domainId,
                        domain: { hostname: 'pending.teardown.test', target: { service: 'app', containerPort: 80 } },
                        listener: 'privateOrigin', upstreams: { kind: 'replicas', containerNames: ['retained-app'] }, privateSourceRanges: [] });
                    nativeServer.routes.push(material.route);
                    if (material.fallbackRoute) nativeServer.errors.routes.push(material.fallbackRoute);
                    await writeFile(configPath, JSON.stringify(config));
                    const domainContent = await fixture.prepared('deployment-domain.v1', DeploymentDomainContentV1Schema.parse({
                        hostname: 'pending.teardown.test', target: { service: 'app', containerPort: 80 },
                    }));
                    const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: fixture.environment.environmentId } });
                    const target = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: fixture.link.targetLinkId } });
                    await db.deploymentDomain.create({ data: { id: domainId, environmentId: fixture.environment.environmentId,
                        targetLinkId: fixture.link.targetLinkId, state: 'pending', createdByAccountId: home.accountId,
                        ...domainContent, capturedPlacements: [{ desired: true, listener: 'privateOrigin',
                            dockerEngineId: 's0-docker-engine', installationPublicKey: encodeBase64(home.keys.publicKey, 'base64url'),
                            placement: { serverId: home.serverId, accountId: home.accountId,
                                environmentId: environment.id, targetLinkId: target.id, domainId,
                                machineId: home.machineId, installationId: home.installationId,
                                actionOperationId: randomUUID(), requestId: randomUUID(), nativeServer: 'happier_private' },
                            content: domainContent,
                            environmentContent: { contentArtifactId: environment.contentArtifactId,
                                contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion },
                            targetLinkContent: { contentArtifactId: target.contentArtifactId,
                                contentHeaderVersion: target.contentHeaderVersion, contentBodyVersion: target.contentBodyVersion },
                        }] } });
                }
                const current = await fixture.invoke('deployments.environments.get', { serverId: home.serverId,
                    environmentId: fixture.environment.environmentId });
                if (!current.ok) throw new Error(current.errorCode);
                const detail = DeploymentEnvironmentGetResultV1Schema.parse(current.result);
                if (!detail.ok) throw new Error(detail.error);
                const link = detail.targetLinks.find(item => item.id === fixture.link.targetLinkId)!;
                const refusedDelete = await fixture.invoke('deployments.environments.delete', { serverId: home.serverId,
                    environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
                    requestKey: randomUUID() });
                expect(refusedDelete, JSON.stringify(refusedDelete)).toMatchObject({ ok: false, errorCode: 'deployment_teardown_required' });
                const input = { serverId: home.serverId, environmentId: detail.environment.id,
                    targetLinkId: link.id, expectedRevision: detail.environment.revision,
                    expectedTargetLinkRevision: link.revision, requestKey: randomUUID(), reason: 'manual' };
                let teardownAdmissions = 0;
                const homeResponses: Array<{ method: string | undefined; path: string; status: number; error?: string }> = [];
                const nativeRequest = axios.request;
                const admissionObserver = vi.spyOn(axios, 'request').mockImplementation(async request => {
                    if (request.method === 'POST' && request.url?.endsWith(`/environments/${detail.environment.id}/teardown`)) teardownAdmissions++;
                    const response = await nativeRequest(request);
                    const data: unknown = response.data;
                    homeResponses.push({ method: request.method, path: new URL(request.url!).pathname, status: response.status,
                        ...(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? { error: data.error } : {}) });
                    return response;
                });
                onTestFinished(() => admissionObserver.mockRestore());
                if (caller !== 'workflow') {
                    if (caller === 'healthy') {
                        // The CLI identity is a different Machine from the installed
                        // controller; omitting --machine-id must still review there.
                        await updateSettings(settings => ({ ...settings,
                            machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                                [configuration.activeServerId]: { ...settings.machineIdByServerIdByAccountId?.[configuration.activeServerId],
                                    [home.accountId]: 'private-cli-machine' } } }));
                    }
                    // UI and an unselected CLI name only the Environment; the
                    // controller prepares revisions, target and native inventory.
                    const tornDown = await fixture.invoke('deployments.teardown', caller === 'healthy' || retainedDomain
                        ? { serverId: home.serverId, environmentId: detail.environment.id, reason: 'manual', requestKey: input.requestKey,
                                ...(retainedDomain ? { removeEnvironment: true as const } : {}),
                                ...(retainedRetry ? { volumes: [
                                    { name: deletedVolume, disposition: 'delete', confirmation: deletedVolume },
                                    { name: keptVolume, disposition: 'keep' },
                                ] } : {}) }
                        : input, caller === 'healthy' || retainedDomain);
                    if (retainedRetry) {
                        const firstState = caller === 'retained-retry-failed' ? 'failed' : 'outcome_unknown';
                        expect(tornDown, JSON.stringify(tornDown)).toMatchObject({ ok: false });
                        const first = await db.deployment.findFirstOrThrow({ where: { environmentId: detail.environment.id, operation: 'teardown' } });
                        expect(first).toMatchObject({ state: firstState, requestKey: input.requestKey,
                            acceptedRequestEnvelopeDigest: expect.any(String), teardownProof: { removeEnvironment: true } });
                        expect(first.actionOperationId).toEqual(expect.any(String));
                        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: detail.environment.id } })).toMatchObject({ deletedAt: null });
                        expect(await docker.readVolumeNames()).toEqual([deletedVolume, keptVolume].sort());
                        if (caller === 'retained-retry-failed') {
                            expect(await db.deploymentDomain.findFirst({ where: { environmentId: detail.environment.id } }))
                                .toMatchObject({ state: 'removing', deletedAt: null });
                            expect((await docker.readInvocations()).filter(call => call.args[0] === 'rm'
                                || call.args[0] === 'network' && call.args[1] === 'rm')).toHaveLength(0);
                            refuseDomainRemoval = false;
                        } else {
                            expect(await db.deploymentDomain.count({ where: { environmentId: detail.environment.id, deletedAt: null } })).toBe(0);
                            // The unrelated endpoint leaves through Docker's external
                            // boundary; Retry must execute the still-unproved removal.
                            const statePath = join(root, 'docker', 'docker-state.json');
                            const state = JSON.parse(await readFile(statePath, 'utf8')) as { networks: Array<{ Id: string; Containers: Record<string, object> }> };
                            const network = state.networks.find(row => row.Id === ownedNetworks[0]);
                            if (!network) throw new Error('The unproved network must remain available to Retry');
                            delete network.Containers['f'.repeat(64)];
                            await writeFile(statePath, JSON.stringify(state));
                        }
                        // Fresh caller context omits the original private choices.
                        // The one retained host invocation owns those choices and its
                        // original signed carrier; Retry cannot silently review again.
                        const retryInput = { serverId: home.serverId, environmentId: detail.environment.id,
                            targetLinkId: link.id, requestKey: input.requestKey, reason: 'manual' };
                        const resumed = await fixture.invoke('deployments.teardown', retryInput, true);
                        expect(resumed, JSON.stringify({ resumed, homeResponses })).toMatchObject({ ok: true,
                            result: { ok: true, state: 'succeeded', environmentRemoved: true } });
                        const final = await db.deployment.findUniqueOrThrow({ where: { id: first.id } });
                        expect(final).toMatchObject({ state: 'succeeded', actionOperationId: first.actionOperationId,
                            requestKey: first.requestKey, acceptedRequestEnvelopeDigest: first.acceptedRequestEnvelopeDigest,
                            contentArtifactId: first.contentArtifactId });
                        expect(await db.deployment.count({ where: { environmentId: detail.environment.id, operation: 'teardown' } })).toBe(1);
                        expect(teardownAdmissions, 'Retry must consume the admitted receipt without a second Home begin').toBe(1);
                        expect(fixture.teardownReviews(), 'Retry must reuse the original confirmed review').toBe(1);
                        expect(domainRemovalReceiptStates.length).toBeGreaterThan(0);
                        expect(domainRemovalReceiptStates.every(state => state === 'running')).toBe(true);
                        expect(await db.deploymentDomain.count({ where: { environmentId: detail.environment.id, deletedAt: null } })).toBe(0);
                        expect(await docker.readRunningImageConfig('app')).toBeNull();
                        expect(await docker.readVolumeNames()).toEqual([keptVolume]);
                        for (const id of ownedNetworks) expect(await docker.readNetworkIds()).not.toContain(id);
                        expect(await docker.readNetworkIds()).toEqual(expect.arrayContaining(retainedNetworks));
                        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: detail.environment.id } }))
                            .toMatchObject({ deletedAt: expect.any(Date) });
                        expect(fixture.retainedOperation(first.actionOperationId!)).toMatchObject({ state: 'succeeded' });
                        expect(await fixture.invoke('deployments.teardown', retryInput, true)).toEqual(resumed);
                        expect(teardownAdmissions).toBe(1);
                        expect(fixture.teardownReviews()).toBe(1);
                        return;
                    }
                    if (retainedDomain) {
                        const outcome = JSON.stringify({ result: tornDown,
                            nativeCommands: (await docker.readInvocations()).map(call => call.args.slice(0, 2)), caddyRequests,
                            receipts: await db.deployment.findMany({ where: { environmentId: detail.environment.id },
                                select: { operation: true, state: true } }),
                            domains: await db.deploymentDomain.findMany({ where: { environmentId: detail.environment.id },
                                select: { state: true, deletedAt: true } }) });
                        if (caller === 'reviewed-ingress-domain-retirement-fails') {
                            expect(tornDown, outcome).toMatchObject({ ok: false,
                                details: { step: 'removeDomain', partial: true, domainHostname: 'pending.teardown.test',
                                    requiredFact: expect.any(String), remedy: expect.any(String) } });
                            expect(await db.deployment.findFirst({ where: { environmentId: detail.environment.id, operation: 'teardown' } }))
                                .toMatchObject({ state: 'failed' });
                            expect(await db.deploymentDomain.findFirst({ where: { environmentId: detail.environment.id } }))
                                .toMatchObject({ state: 'removing', deletedAt: null });
                            expect(await docker.readNetworkIds()).toEqual(expect.arrayContaining(ownedNetworks));
                            expect(await db.deploymentEnvironment.findUnique({ where: { id: detail.environment.id } }))
                                .toMatchObject({ deletedAt: null });
                            return;
                        }
                        // #80 IT Tools: the one confirmed teardown owns Domain
                        // retirement; no separately confirmed Remove prerequisite.
                        expect(tornDown, outcome).toMatchObject({ ok: true,
                            result: { ok: true, state: 'succeeded' } });
                        expect(await db.deploymentDomain.count({ where: { environmentId: detail.environment.id, deletedAt: null } })).toBe(0);
                        expect(await docker.readRunningImageConfig('app')).toBeNull();
                        for (const id of ownedNetworks) expect(await docker.readNetworkIds()).not.toContain(id);
                        // #82 Excalidraw: successful Stop and remove must finish the
                        // Environment removal within this same admitted operation.
                        expect(await db.deploymentEnvironment.findUnique({ where: { id: detail.environment.id } }))
                            .toMatchObject({ deletedAt: expect.any(Date) });
                        return;
                    }
                    if (caller === 'network-in-use') {
                        expect(tornDown).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
                        const receiptList = await fixture.invoke('deployments.receipts.list', { serverId: home.serverId,
                            environmentId: detail.environment.id });
                        if (!receiptList.ok) throw new Error(receiptList.errorCode);
                        const receipts = DeploymentReceiptListResultV1Schema.parse(receiptList.result);
                        if (!receipts.ok || !receipts.items[0]) throw new Error('Teardown must retain its failure receipt');
                        const retained = readDeploymentReceiptArtifactV1(receipts.items[0], await runWithServerHttpBaseUrl(home.baseUrl,
                            () => fixture.artifacts.read(receipts.items[0]!.contentArtifactId,
                                { prepareRecipients: false, includeSharedAudience: false })));
                        if (!retained.ok) throw new Error(retained.error);
                        expect(retained.content.teardown?.proofs).toContainEqual(expect.objectContaining({
                            step: 'removeTarget', state: 'outcome_unknown', reason: 'network_removal_unproved',
                        }));
                        expect(await docker.readNetworkIds()).toContain(ownedNetworks[0]);
                        return;
                    }
                    expect(tornDown, JSON.stringify(tornDown)).toMatchObject({ ok: true,
                        result: { ok: true, state: 'succeeded' } });
                } else {
                    await fixture.closeIngress();
                    const receiver = await createS0DeploymentDaemonIngress({ home,
                        createDeploymentActionDeps: requester => createDaemonDeploymentActionDeps({ ...nativeHost, runtime,
                            ...(requester ? { credentials: requester.credentials, serverHttpBaseUrl: requester.serverHttpBaseUrl,
                                savedSecretOperationContext: requester.savedSecretOperationContext } : {}) }) });
                    const cleanupAbort = new AbortController();
                    let cleanupExecution: Promise<unknown> | undefined;
                    try {
                        await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                            // A selected Require profile must survive controller dispatch even
                            // when Account policy would otherwise waive the agent confirmation.
                            const policy = await updateAccountSettingsV2WithRetry({ credentials,
                                mutation: { operations: [{ op: 'set', key: 'actionsSettingsV1', value: { v: 1, actions: {},
                                    approvalWaivedSurfaces: { 'deployments.teardown': ['agent'] } } }] } });
                            expect(policy.status).toBe('applied');
                            const runId = randomUUID();
                            const materialized = await materializeWorkflowAcceptedSnapshotV1({
                                definition: { version: 1, inputs: [], defaults: { approvalProfileId: 'builtin:read-propose' }, blocks: [{ kind: 'action', id: 'cleanup',
                                    actionId: 'deployments.teardown', input: Object.fromEntries(Object.entries(input)
                                        .map(([key, value]) => [key, { kind: 'literal' as const, value }])) }] },
                                context: { source: { kind: 'inline' }, inputs: {}, machineId: home.machineId,
                                    executionTarget: { kind: 'session' },
                                    // The accepted user snapshot is the Workflow boundary;
                                    // its starter is the authenticated fixture Home account.
                                    origin: { kind: 'direct', authenticatedStarterV1: { requestRef: runId,
                                        requester: { serverId: home.serverId, accountId: home.accountId } } },
                                    workspaceTarget: { project: { machineId: home.machineId, directory: root, checkoutRootPath: root } },
                                    authorization: { principal: { kind: 'host' } } },
                                admission: { kind: 'user' }, effects: {
                                    resolveTargetAvailability: async () => (await (await ApiClient.create(credentials)).getMachine(home.machineId))?.active === true,
                                    readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
                                },
                            });
                            if (!materialized.ok) throw new Error(`Cleanup Workflow admission: ${materialized.error.code}`);
                            expect(materialized.snapshot.approvedOperation).toBeUndefined();
                            const encryption = await resolveAutomationWorkerAccountEncryption({ token: home.token, credentials });
                            if (encryption.kind !== 'available') throw new Error('Cleanup Account currentness unavailable');
                            const storage = createWorkflowRunStorageClient({ token: home.token, machineId: home.machineId,
                                serverHttpBaseUrl: home.baseUrl });
                            const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                                mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: home.accountId, runId },
                                acceptedSnapshot: materialized.snapshot }));
                            await storage.execute({ operation: 'admit', publisherMachineId: home.machineId, runId,
                                origin: { kind: 'direct' }, machineId: home.machineId,
                                accountCurrentness: encryption.witness, acceptedEnvelope }, { publisherMachineId: home.machineId });
                            const claim = await createAutomationClaimClient({ token: home.token }).claimRun({
                                machineId: home.machineId, leaseDurationMs: 300_000, scope: 'workflow' });
                            if (!claim.run) throw new Error('Cleanup Workflow not claimed');
                            expect(claim.run.id).toBe(runId);
                            const coordinate = createProductionDaemonWorkflowRuntime({ credentials,
                                accountId: home.accountId, serverId: home.serverId }).createCoordinatorForMachine({
                                machineId: home.machineId, serverIdentityId: home.serverId,
                                installationIdentity: { installationId: home.installationId, privateKey: home.keys.secretKey },
                                machineActionDirectTargetTransport: receiver.machineActionDirectTargetTransport,
                                // This Action-only Workflow must never enqueue Session input.
                                machineAdmissionTransport: async () => { throw new Error('Unexpected cleanup Session input'); },
                            });
                            const execution = coordinate({ runId, attempt: claim.run.attempt, expectedRevision: claim.run.revision,
                                accountCurrentness: claim.accountCurrentness, acceptedEnvelope: claim.run.workflowAcceptedSnapshotEnvelope ?? undefined,
                                signal: cleanupAbort.signal });
                            cleanupExecution = execution;
                            // Normal Workflow provenance does not approve the irreversible native effect.
                            // Drive the real receiver's persisted Ask request through its public decision Action.
                            expect(await execution).toMatchObject({ state: 'paused', reason: 'approval_required' });
                            const page = await fixture.artifacts.list({ kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn],
                                approvalStates: ['open'] });
                            const approvalArtifactId = page.items[0]?.artifactId;
                            if (!approvalArtifactId) throw new Error('Cleanup Workflow must retain its Ask request');
                            const artifact = await fixture.artifacts.read(approvalArtifactId);
                            const approval = artifact && typeof artifact.body === 'string'
                                ? approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body) : null;
                            if (approval?.family !== 'built_in' || approval.request.v !== 2) throw new Error('Missing native cleanup approval');
                            expect(approval.request.executionOriginV1.externalActionExecutionAuthorization?.binding)
                                .toMatchObject({ actionId: 'deployments.teardown', machineId: home.machineId,
                                    workflowActionOrigin: { runId } });
                            expect((await docker.readInvocations()).some(call => call.args[0] === 'container' && call.args[1] === 'rm')).toBe(false);
                            const decided = await fixture.invoke('approval.request.decide', { artifactId: approvalArtifactId, decision: 'approve' });
                            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed' } });
                            const paused = await storage.execute({ operation: 'get', runId });
                            if (typeof paused !== 'object' || paused === null || !('run' in paused)) throw new Error('Missing paused Workflow');
                            const pausedRun = WorkflowRunSummaryV1Schema.parse(paused.run);
                            await storage.execute({ operation: 'resume', runId, expectedRevision: pausedRun.revision });
                            const resumed = await createAutomationClaimClient({ token: home.token }).claimRun({
                                machineId: home.machineId, leaseDurationMs: 300_000, scope: 'workflow' });
                            if (!resumed.run) throw new Error('Resumed cleanup Workflow not claimed');
                            cleanupExecution = coordinate({ runId, attempt: resumed.run.attempt, expectedRevision: resumed.run.revision,
                                accountCurrentness: resumed.accountCurrentness,
                                acceptedEnvelope: resumed.run.workflowAcceptedSnapshotEnvelope ?? undefined, signal: cleanupAbort.signal });
                            expect(await cleanupExecution).toMatchObject({ state: 'succeeded' });
                            expect(receiver.readReceivedMethods()).toContain(`${home.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`);
                        });
                    } finally {
                        cleanupAbort.abort();
                        await cleanupExecution?.catch(() => {});
                        await receiver.close();
                    }
                    await fixture.reload();
                }
                expect(await docker.readRunningImageConfig('app')).toBeNull();
                expect(await docker.readNetworkIds()).toEqual(retainedNetworks);
                expect(await docker.readPruneImageIds()).toEqual(retainedImageIds);
                const effects = await docker.readInvocations();
                const removals = effects.filter(call => call.args[0] === 'container' && call.args[1] === 'rm').length;
                if (caller === 'partial') expect(await docker.readRunningImageConfig('app')).toBeNull();
                else expect(removals).toBeGreaterThanOrEqual(1);
                expect(effects.some(call => call.args.includes('down') || call.args.includes('--volumes')
                    || call.args.includes('prune') || call.args[0] === 'volume' || call.args[0] === 'image' && call.args[1] === 'rm')).toBe(false);
                const replayed = await fixture.invoke('deployments.teardown', input);
                expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true,
                    result: { ok: true, state: 'succeeded' } });
                expect((await docker.readInvocations()).filter(call => call.args[0] === 'container' && call.args[1] === 'rm')).toHaveLength(removals);
                const settled = await fixture.invoke('deployments.environments.get', { serverId: home.serverId,
                    environmentId: detail.environment.id });
                if (!settled.ok) throw new Error(settled.errorCode);
                const currentDetail = DeploymentEnvironmentGetResultV1Schema.parse(settled.result);
                if (!currentDetail.ok) throw new Error(currentDetail.error);
                const history = await fixture.invoke('deployments.receipts.list', { serverId: home.serverId,
                    environmentId: detail.environment.id });
                if (!history.ok) throw new Error(history.errorCode);
                const receipts = DeploymentReceiptListResultV1Schema.parse(history.result);
                if (!receipts.ok || receipts.items[0]?.operation !== 'teardown'
                    || receipts.items[0].state !== 'succeeded') throw new Error('Signed teardown completion required');
                const deleted = await fixture.invoke('deployments.environments.delete', { serverId: home.serverId,
                    environmentId: detail.environment.id, expectedRevision: currentDetail.environment.revision,
                    teardownDeploymentIds: [receipts.items[0].id],
                    requestKey: randomUUID() });
                expect(deleted, JSON.stringify(deleted)).toMatchObject({ ok: true, result: { ok: true, detached: false } });
                expect(await fixture.invoke('deployments.environments.get', { serverId: home.serverId,
                    environmentId: detail.environment.id })).toMatchObject({ ok: true, result: { ok: true,
                    environment: { deletedAtMs: expect.any(Number), capabilities: { delete: false } } } });
            } finally {
                Reflect.set(configuration, 'happyHomeDir', previousHome);
                Reflect.set(configuration, 'settingsFile', previousSettings);
                Reflect.set(configuration, 'installationIdentityFile', previousInstallation);
                vi.unstubAllEnvs();
                await mounted.dispose();
                await rm(root, { recursive: true, force: true });
            }
        }), 180_000);

        it('refuses an unadvertised native teardown before allocating a receipt or changing link custody', async () => {
            const { invoke, input, environment, link, nativeEffects } = await prepare();
            const refused = await invoke('deployments.teardown', input);
            const history = await invoke('deployments.receipts.list', { serverId: home.serverId, environmentId: environment.environmentId });
            expect(history).toMatchObject({ ok: true, result: { ok: true, items: [] } });
            expect(nativeEffects()).toBe(0);
            const unchanged = await invoke('deployments.environments.get', { serverId: home.serverId, environmentId: environment.environmentId });
            expect(unchanged).toMatchObject({ ok: true, result: { environment: { revision: link.revision },
                targetLinks: [{ id: link.targetLinkId, revision: link.targetLinkRevision }] } });
            expect(refused).toMatchObject({ ok: false, errorCode: 'unsupported_action', effectAttempted: false,
                details: { reason: 'native_executor_unavailable', remedy: expect.any(String) },
                failureCause: { phase: 'deployment.teardown.admission' } });
        });

        it('resumes the first unproved owned step only from native facts, refusing caller-authored completion before receipt admission', async () => {
            let nativeEffects = 0;
            const boundary: DeploymentTeardownBoundary = {
                async observe() { nativeEffects++; return { kind: 'proved', resources: [] }; },
                async execute() { nativeEffects++; return { kind: 'proved', resources: [] }; },
            };
            const { invoke, input, environment } = await prepare(boundary, [], DEPLOYMENT_TEARDOWN_STEPS_V1.map(step => ({
                step, machineId: home.machineId, installationId: home.installationId, state: 'succeeded', resources: [],
            })));
            expect(await invoke('deployments.teardown', input)).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
            expect(nativeEffects).toBe(0);
            expect(await invoke('deployments.receipts.list', { serverId: home.serverId, environmentId: environment.environmentId }))
                .toMatchObject({ ok: true, result: { ok: true, items: [] } });
        });

        it.each(DEPLOYMENT_TEARDOWN_STEPS_V1)('reconciles response loss at %s with a fresh admitted cleanup after replacement, retaining shared data', async lostStep => {
            const completed = new Set<string>();
            const executions = new Map<string, number>();
            let lost = false;
            // The remote target/route/filesystem/grant transports are the genuine
            // boundary. Receipt admission, Artifact custody, step sequencing and
            // installation-signed transitions remain the production composition.
            const boundary: DeploymentTeardownBoundary = {
                async observe(request) {
                    return completed.has(request.step) ? { kind: 'proved', resources: request.resources.map(resource => ({
                        resourceId: resource.id, disposition: resource.disposition === 'retain' ? 'retained' : 'absent',
                    })) } : { kind: 'needed' };
                },
                async execute(request) {
                    executions.set(request.step, (executions.get(request.step) ?? 0) + 1);
                    completed.add(request.step);
                    if (request.step === lostStep && !lost) { lost = true; throw new Error('Remote reply lost after removal'); }
                    return { kind: 'proved', resources: request.resources.map(resource => ({ resourceId: resource.id,
                        disposition: resource.disposition === 'retain' ? 'retained' : 'absent' })) };
                },
            };
            const { invoke, input, freshInput, environment, artifacts, reload } = await prepare(boundary, [
                { id: 'owned-workload', machineId: home.machineId, kind: 'workload', ownership: 'owned', disposition: 'remove' },
                { id: 'shared-volume', machineId: home.machineId, kind: 'data', ownership: 'shared', disposition: 'retain' },
                { id: 'owned-release', machineId: home.machineId, kind: 'release', ownership: 'owned', disposition: 'remove' },
            ]);
            expect(await invoke('deployments.teardown', input)).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
                error: `${lostStep}: outcome_unknown` });
            await reload();
            expect(await invoke('deployments.teardown', input)).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
            const retry = await freshInput();
            const resumed = await invoke('deployments.teardown', retry);
            expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true, result: { ok: true, state: 'succeeded' } });
            expect([...executions.keys()]).toEqual([...DEPLOYMENT_TEARDOWN_STEPS_V1]);
            expect([...executions.values()]).toEqual(DEPLOYMENT_TEARDOWN_STEPS_V1.map(() => 1));
            const nativeRequest = axios.request;
            let transitionWrites = 0;
            const observer = vi.spyOn(axios, 'request').mockImplementation(async request => {
                if (request.method === 'POST' && request.url?.endsWith('/transitions')) transitionWrites++;
                return nativeRequest(request);
            });
            try {
                expect(await invoke('deployments.teardown', retry)).toEqual(resumed);
                expect(transitionWrites).toBe(0);
            } finally { observer.mockRestore(); }
            const history = await invoke('deployments.receipts.list', { serverId: home.serverId, environmentId: environment.environmentId });
            expect(history).toMatchObject({ ok: true, result: { ok: true, items: [
                { operation: 'teardown', state: 'succeeded' }, { operation: 'teardown', state: 'outcome_unknown' },
            ] } });
            if (!history.ok) throw new Error(history.errorCode);
            const page = DeploymentReceiptListResultV1Schema.parse(history.result);
            if (!page.ok || !page.items[0]) throw new Error('A completed teardown must retain its exact receipt');
            const retained = readDeploymentReceiptArtifactV1(page.items[0], await runWithServerHttpBaseUrl(home.baseUrl,
                () => artifacts.read(page.items[0]!.contentArtifactId, { prepareRecipients: false, includeSharedAudience: false })));
            if (!retained.ok) throw new Error(retained.error);
            expect(retained.content.teardown?.resources).toContainEqual(expect.objectContaining({ id: 'shared-volume', disposition: 'retain' }));
            expect(retained.content.teardown?.proofs.find(proof => proof.step === 'verify')?.resources)
                .toContainEqual({ resourceId: 'shared-volume', disposition: 'retained' });
        });

        it('does not replay an unknown removal, publish equal uncertainty, or continue after cancellation', async () => {
            const completed = new Set<string>();
            let removals = 0;
            const boundary: DeploymentTeardownBoundary = {
                async observe(request) { return completed.has(request.step) ? { kind: 'proved', resources: [] } : { kind: 'needed' }; },
                async execute(request) {
                    if (request.step === 'removeTarget') { removals++; throw new Error('Remote removal outcome unavailable'); }
                    completed.add(request.step);
                    return { kind: 'proved', resources: [] };
                },
            };
            const { invoke, input, environment } = await prepare(boundary, [
                { id: 'owned-workload', machineId: home.machineId, kind: 'workload', ownership: 'owned', disposition: 'remove' },
            ]);
            expect(await invoke('deployments.teardown', input)).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
            const nativeRequest = axios.request;
            let transitionWrites = 0;
            const observer = vi.spyOn(axios, 'request').mockImplementation(async request => {
                if (request.method === 'POST' && request.url?.endsWith('/transitions')) transitionWrites++;
                return nativeRequest(request);
            });
            try {
                expect(await invoke('deployments.teardown', input)).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
                expect(transitionWrites, 'Equal unknown observations must produce no receipt writes or publications').toBe(0);
            } finally { observer.mockRestore(); }
            expect(removals).toBe(1);
            const listed = await invoke('deployments.receipts.list', { serverId: home.serverId, environmentId: environment.environmentId });
            if (!listed.ok) throw new Error(listed.errorCode);
            const history = DeploymentReceiptListResultV1Schema.parse(listed.result);
            if (!history.ok || !history.items[0]) throw new Error('The same unknown receipt must remain in history');
            expect(await invoke('deployments.cancel', { serverId: home.serverId, environmentId: environment.environmentId,
                deploymentId: history.items[0].id, expectedReceiptRevision: history.items[0].revision }))
                .toMatchObject({ ok: true, result: { state: 'outcome_unknown' } });
            expect(await invoke('deployments.teardown', input)).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
            expect(removals).toBe(1);
            expect(completed.has('removeDomain')).toBe(false);
        });
    });
});
