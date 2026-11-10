import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeBase64 } from 'privacy-kit';
import { Server } from 'socket.io';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    DeploymentDomainMutationResultV1Schema, DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1,
    DeploymentTargetLinkInputV1Schema, DeploymentEnvironmentCreateInputV1Schema, DeploymentTransitionInputV1Schema } from '@happier-dev/protocol';
import { createActionExecutor, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentPlatformContentV1Schema, createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployment-protocol';
import { DeploymentTargetLinkProviderContentV1Schema, DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, createDeploymentDomainContentArtifactIdV1,
    createDeploymentLinkContentArtifactIdV1, createDeploymentEnvironmentContentArtifactIdV1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
    ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { startSocket } from '@/app/api/socket';
import type { ExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createReviewedChildAuthorizationFixture } from './reviewedChildAuthorization.composed.testkit';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { createCredentialedAccountArtifactStore } from '../../../../../../cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { readEnvironmentDomainSecretLaunchAdmissionForHost, readEnvironmentSecretLaunchAdmissionForHost,
    readEnvironmentSecretBindingPreparationForHost } from '../../../../../../cli/src/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import * as installationStore from '../../../../../../cli/src/daemon/identity/store';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { registerWorkflowRunStorageRoutes } from '../automations/registerWorkflowRunStorageRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { createWorkflowRunStorageClient } from '../../../../../../cli/src/daemon/workflows/workflowRunStorageClient';
import { registerManagedChildAuthorizationCharacterization } from './managedChildAuthorization.composed.testkit';
import { registerWorkflowChildAuthorizationCharacterization } from './workflowChildAuthorization.composed.testkit';
import { registerAccountChildAuthorizationComposedTests } from './accountChildAuthorization.composed.testkit';
import { createExternalActionSourceMachineRpcExecution, createExternalActionAuthorizedRequestHeaders,
    verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createNativeSessionTeamCredentialFixture } from '@/app/teams/credentials/sessionBinding.testkit';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { deriveWorkflowReplacementId } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { machinesRoutes } from '../machines/machinesRoutes';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { createDaemonDeploymentActionDeps } from '../../../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createActionOperationStore } from '../../../../../../cli/src/daemon/actionOperations/actionOperationStore';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { createAuthoredAdmittedPluginRuntimeFixture } from '../../../../../../cli/src/plugins/testkit/admittedRuntime';
import { createConnectedAccountPurposeBindingOwner } from '../../../../../../cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '../../../../../../cli/src/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';
import { prepareRequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutorHarness } from '../../../../../../cli/src/session/actions/createCliActionExecutorHarness';
import { createSnapshotActionSettingsProvider } from '../../../../../../cli/src/settings/actionsSettingsProvider';

describe('public roots through real reviewed-child packet producers', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reviewed-child-', initAuth: true, initEncrypt: true,
            initFiles: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });
    registerManagedChildAuthorizationCharacterization();
    registerWorkflowChildAuthorizationCharacterization();
    registerAccountChildAuthorizationComposedTests();

    async function deploymentFixture(options?: Readonly<{ sockets?: true }>) {
        const f = await createReviewedChildAuthorizationFixture();
        const serverId = await getOrCreateServerIdentityId();
        const source = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Reviewed child', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const artifact = async (kind = 'deployment-environment.v1', content: unknown = createDeploymentEnvironmentDetailV1().content,
            header: unknown = { kind, title: 'Reviewed child' }, artifactId: string = crypto.randomUUID()) => {
            const result = await createArtifact({ actorUserId: f.account.id, artifactId,
                header: decodeBase64(encodePlainArtifactStoredContent(header)),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: result.artifact.headerVersion,
                contentBodyVersion: result.artifact.bodyVersion };
        };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: f.account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: f.machine.id, buildMachineId: f.machine.id, ...await artifact() } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: f.account.id, role: 'runtime', state: 'deployed', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', machines: { create: [{ machineId: f.machine.id,
                installationId: f.machine.installationId!, position: 0, state: 'active' }] },
            ...await artifact('deployment-target-link.v1') } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const transitions: Array<{ path: string; body: unknown; status: number }> = [];
        const requests: Array<{ method: string; path: string; status: number }> = [];
        const dispatches: Array<Parameters<ExternalActionDaemonDispatcher>[0]> = [];
        app.addHook('onResponse', (request, reply, done) => {
            requests.push({ method: request.method, path: request.url, status: reply.statusCode });
            if (request.url.endsWith('/transitions')) transitions.push({ path: request.url, body: request.body, status: reply.statusCode });
            done();
        });
        registerExternalActionRoutes(app, { dispatch: async request => {
            // The daemon network is the boundary; the observer uses the actual receiver below.
            dispatches.push(request);
            return { kind: 'placement_error', code: 'target_unavailable' };
        } });
        registerDeploymentRoutes(app);
        registerWorkflowRunStorageRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerAccountProfileRoute(app);
        registerAccountSettingsRoutes(app);
        await machinesRoutes(app);
        await artifactsRoutes(app);
        if (options?.sockets) startSocket(app);
        await app.ready();
        const origin = options?.sockets ? await app.listen({ host: '127.0.0.1', port: 0 }) : f.origin;
        const deployInput = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
            ...await artifact('deployment-receipt.v1') };
        return { ...f, origin, serverId, source: source.source, environment, link, deployInput, artifact, resourceApp: app, transitions, requests, dispatches,
            close: async () => { try { if (app.machineDaemonPresence instanceof Server) await app.machineDaemonPresence.close(); }
                finally { await app.close(); await f.app.close(); } } };
    }

    it('settles a contributed-target observer through the real reviewed role and native transition producer', async () => {
        const f = await deploymentFixture({ sockets: true });
        const pluginId = 'example.platform';
        let purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
        // Persistence and remote provider credentials are boundaries; role admission and execution stay real.
        const unused = async (): Promise<never> => { throw new Error('Observation must not acquire provider credentials or a workspace'); };
        const connectedAccounts = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => purposeBindings, update: async mutate => (purposeBindings = mutate(purposeBindings)),
                subscribe: () => ({ dispose() {} }) }, selectTarget: unused,
            resolveTarget: async target => target.kind === 'account' && target.account.service.pluginId === pluginId
                && target.account.service.localId === 'service' && target.account.accountId === 'credential'
                ? { displayName: 'Observer provider', account: target.account } : null,
            materializeAccount: unused, materializeNative: unused, projectTargetAccounts: unused,
            assertTargetAccountMaterializable: unused,
        });
        const roles = ['inspect', 'link', 'deploy', 'observe'] as const;
        const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ runtimeOptions: {
            resolveCurrentMachineId: () => f.machine.id, connectedAccounts, actionFormConnectedAccounts: connectedAccounts }, plugins: [{
            manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Observer provider',
                entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts',
                    reason: 'Read linked deployment state', scope: { serviceRefs: ['service'], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
                contributes: { connectedAccountDescriptors: [{ id: 'service', title: 'Provider account', authentication: {
                    defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] } }],
                    actions: roles.map(id => ({ id, title: id, scopes: ['global'], surfaces: ['plugin'], placementBindings: [],
                        execution: { target: 'daemon' }, hostAccess: ['manage'],
                        connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }],
                        dangerLevel: id === 'inspect' || id === 'observe' ? 'safe' : 'writesLocal',
                        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[id].jsonSchema,
                        resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema })),
                    deploymentTargets: [{ id: 'runtime', title: 'Provider', icon: 'server-outline', role: 'runtime', targetKind: 'platform',
                        targetSchema: { type: 'object', properties: {}, additionalProperties: false },
                        linkSchema: { type: 'object', properties: {}, additionalProperties: false },
                        actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' } }] } },
            files: { 'daemon.mjs': `export function activate(api) {
                ${roles.map(role => `api.actions.register('${role}', async () => ({ v: 1, state: 'succeeded',
                    providerDeploymentId: 'existing-provider-deployment', observedAtMs: 2 }));`).join('\n')}
                api.connectedAccounts.register('service', {
                    authentication: { modes: { manual: { kind: 'manual', async complete() { return { status: 'connected', displayName: 'Provider', scopes: [] }; } } } },
                    async status() { return { status: 'connected', displayName: 'Provider', scopes: [] }; },
                    async refresh() { return { status: 'connected', displayName: 'Provider', scopes: [] }; },
                    async revoke() { return { status: 'remoteUnsupported' }; },
                    async materialize() { throw new Error('Observation does not materialize credentials'); }
                });
            }` } }] });
        const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
            privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
        try {
            expect(runtime.registry.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId: f.account.id,
                purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'manage' },
                target: { kind: 'account', account: { service: { pluginId, localId: 'service' }, accountId: 'credential' } } },
                providerIdentity: { providerAccountId: 'provider-account', providerResourceId: 'project', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'production' } });
            await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { sourceKind: 'plugin', pluginId,
                contributionLocalId: 'runtime', hostTargetId: null, targetKind: 'platform', machineId: f.machine.id,
                installationId: f.machine.installationId, ...await f.artifact('deployment-target-link.v1', provider), machines: { deleteMany: {} } } });
            const content = DeploymentPlatformContentV1Schema.parse({ sourceIntent: { ...createDeploymentReceiptDetailV1().content.sourceIntent,
                projectSourceId: f.source.id, sourceRevision: f.source.revision },
                sourceMethod: 'gitIntegration', machines: [], images: [], machineResults: [], steps: [],
                platform: { targetLinkRevision: f.link.revision, ...provider,
                    observation: { v: 1, state: 'running', providerDeploymentId: 'existing-provider-deployment', observedAtMs: 1 } } });
            const input = { ...f.deployInput, ...await f.artifact('deployment-receipt.v1', content,
                createDeploymentReceiptArtifactHeaderV1('Observer receipt', content)) };
            const root = await f.root('deployments.deploy', input);
            const path = `/v1/deployments/environments/${f.environment.id}/deploy`;
            const body = { ...input, actionOperationId: crypto.randomUUID() };
            const admitted = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(root, { effectActionId: 'deployments.deploy', method: 'POST', path, body }) });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const receipt = await db.deployment.findFirstOrThrow({ where: { environmentId: f.environment.id } });
            // The remote provider has already begun this admitted deployment.
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'running' } });
            const observationInput = { serverId: f.serverId, environmentId: f.environment.id, deploymentId: receipt.id };
            const rootObserver = await f.root('deployments.receipts.observe', observationInput);
            const receiptReadPath = `/v1/deployments/receipts/${receipt.id}?serverId=${f.serverId}&environmentId=${f.environment.id}`;
            for (const [method, readPath, status] of [
                ['GET', receiptReadPath, 200],
                ['GET', receiptReadPath.replace(f.environment.id, crypto.randomUUID()), 401],
                ['GET', receiptReadPath.replace(f.serverId, crypto.randomUUID()), 401],
                ['GET', `${receiptReadPath}&include=all`, 401],
                ['HEAD', receiptReadPath, 401],
            ] as const) {
                const response = await f.resourceApp.inject({ method, url: readPath,
                    headers: await f.headers(rootObserver, { effectActionId: 'deployments.receipts.observe', method, path: readPath }) });
                expect(response.statusCode, `${method} ${readPath}: ${response.body}`).toBe(status);
            }
            const acquire = async () => { const lease = runtime.controller.tryAcquireRuntimeRegistry();
                if (!lease) throw new Error('Observer registry retired'); return lease; };
            const deps = createDaemonDeploymentActionDeps({ credentials: { token: f.presentUserToken, encryption: null },
                serverId: f.serverId, serverHttpBaseUrl: f.origin, machineId: f.machine.id,
                acquirePluginRuntimeRegistryLease: acquire, resolveRequesterIdentity: unused, runtime: { acquire: unused } });
            const actionDeps = { ...createUnavailableActionTransportDeps(), ...deps,
                listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquire }) } satisfies Parameters<typeof createActionExecutor>[0];
            const executor = createActionExecutor(actionDeps);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: rootObserver.binding.requestId,
                target: rootObserver.binding.target, input: observationInput });
            await f.resourceApp.inject({ method: 'POST', url: `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}deployments.receipts.observe`,
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: envelope });
            expect(f.dispatches).toHaveLength(1);
            const dispatch = f.dispatches[0];
            const received = await runWithServerHttpBaseUrl(f.origin, () => executeExternalAction({
                actionId: dispatch.actionId, envelope: dispatch.envelope, principal: dispatch.principal,
                executionAuthorization: rootObserver, executor, currentMachineId: f.machine.id,
                currentInstallationId: f.machine.installationId!, currentServerId: f.serverId,
                currentAccountId: f.account.id, currentServerHttpBaseUrl: f.origin, surface: 'cli',
                externalActionMachineRequestPrivateKey: f.keyPair.secretKey,
                verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input, installationId: f.machine.installationId!,
                    privateKey: f.keyPair.secretKey, serverHttpBaseUrl: f.origin }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: f.presentUserToken, encryption: null }, serverApiUrl: f.origin }),
                prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input, purpose: input.purpose ?? { kind: 'external_action' },
                        machineId: f.machine.id, installationId: f.machine.installationId!, installationPrivateKey: f.keyPair.secretKey,
                        serverId: f.serverId, serverIdentityId: f.serverId, serverHttpBaseUrl: f.origin,
                        ownCredentials: { token: f.presentUserToken, encryption: null },
                        isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: input.authorization, effectActionId: input.authorization.binding.actionId,
                            target: input.authorization.binding.target, installationId: f.machine.installationId!,
                            privateKey: f.keyPair.secretKey, serverHttpBaseUrl: f.origin }),
                        createExecutor: admitted => createCliActionExecutorHarness({ token: admitted.credentials.token,
                            credentials: admitted.credentials, sessionId: '', mode: 'plain', ctx: null,
                            serverId: f.serverId, serverIdentityId: f.serverId, serverHttpBaseUrl: admitted.serverHttpBaseUrl,
                            actionsSettingsProvider: createSnapshotActionSettingsProvider(() => {
                                const snapshot = admitted.savedSecretOperationContext.readSnapshot();
                                if (!snapshot) throw new Error('Observer requester Account context retired');
                                return snapshot;
                            }),
                        }, actionDeps).executor }),
            }));
            expect(received, JSON.stringify({ received, requests: f.requests })).toMatchObject({ kind: 'response' });
            if (received.kind !== 'response' || received.response.v !== 1) throw new Error('Observer must return its public response');
            const result = received.response.execution;
            expect(result, JSON.stringify({ result, requests: f.requests })).toMatchObject({ ok: true, result: { state: 'succeeded', deploymentId: receipt.id } });
            expect((await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).state).toBe('succeeded');
            expect(f.transitions).toHaveLength(1);
            expect(f.transitions[0].status).toBe(200);
            const wire = DeploymentTransitionInputV1Schema.parse(f.transitions[0].body);
            const foreignPath = f.transitions[0].path.replace(receipt.id, crypto.randomUUID());
            const refused = await f.resourceApp.inject({ method: 'POST', url: foreignPath, payload: wire,
                headers: await f.headers(rootObserver, { effectActionId: 'deployments.receipts.observe', method: 'POST', path: foreignPath, body: wire }) });
            expect(refused.statusCode, refused.body).toBe(401);
        } finally { identity.mockRestore(); await runtime.dispose(); await f.close(); }
    });

    it.each(['deployments.deploy', 'deployments.rollback', 'deployments.promote', 'deployments.teardown'] as const)(
        'admits joining-member Domain discovery through the public plain %s issuer within its signed Home and Environment', async actionId => {
        const f = await deploymentFixture();
        const restoreHttp = installAxiosFastifyAdapter({ app: f.resourceApp, origin: f.origin });
        const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
            privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
        try {
            const document = JSON.stringify({ services: { nginx: { image: 'nginx:alpine' } } });
            const definition = { kind: 'stored' as const, contentRevision: 1, document,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['nginx'] };
            await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: await f.artifact(
                'deployment-environment.v1', { ...createDeploymentEnvironmentDetailV1().content, definition }) });
            await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: {
                ...await f.artifact('deployment-target-link.v1', createDeploymentEnvironmentDetailV1().targetLinks[0]!.content),
                machines: { updateMany: { where: { machineId: f.machine.id }, data: { state: 'joining' } } } } });
            const sourceEnvironment = actionId === 'deployments.promote'
                ? await db.deploymentEnvironment.create({ data: { ...f.environment, id: crypto.randomUUID(),
                    runtimeTargetLinkId: null, ...await f.artifact() } }) : f.environment;
            const sourceLink = actionId === 'deployments.promote'
                ? await db.deploymentTargetLink.create({ data: { environmentId: sourceEnvironment.id,
                    createdByAccountId: f.account.id, role: 'runtime', state: 'deployed', sourceKind: 'host',
                    hostTargetId: 'own-server', targetKind: 'ownServer', ...await f.artifact('deployment-target-link.v1') } }) : f.link;
            const sourceReceipt = actionId === 'deployments.rollback' || actionId === 'deployments.promote'
                ? await db.deployment.create({ data: { environmentId: sourceEnvironment.id, targetLinkId: sourceLink.id,
                    operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
                    requestedByAccountId: f.account.id, ...await f.artifact('deployment-receipt.v1') } }) : null;
            const preparedInput = actionId === 'deployments.rollback' ? { ...f.deployInput, deploymentId: sourceReceipt!.id }
                : actionId === 'deployments.promote' ? { ...f.deployInput, sourceEnvironmentId: sourceEnvironment.id,
                    sourceDeploymentId: sourceReceipt!.id, artifact: 'image' as const, destinationContent: await f.artifact() }
                : actionId === 'deployments.teardown' ? { ...f.deployInput, reason: 'manual' as const } : f.deployInput;
            const input = actionId === 'deployments.deploy'
                ? { serverId: f.serverId, environmentId: f.environment.id, targetLinkId: f.link.id } : preparedInput;
            const root = await f.withAccountProjection(await f.root(actionId, input));
            const deps = createDaemonDeploymentActionDeps({ credentials: { token: f.presentUserToken, encryption: null },
                serverId: f.serverId, serverHttpBaseUrl: f.origin, machineId: f.machine.id,
                resolveRequesterIdentity: async () => { throw new Error('Signed owner already admitted'); },
                // No native effects are needed to discover this fresh Environment's empty Domain set.
                runtime: { async acquire() { throw new Error('Domain discovery must not acquire native execution'); } } });
            const result = await runWithServerHttpBaseUrl(f.origin, () => deps.prepareHostReviewedChildren({
                actionId, input: preparedInput,
                context: { ...f.context(root), authority: 'present_user', signal: new AbortController().signal } }));
            expect(result, JSON.stringify({ result, requests: f.requests })).toBeNull();
            expect(f.requests).toContainEqual({ method: 'GET', status: 200,
                path: `/v1/deployments/environments/${f.environment.id}/domains?serverId=${encodeURIComponent(f.serverId)}` });

            const otherEnvironment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: f.source.id, createdByAccountId: f.account.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id,
                ...await f.artifact('deployment-environment.v1') } });
            for (const [serverId, environmentId] of [[f.serverId, otherEnvironment.id], ['srv_foreign', f.environment.id]]) {
                const path = `/v1/deployments/environments/${environmentId}/domains?serverId=${encodeURIComponent(serverId)}`;
                const response = await f.resourceApp.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'deployments.domains.list', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(401);
                expect(response.json()).toMatchObject({ error: 'invalid_token',
                    authorizationRefusal: 'deployment_metadata_environment' });
            }
        } finally { identity.mockRestore(); restoreHttp(); await f.close(); }
    });

    it('admits native deployment Environment reads and refuses a freshly signed foreign Environment', async () => {
        const f = await deploymentFixture();
        const foreign = await deploymentFixture();
        try {
            const root = await f.root('deployments.deploy', f.deployInput);
            const path = (id: string) => `/v1/deployments/environments/${id}?serverId=${f.serverId}`;
            for (const [id, status] of [[f.environment.id, 200], [foreign.environment.id, 404]] as const) {
                // createDaemonDeploymentActionDeps.readEnvironmentMetadata calls storage with this read effect.
                const request = { effectActionId: 'deployments.environments.get', method: 'GET', path: path(id) };
                const response = await f.resourceApp.inject({ method: 'GET', url: request.path, headers: await f.headers(root, request) });
                expect(response.statusCode, response.body).toBe(status);
                expect(response.json()).toMatchObject(status === 200
                    ? { ok: true, environment: { id: f.environment.id } } : { ok: false, error: 'deployment_unavailable' });
            }
            expect(f.currentnessRequests).toEqual(expect.arrayContaining([
                { method: 'POST', path: bindExternalActionExecutionAuthorizationVerifyHttpPathV1('deployments.deploy'), status: 200 },
            ]));
        } finally { await foreign.close(); await f.close(); }
    });

    it('forwards a real accepted member packet through RPC and Environment HTTP and constrains fresh observers', async () => {
        const f = await deploymentFixture();
        try {
            const root = await f.root('deployments.deploy', f.deployInput);
            const path = `/v1/deployments/environments/${f.environment.id}/deploy`;
            const actionOperationId = crypto.randomUUID();
            const body = { ...f.deployInput, actionOperationId };
            const admitted = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(root, { effectActionId: 'deployments.deploy', method: 'POST', path, body }) });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const receipt = await db.deployment.findFirstOrThrow({ where: { environmentId: f.environment.id } });
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
                input: f.deployInput, machineId: f.machine.id, installationId: f.machine.installationId!,
                deploymentId: receipt.id, selectedDeploymentId: receipt.id, actionOperationId, phase: 'activate' });
            const packet = (selected = job) => {
                const method = `${selected.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
                const requestId = crypto.randomUUID();
                const execution = createExternalActionSourceMachineRpcExecution({ authorization: root,
                    target: root.binding.target, sourceMachineId: f.machine.id, sourceInstallationId: f.machine.installationId!,
                    effectActionId: 'deployments.deploy', method, requestId, params: selected,
                    deploymentChildRouting: projectDeploymentChildRoutingV1(selected), privateKey: f.keyPair.secretKey });
                if (!execution) throw new Error('Expected the actual deployment source packet');
                return { method, requestId, params: selected, externalActionExecution: execution,
                    originalActionEnvelope: { v: 1 as const, requestId: root.binding.requestId,
                        target: root.binding.target, input: f.deployInput } };
            };
            const source = packet();
            const envelope = { v: 1 as const, requestId: root.binding.requestId, target: root.binding.target, input: f.deployInput };
            expect(await verifyExternalActionMachineRpcExecution(source.externalActionExecution,
                { ...source, originalActionEnvelope: envelope })).toMatchObject({ deploymentChildAdmission: { routing: { kind: 'member' } } });
            const refused = packet(DeploymentChildRpcV1Schema.parse({ ...job, deploymentId: crypto.randomUUID() }));
            expect(await verifyExternalActionMachineRpcExecution(refused.externalActionExecution,
                { ...refused, originalActionEnvelope: envelope })).toBeNull();
            for (const [id, status] of [[f.environment.id, 200], [crypto.randomUUID(), 401]] as const) {
                const readPath = `/v1/deployments/environments/${id}?serverId=${f.serverId}`;
                const response = await f.resourceApp.inject({ method: 'GET', url: readPath,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root,
                        effectActionId: 'deployments.deploy', target: root.binding.target,
                        installationId: f.machine.installationId!, method: 'GET', path: readPath,
                        deploymentChildExecution: source, privateKey: f.keyPair.secretKey }) });
                expect(response.statusCode, response.body).toBe(status);
            }
            const observer = await f.root('deployments.receipts.observe', { serverId: f.serverId,
                environmentId: f.environment.id, deploymentId: receipt.id });
            for (const [id, status] of [[f.environment.id, 200], [crypto.randomUUID(), 404]] as const) {
                const read = { effectActionId: 'deployments.environments.get', method: 'GET',
                    path: `/v1/deployments/environments/${id}?serverId=${f.serverId}` };
                const response = await f.resourceApp.inject({ method: 'GET', url: read.path, headers: await f.headers(observer, read) });
                expect(response.statusCode, response.body).toBe(status);
            }
            const sibling = '/v1/artifacts';
            expect((await f.resourceApp.inject({ method: 'GET', url: sibling, headers: await f.headers(observer, {
                effectActionId: 'deployments.environments.get', method: 'GET', path: sibling }) })).statusCode).toBe(401);
        } finally { await f.close(); }
    });

    it('spends native Restart, receipt-read and Backup Restore roots on their exact signed purposes', async () => {
        const f = await deploymentFixture();
        try {
            const deploy = await f.root('deployments.deploy', f.deployInput);
            const body = { ...f.deployInput, actionOperationId: crypto.randomUUID() };
            const path = `/v1/deployments/environments/${f.environment.id}/deploy`;
            const admitted = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(deploy, { effectActionId: 'deployments.deploy', method: 'POST', path, body }) });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const receipt = await db.deployment.findFirstOrThrow({ where: { environmentId: f.environment.id } });
            // Native settlement publishes the active generation; root issuance,
            // packet production and every HTTP verifier below remain real.
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'succeeded' } });
            await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: receipt.id } });
            const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
            const placement = { serverId: f.serverId, environmentId: environment.id, deploymentId: receipt.id,
                targetLinkId: f.link.id, machineId: f.machine.id, installationId: f.machine.installationId! };
            const restartInput = { ...placement, service: { kind: 'deployment', machineId: f.machine.id,
                environmentId: environment.id, environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' },
                expectedGeneration: 'generation' };
            const restart = await f.root('deployments.restart', restartInput);
            for (const [readPath, status] of [[`/v1/machines/${f.machine.id}`, 200],
                [`/v1/machines/${crypto.randomUUID()}`, 401], [`/v1/artifacts/${receipt.contentArtifactId}`, 401]] as const) {
                const response = await f.resourceApp.inject({ method: 'GET', url: readPath,
                    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        ...await f.headers(restart, { effectActionId: 'deployments.restart', method: 'GET', path: readPath }) } });
                expect(response.statusCode, response.body).toBe(status);
            }
            const logs = await f.root('deployments.logs.read', { ...placement, kind: 'build' });
            const receiptSpec = getActionSpec('deployments.receipts.get');
            if (!receiptSpec.serverTransport) throw new Error('Receipt read has no canonical HTTP transport');
            for (const [id, status] of [[receipt.id, 200], [crypto.randomUUID(), 401]] as const) {
                const request = bindHomeDomainHttpRequestV1({ transport: receiptSpec.serverTransport,
                    inputSchema: receiptSpec.inputSchema, input: { serverId: f.serverId, environmentId: environment.id, deploymentId: id } });
                const response = await f.resourceApp.inject({ method: 'GET', url: request.path,
                    headers: await f.headers(logs, { effectActionId: 'deployments.receipts.get', ...request }) });
                expect(response.statusCode, response.body).toBe(status);
            }
            const restore = await f.withAccountProjection(await f.root('deployments.backups.restore', {
                ...placement, mode: 'prepare', expectedRevision: environment.revision, restoreBackupId: 'pre-migration' }));
            const restoreHttp = installAxiosFastifyAdapter({ app: f.resourceApp, origin: f.origin });
            const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
                privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
            try {
                const read = (deploymentId = receipt.id) => readEnvironmentSecretLaunchAdmissionForHost({
                    credentials: { token: f.presentUserToken, encryption: null }, serverId: f.serverId,
                    serverHttpBaseUrl: f.origin, machineId: f.machine.id, installationId: f.machine.installationId!,
                    environmentId: environment.id, targetLinkId: f.link.id, context: f.context(restore),
                    actionOperationId: receipt.actionOperationId, signal: new AbortController().signal,
                    materialization: { kind: 'deployment', deploymentId } });
                const secrets = await read();
                expect(secrets.grants).toEqual([]);
                secrets.release?.();
                await expect(read(crypto.randomUUID())).rejects.toMatchObject({ code: 'action_forbidden' });
            } finally { identity.mockRestore(); restoreHttp(); }
        } finally { await f.close(); }
    });

    it('opens the signed promotion destination candidate during real parentless review', async () => {
        const f = await deploymentFixture();
        try {
            const sourceEnvironment = await db.deploymentEnvironment.create({ data: { ...f.environment,
                id: crypto.randomUUID(), runtimeTargetLinkId: null, ...await f.artifact() } });
            const sourceLink = await db.deploymentTargetLink.create({ data: { environmentId: sourceEnvironment.id,
                createdByAccountId: f.account.id, role: 'runtime', state: 'deployed', sourceKind: 'host',
                hostTargetId: 'own-server', targetKind: 'ownServer', ...await f.artifact('deployment-target-link.v1') } });
            const sourceReceipt = await db.deployment.create({ data: { environmentId: sourceEnvironment.id,
                targetLinkId: sourceLink.id, operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(), requestedByAccountId: f.account.id,
                ...await f.artifact('deployment-receipt.v1') } });
            const rootInput = { ...f.deployInput, sourceEnvironmentId: sourceEnvironment.id, sourceDeploymentId: sourceReceipt.id,
                artifact: 'image' as const, destinationContent: await f.artifact() };
            const root = await f.root('deployments.promote', rootInput);
            const publication = root.binding.deploymentCandidatePublication;
            if (!publication) throw new Error('Public promotion mint must admit its candidate publication');
            const input = { ...rootInput, destinationContent: await f.artifact('deployment-environment.v1', undefined, undefined,
                publication.environmentContentArtifactId) };
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.promote', input,
                machineId: f.machine.id, installationId: f.machine.installationId! });
            const method = `${f.machine.id}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
            const requestId = crypto.randomUUID();
            const execution = createExternalActionSourceMachineRpcExecution({ authorization: root, target: root.binding.target,
                sourceMachineId: f.machine.id, sourceInstallationId: f.machine.installationId!, effectActionId: 'deployments.promote',
                method, requestId, params: job, deploymentChildRouting: projectDeploymentChildRoutingV1(job), privateKey: f.keyPair.secretKey });
            if (!execution) throw new Error('Expected the production promotion child packet');
            const packet = { method, requestId, params: job, externalActionExecution: execution,
                originalActionEnvelope: { v: 1 as const, requestId: root.binding.requestId, target: root.binding.target, input: rootInput } };
            expect(await verifyExternalActionMachineRpcExecution(execution, packet))
                .toMatchObject({ deploymentChildAdmission: { routing: { kind: 'review' } } });
            for (const [id, status] of [[input.destinationContent.contentArtifactId, 200], [sourceReceipt.contentArtifactId, 200],
                [sourceEnvironment.contentArtifactId, 401], [rootInput.destinationContent.contentArtifactId, 401], [crypto.randomUUID(), 401]] as const) {
                const path = `/v1/artifacts/${id}`;
                const response = await f.resourceApp.inject({ method: 'GET', url: path,
                    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        ...createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: 'deployments.promote',
                            target: root.binding.target, installationId: f.machine.installationId!, method: 'GET', path,
                            deploymentChildExecution: packet, privateKey: f.keyPair.secretKey }) } });
                expect(response.statusCode, response.body).toBe(status);
            }
            const tamperedJob = DeploymentChildRpcV1Schema.parse({ ...job,
                input: { ...input, destinationContent: rootInput.destinationContent } });
            const tamperedRequestId = crypto.randomUUID();
            const tamperedExecution = createExternalActionSourceMachineRpcExecution({ authorization: root, target: root.binding.target,
                sourceMachineId: f.machine.id, sourceInstallationId: f.machine.installationId!, effectActionId: 'deployments.promote',
                method, requestId: tamperedRequestId, params: tamperedJob,
                deploymentChildRouting: projectDeploymentChildRoutingV1(tamperedJob), privateKey: f.keyPair.secretKey });
            if (!tamperedExecution) throw new Error('Expected the production source signer to bind the substituted candidate');
            const tampered = { ...packet, requestId: tamperedRequestId, params: tamperedJob, externalActionExecution: tamperedExecution };
            const path = `/v1/artifacts/${rootInput.destinationContent.contentArtifactId}`;
            const refused = await f.resourceApp.inject({ method: 'GET', url: path,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: 'deployments.promote',
                    target: root.binding.target, installationId: f.machine.installationId!, method: 'GET', path,
                    deploymentChildExecution: tampered, privateKey: f.keyPair.secretKey }) });
            expect(refused.statusCode, refused.body).toBe(401);
            const otherSource = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId: f.serverId,
                requestKey: crypto.randomUUID(), name: 'Other owned Source', audience: [] }));
            if (!otherSource.ok) throw new Error(otherSource.error);
            await db.deploymentEnvironment.update({ where: { id: sourceEnvironment.id },
                data: { projectSourceId: otherSource.source.id } });
            const candidatePath = `/v1/artifacts/${input.destinationContent.contentArtifactId}`;
            const crossSource = await f.resourceApp.inject({ method: 'GET', url: candidatePath,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: 'deployments.promote',
                    target: root.binding.target, installationId: f.machine.installationId!, method: 'GET', path: candidatePath,
                    deploymentChildExecution: packet, privateKey: f.keyPair.secretKey }) });
            expect(crossSource.statusCode, crossSource.body).toBe(401);
        } finally { await f.close(); }
    });

    it('opens receipt content in the admitted Environment under the real receipt-get issuer regardless of requester', async () => {
        const f = await deploymentFixture();
        const foreign = await deploymentFixture();
        try {
            const deploy = await f.root('deployments.deploy', f.deployInput);
            const body = { ...f.deployInput, actionOperationId: crypto.randomUUID() };
            const path = `/v1/deployments/environments/${f.environment.id}/deploy`;
            const admitted = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(deploy, { effectActionId: 'deployments.deploy', method: 'POST', path, body }) });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const receipt = await db.deployment.findFirstOrThrow({ where: { environmentId: f.environment.id } });
            // The native executor is the boundary. Home admission, receipt selection,
            // signing and private Artifact access below use their production owners.
            await db.deployment.update({ where: { id: receipt.id }, data: { state: 'failed' } });
            const input = { serverId: f.serverId, environmentId: f.environment.id, deploymentId: receipt.id };
            const root = await f.root('deployments.receipts.get', input);
            const spec = getActionSpec('deployments.receipts.get');
            if (!spec.serverTransport) throw new Error('Receipt read has no canonical HTTP transport');
            const metadata = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input });
            const read = async (readPath: string, method: 'GET' | 'POST' = 'GET', payload?: Record<string, unknown>) => f.resourceApp.inject({
                method, url: readPath, ...(payload ? { payload } : {}),
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                    ...await f.headers(root, { effectActionId: 'deployments.receipts.get', method, path: readPath, body: payload }) },
            });
            const detail = await read(metadata.path);
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json()).toMatchObject({ deployment: { id: receipt.id, contentArtifactId: receipt.contentArtifactId } });
            const content = await read(`/v1/artifacts/${receipt.contentArtifactId}`);
            expect(content.statusCode, content.body).toBe(200);
            expect(content.json()).toMatchObject({ id: receipt.contentArtifactId });
            const otherRequester = await db.deployment.create({ data: { ...receipt, id: crypto.randomUUID(),
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestedByAccountId: foreign.account.id,
                ...await f.artifact('deployment-receipt.v1') } });
            const otherEnvironment = await db.deployment.create({ data: { ...receipt, id: crypto.randomUUID(),
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), environmentId: foreign.environment.id,
                targetLinkId: foreign.link.id, ...await f.artifact('deployment-receipt.v1') } });
            const teammateContent = await read(`/v1/artifacts/${otherRequester.contentArtifactId}`);
            expect(teammateContent.statusCode, teammateContent.body).toBe(200);
            for (const id of [f.environment.contentArtifactId, f.link.contentArtifactId,
                otherEnvironment.contentArtifactId, crypto.randomUUID()]) {
                const denied = await read(`/v1/artifacts/${id}`);
                expect(denied.statusCode, denied.body).toBe(401);
            }
            for (const request of [
                { path: `/v1/artifacts/${receipt.contentArtifactId}?other=1`, method: 'GET', body: undefined },
                { path: `/v1/artifacts/${receipt.contentArtifactId}`, method: 'POST', body: {} },
            ] as const) {
                const denied = await read(request.path, request.method, request.body);
                expect(denied.statusCode, denied.body).toBe(401);
            }
        } finally { await foreign.close(); await f.close(); }
    });

    it.each(['deployments.bindings.set', 'deployments.environments.update'] as const)(
        'uses the installed secret-preparation producer for %s and refuses a fresh foreign Environment', async actionId => {
            const f = await deploymentFixture();
            try {
                const input = { serverId: f.serverId, environmentId: f.environment.id, expectedRevision: f.environment.revision,
                    contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: f.environment.contentHeaderVersion,
                    contentBodyVersion: f.environment.contentBodyVersion };
                const root = await f.withAccountProjection(await f.root(actionId, input));
                const restoreHttp = installAxiosFastifyAdapter({ app: f.resourceApp, origin: f.origin });
                const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                    createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
                    privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
                try {
                    const read = (environmentId = f.environment.id) => readEnvironmentSecretBindingPreparationForHost({
                        credentials: { token: f.presentUserToken, encryption: null }, serverId: f.serverId,
                        serverHttpBaseUrl: f.origin, machineId: f.machine.id, installationId: f.machine.installationId!,
                        environmentId, targetLinkId: f.link.id, expectedRevision: f.environment.revision,
                        ...(actionId === 'deployments.environments.update' ? { buildMachineId: f.machine.id } : {}),
                        context: f.context(root), signal: new AbortController().signal });
                    const prepared = await read();
                    expect(prepared.bindingPreparation).toBeDefined();
                    expect(prepared.grants).toEqual([]);
                    prepared.release();
                    await expect(read(crypto.randomUUID())).rejects.toMatchObject({ code: 'deployment_unavailable' });
                } finally { identity.mockRestore(); restoreHttp(); }
            } finally { await f.close(); }
        });

    it('keeps contributed Link Setup reads inside the real private child and admitted Environment', async () => {
        const f = await deploymentFixture();
        try {
            const input = { serverId: f.serverId, environmentId: f.environment.id, expectedRevision: f.environment.revision,
                requestKey: crypto.randomUUID(), role: 'runtime', targetId: 'own-server',
                replacesLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
                machines: [{ machineId: f.machine.id, installationId: f.machine.installationId! }],
                ...await f.artifact('deployment-target-link.v1') };
            const root = await f.root('deployments.targets.link', input);
            const admission = root.binding.deploymentLinkAdmission;
            if (!admission) throw new Error('Expected public Link admission');
            const artifactId = createDeploymentLinkContentArtifactIdV1({ ...root.binding, deploymentLinkAdmission: admission });
            const created = await createArtifact({ actorUserId: f.account.id, artifactId,
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Setup target' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            const path = `/v1/deployments/environments/${f.environment.id}/targets`;
            const body = DeploymentTargetLinkInputV1Schema.parse({ ...input, contentArtifactId: artifactId,
                contentHeaderVersion: 1, contentBodyVersion: 1 });
            const linked = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(root, { effectActionId: 'deployments.targets.link', method: 'POST', path, body }) });
            expect(linked.statusCode, linked.body).toBe(200);
            const action = { pluginId: 'happier.machine.services', localId: 'deployment-failed/setup' };
            const effectActionId = formatQualifiedPluginActionId(action);
            const childInput = { v: 1, serverId: f.serverId, environmentId: f.environment.id,
                targetLinkId: linked.json().targetLinkId };
            expect(await f.child(root, { actionId: root.binding.actionId, input },
                { action, role: 'platform-failure.setup', input: childInput }, async context => {
                    for (const [readPath, status] of [
                        [`/v1/deployments/environments/${f.environment.id}?serverId=${f.serverId}`, 200],
                        [`/v1/artifacts/${artifactId}`, 200],
                        [`/v1/deployments/environments/${crypto.randomUUID()}?serverId=${f.serverId}`, 401],
                        [`/v1/artifacts/${f.link.contentArtifactId}`, 401],
                    ] as const) {
                        const response = await f.resourceApp.inject({ method: 'GET', url: readPath,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, {
                                effectActionId, method: 'GET', path: readPath }) });
                        expect(response.statusCode, response.body).toBe(status);
                    }
                    return { ok: true, result: null };
                })).toMatchObject({ ok: true });
        } finally { await f.close(); }
    });

    it('routes real Prepare, Review, Build and settled Retention packets through the source signer and Home verifier', async () => {
        const f = await deploymentFixture();
        try {
            const intent = { serverId: f.serverId, environmentId: f.environment.id, targetLinkId: f.link.id };
            const prepareRoot = await f.root('deployments.deploy', intent);
            const storedRoot = await f.root('deployments.deploy', f.deployInput);
            const packet = (authorization: typeof prepareRoot, rootInput: unknown,
                job: ReturnType<typeof DeploymentChildRpcV1Schema.parse>) => {
                const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
                const requestId = crypto.randomUUID();
                const execution = createExternalActionSourceMachineRpcExecution({ authorization, target: authorization.binding.target,
                    sourceMachineId: f.machine.id, sourceInstallationId: f.machine.installationId!,
                    effectActionId: 'deployments.deploy', method, requestId, params: job,
                    deploymentChildRouting: projectDeploymentChildRoutingV1(job), privateKey: f.keyPair.secretKey });
                if (!execution) throw new Error('Expected actual source packet');
                return { execution, request: { method, requestId, params: job, originalActionEnvelope: {
                    v: 1 as const, requestId: authorization.binding.requestId, target: authorization.binding.target, input: rootInput } } };
            };
            const check = async (authorization: typeof prepareRoot, rootInput: unknown,
                job: ReturnType<typeof DeploymentChildRpcV1Schema.parse>) => {
                const signed = packet(authorization, rootInput, job);
                expect(await verifyExternalActionMachineRpcExecution(signed.execution, signed.request), job.kind)
                    .toMatchObject({ deploymentChildAdmission: { routing: { kind: job.kind } } });
                const foreign = packet(authorization, rootInput, DeploymentChildRpcV1Schema.parse({ ...job, installationId: crypto.randomUUID() }));
                expect(await verifyExternalActionMachineRpcExecution(foreign.execution, foreign.request)).toBeNull();
            };
            const placement = { v: 1, machineId: f.machine.id, installationId: f.machine.installationId!, actionId: 'deployments.deploy' };
            await check(prepareRoot, intent, DeploymentChildRpcV1Schema.parse({ ...placement, kind: 'prepare', input: intent,
                expectedRevision: f.environment.revision, expectedTargetLinkRevision: f.link.revision }));
            await check(storedRoot, f.deployInput, DeploymentChildRpcV1Schema.parse({ ...placement, kind: 'review', input: f.deployInput }));
            const path = `/v1/deployments/environments/${f.environment.id}/deploy`;
            const actionOperationId = crypto.randomUUID();
            const body = { ...f.deployInput, actionOperationId };
            const accepted = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(storedRoot, { effectActionId: 'deployments.deploy', method: 'POST', path, body }) });
            expect(accepted.statusCode, accepted.body).toBe(200);
            const receipt = await db.deployment.findFirstOrThrow({ where: { environmentId: f.environment.id } });
            await check(storedRoot, f.deployInput, DeploymentChildRpcV1Schema.parse({ ...placement, kind: 'build', input: f.deployInput,
                deploymentId: receipt.id, actionOperationId }));
            // Native settlement fixtures retain the genuinely admitted receipt;
            // the production signer and currentness owner consume its persisted state.
            const settled = await db.deployment.update({ where: { id: receipt.id }, data: {
                state: 'succeeded', revision: { increment: 1 } } });
            const selected = await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: {
                activeDeploymentId: receipt.id, revision: { increment: 1 } } });
            await check(storedRoot, f.deployInput, DeploymentChildRpcV1Schema.parse({ ...placement, kind: 'retention', input: f.deployInput,
                deploymentId: receipt.id, actionOperationId, settledDeploymentRevision: settled.revision,
                settledTargetLinkRevision: selected.revision, activeDeploymentId: receipt.id }));
        } finally { await f.close(); }
    });

    it('spends a real Link retention child only on its selected managed allocation', async () => {
        const f = await deploymentFixture();
        try {
            const native = await createNativeSessionTeamCredentialFixture();
            const declaration = await db.accountPluginIntent.findFirstOrThrow({ where: {
                accountId: native.custodian.id, pluginId: native.launch.provider.pluginId } });
            const materialization = await db.pluginMachineMaterialization.findFirstOrThrow({ where: { machineId: native.controller.id } });
            await db.accountPluginIntent.create({ data: { accountId: f.account.id, pluginId: declaration.pluginId,
                enabled: true, writableCollections: [], releaseLessDeclaration: declaration.releaseLessDeclaration! } });
            await db.pluginMachineMaterialization.create({ data: { ...materialization, id: crypto.randomUUID(), accountId: f.account.id,
                serverIdentityId: f.serverId, machineId: f.machine.id, materializationId: f.machine.installationId! } });
            await db.machine.update({ where: { id: f.machine.id }, data: { pluginMaterializationRevision: 1n } });
            const acquireInput = ManagedAcquireInputV1Schema.parse({
                enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
                selection: { kind: 'one-off', homeId: f.serverId, controller: { machineId: f.machine.id,
                    installationId: f.machine.installationId! }, launch: native.launch,
                    retention: { kind: 'unused', afterMs: 1000, effect: 'delete' }, wakeOnAcceptedMessage: false } });
            const acquiredRoot = await f.root('machines.managed.acquire', acquireInput);
            const acquired = await admitManagedAcquire({ custodianAccountId: f.account.id, requesterAccountId: f.account.id,
                requestEnvelopeDigest: acquiredRoot.binding.requestEnvelopeDigest,
                input: { input: acquireInput, requestId: acquiredRoot.binding.requestId, continuationPresent: false } });
            // The provider's native allocation boundary publishes the installed resource.
            await db.managedMachine.update({ where: { id: acquired.machine.id }, data: { allocation: 'bound',
                enrolledMachineId: f.machine.id,
                resource: { contributionRef: native.launch.provider, schemaVersion: 1, value: { id: 'retained-target' } } } });
            const input = { serverId: f.serverId, environmentId: f.environment.id, expectedRevision: f.environment.revision,
                requestKey: crypto.randomUUID(), role: 'runtime', targetId: 'own-server',
                machines: [{ machineId: f.machine.id, installationId: f.machine.installationId! }],
                ...await f.artifact('deployment-target-link.v1') };
            const root = await f.root('deployments.targets.link', input);
            const childAction = 'machines.managed.retention.update' as const;
            const childInput = { homeId: f.serverId, managedId: acquired.machine.id,
                expectedIntentRevision: acquired.machine.intentRevision, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
            const requestId = deriveWorkflowReplacementId(['action.child', root.binding.requestId, root.binding.actionId, childAction, 0]);
            const result = await f.child(root, { actionId: root.binding.actionId, input },
                { action: childAction, role: `target-retention:${f.machine.id}`, input: childInput }, async context => {
                    const path = '/v1/machines/managed/controller/admit-control';
                    const send = async (selectedInput = childInput) => {
                        const body = { action: childAction, requestId, input: selectedInput };
                        return f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, {
                                effectActionId: childAction, method: 'POST', path, body }) });
                    };
                    const refused = await send({ ...childInput, wakeOnAcceptedMessage: true });
                    expect(refused.statusCode, refused.body).toBe(401);
                    const changed = await send();
                    expect(changed.statusCode, changed.body).toBe(200);
                    expect(changed.json()).toMatchObject({ machine: { id: acquired.machine.id,
                        retention: { kind: 'until-delete' }, intentRevision: acquired.machine.intentRevision + 1 } });
                    return { ok: true, result: null };
                });
            expect(result).toMatchObject({ ok: true });
        } finally { await f.close(); }
    });

    it.each([
        { actionId: 'deployments.bindings.set', role: 'preview.bindings', status: 200 },
        { actionId: 'deployments.environments.update', role: 'preview.backup', status: 200 },
        { actionId: 'deployments.environments.update', role: 'preview.bindings', status: 401 },
        { actionId: 'deployments.environments.update', role: 'preview.backup', status: 200, privateBackup: true },
    ] as const)('retains the preview Create root for $role/$actionId only on its allocated Environment ($status)', async selection => {
        const { actionId, role, status } = selection;
        const f = await deploymentFixture();
        try {
            await db.projectSource.update({ where: { id: f.source.id }, data: { repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example' },
                repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.example/owner/app.git' }, protocol: 'https',
            } } });
            await db.automation.create({ data: { accountId: f.account.id, name: 'Preview admission',
                deploymentEnvironmentId: f.environment.id, deploymentPreviewRole: 'preview_admission', enabled: true,
                templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1,
                    directory: '/workspace/app', prompt: 'Preview' })) } });
            const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: f.serverId,
                projectSourceId: f.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
                purpose: 'preview', deployerMode: 'managers', controllerMachineId: f.machine.id,
                preview: { templateEnvironmentId: f.environment.id, expectedTemplateRevision: f.environment.revision,
                    runtimeTargetLinkId: f.link.id, pullRequestId: 'native-preview-pr' },
                ...await f.artifact(), firstTargetLink: { machines: [{ machineId: f.machine.id,
                    installationId: f.machine.installationId! }], ...await f.artifact('deployment-target-link.v1') } });
            const root = await f.withAccountProjection(await f.root('deployments.environments.create', input));
            const path = '/v1/deployments/environments';
            const created = await f.resourceApp.inject({ method: 'POST', url: path, payload: input,
                headers: await f.headers(root, { effectActionId: 'deployments.environments.create', method: 'POST', path, body: input }) });
            expect(created.statusCode, created.body).toBe(200);
            const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.json().environmentId } });
            const common = { serverId: f.serverId, environmentId: environment.id, expectedRevision: environment.revision,
                contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
                contentBodyVersion: environment.contentBodyVersion };
            const backup = 'privateBackup' in selection ? { configRevision: 1,
                destinationRef: { pluginId: 'example.backups', localId: 'open' }, occurrenceId: 'preview-backup', config: {},
                credentialBindings: [], sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'app', consistency: 'logical' as const }],
                retention: { kind: 'keepEverything' as const }, ownership: { environmentId: environment.id, prefix: `previews/${environment.id}` } } : undefined;
            const childInput = actionId === 'deployments.bindings.set' ? { ...common, referencedSavedSecretRevisions: [] }
                : { ...common, ...(backup ? { patch: { backup } } : {}) };
            const result = await f.child(root, { actionId: 'deployments.environments.create', input },
                { action: actionId, role, input: childInput }, async context => {
                    for (const [environmentId, expectedStatus] of [[f.environment.id, 401], [environment.id, status]] as const) {
                        const readPath = `/v1/deployments/environments/${environmentId}?serverId=${encodeURIComponent(f.serverId)}`;
                        const read = await f.resourceApp.inject({ method: 'GET', url: readPath,
                            headers: await f.headers(context.externalActionExecutionAuthorization!, {
                                effectActionId: actionId, method: 'GET', path: readPath }) });
                        expect(read.statusCode, read.body).toBe(expectedStatus);
                    }
                    const method = actionId === 'deployments.bindings.set' ? 'POST' : 'PATCH';
                    const writePath = `/v1/deployments/environments/${environment.id}${actionId === 'deployments.bindings.set' ? '/bindings' : ''}`;
                    const native = readHostAdmittedReviewedChildV1(context)?.deploymentNativeAdmission;
                    const body = actionId === 'deployments.bindings.set' ? { ...childInput, grants: [] }
                        : backup ? { ...common, ...await f.artifact('deployment-environment.v1',
                            { ...createDeploymentEnvironmentDetailV1().content, backup }, undefined,
                            createDeploymentEnvironmentContentArtifactIdV1({ ...root.binding, environmentId: environment.id })),
                            authoredInputDigest: native && 'inputDigest' in native ? native.inputDigest : undefined, patch: {} } : childInput;
                    const written = await f.resourceApp.inject({ method, url: writePath, payload: body,
                        headers: await f.headers(context.externalActionExecutionAuthorization!, {
                            effectActionId: actionId, method, path: writePath, body }) });
                    expect(written.statusCode, written.body).toBe(status);
                    return { ok: true, result: null };
                });
            expect(result).toMatchObject({ ok: true });
        } finally { await f.close(); }
    });

    it.each(['template', 'create'] as const)('retains the %s root through the private Deploy and Domain issuers and real HTTP/RPC producers', async family => {
        let f = await deploymentFixture();
        try {
            const templateInput = { mode: 'apply' as const, serverId: f.serverId, machineId: f.machine.id,
                projectSourceId: f.source.id, templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
                    ref: { kind: 'version' as const, version: '1' } },
                environment: { kind: 'existing' as const, environmentId: f.environment.id, expectedRevision: f.environment.revision },
                target: { kind: 'existing' as const, targetLinkId: f.link.id, expectedRevision: f.link.revision,
                    installationId: f.machine.installationId! },
                destination: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                bindings: [], domainBindings: [{ templateDomainId: 'web', hostname: 'app.example.test' }],
                deploy: { requestKey: f.deployInput.requestKey } };
            const createInput = { serverId: f.serverId, projectSourceId: f.source.id, requestKey: crypto.randomUUID(),
                mode: 'apply' as const, name: 'Allocated catalog Environment', protection: 'nonProduction' as const,
                purpose: 'standard' as const, deployerMode: 'managers' as const,
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id,
                definition: { from: 'catalogApp' as const, templateRef: templateInput.templateRef },
                firstTargetLink: { machines: [{ machineId: f.machine.id, installationId: f.machine.installationId! }] },
                bindings: [], domainBindings: templateInput.domainBindings };
            const input = family === 'template' ? templateInput : createInput;
            const root = await f.withAccountProjection(await f.root(family === 'template'
                ? 'deployments.templates.instantiate' : 'deployments.environments.create', input));
            if (family === 'create') {
                // The real Create route allocates the Environment selected by its
                // requestKey; later children must use that stored association.
                const { mode: _mode, name: _name, definition: _definition, bindings: _bindings,
                    domainBindings: _domains, firstTargetLink, ...base } = createInput;
                const body = DeploymentEnvironmentCreateInputV1Schema.parse({ ...base, ...await f.artifact(),
                    firstTargetLink: { ...firstTargetLink, ...await f.artifact('deployment-target-link.v1') } });
                const path = '/v1/deployments/environments';
                const created = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                    headers: await f.headers(root, { effectActionId: 'deployments.environments.create', method: 'POST', path, body }) });
                expect(created.statusCode, created.body).toBe(200);
                const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.json().environmentId } });
                const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: environment.runtimeTargetLinkId! } });
                f = { ...f, environment, link, deployInput: { ...f.deployInput, environmentId: environment.id,
                    expectedRevision: environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
                    requestKey: root.binding.requestId } };
            }
            const otherEnvironment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: f.source.id, createdByAccountId: f.account.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id,
                ...await f.artifact('deployment-environment.v1'),
            } });
            const result = await f.child(root, { actionId: root.binding.actionId, input },
                { action: 'deployments.deploy', role: 'template.deploy', input: f.deployInput }, async context => {
                    const childAuthorization = context.externalActionExecutionAuthorization!;
                    // Membership discovery precedes the Deploy receipt. Exercise
                    // both the retained Deploy effect and the root's metadata effect.
                    for (const [authorization, effectActionId] of [
                        [childAuthorization, 'deployments.deploy'], [root, 'deployments.domains.list'],
                    ] as const) {
                        for (const [serverId, environmentId, status] of [
                            [f.serverId, f.environment.id, 200],
                            [f.serverId, otherEnvironment.id, 401],
                            ['srv_foreign', f.environment.id, 401],
                        ] as const) {
                            const path = `/v1/deployments/environments/${environmentId}/domains?serverId=${encodeURIComponent(serverId)}`;
                            const response = await f.resourceApp.inject({ method: 'GET', url: path,
                                headers: await f.headers(authorization, { effectActionId, method: 'GET', path }) });
                            expect(response.statusCode, response.body).toBe(status);
                            if (status === 401) expect(response.json()).toMatchObject({ error: 'invalid_token',
                                ...(effectActionId === 'deployments.domains.list'
                                    ? { authorizationRefusal: 'deployment_metadata_environment' } : {}) });
                        }
                    }
                    const path = `/v1/deployments/environments/${f.environment.id}/deploy`;
                    const body = { ...f.deployInput, actionOperationId: crypto.randomUUID() };
                    const response = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                        headers: await f.headers(childAuthorization, { effectActionId: 'deployments.deploy', method: 'POST', path, body }) });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ ok: true });
                    for (const [id, status] of [[f.environment.id, 200], [crypto.randomUUID(), 401]] as const) {
                        const read = { effectActionId: 'deployments.deploy', method: 'GET',
                            path: `/v1/deployments/environments/${id}?serverId=${f.serverId}` };
                        const observed = await f.resourceApp.inject({ method: 'GET', url: read.path,
                            headers: await f.headers(childAuthorization, read) });
                        expect(observed.statusCode, observed.body).toBe(status);
                    }
                    // The installed operation owner reports a failed native
                    // attempt. Recovery invokes the production private transition
                    // writer, including its installation proof and HTTP producer.
                    const scope = { accountId: f.account.id, machineId: f.machine.id };
                    const operations = createActionOperationStore();
                    operations.create({ operationId: body.actionOperationId, actionId: 'deployments.deploy', scope,
                        title: 'Native failure', cancellation: 'supported', inputIdentity: JSON.stringify(f.deployInput) });
                    operations.fail(body.actionOperationId, { errorCode: 'deployment_failed', error: 'Native attempt failed' });
                    const restoreHttp = installAxiosFastifyAdapter({ app: f.resourceApp, origin: f.origin });
                    const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                        createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
                        privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
                    try {
                        const deps = createDaemonDeploymentActionDeps({ credentials: { token: f.presentUserToken, encryption: null },
                            serverId: f.serverId, serverHttpBaseUrl: f.origin, machineId: f.machine.id,
                            resolveRequesterIdentity: async () => { throw new Error('Recovery does not execute workspace access'); },
                            runtime: { async acquire() { throw new Error('Recovery does not execute native deployment'); } },
                            readOperation: async id => operations.get(scope, id) });
                        // Later preparation may refuse this deliberately minimal
                        // content; only the completed recovery transition is under test.
                        await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: f.deployInput, context });
                        expect(f.transitions).toHaveLength(1);
                        expect(f.transitions[0].status).toBe(200);
                        const transition = DeploymentTransitionInputV1Schema.parse(f.transitions[0].body);
                        expect(await db.deployment.findUnique({ where: { id: transition.deploymentId } })).toMatchObject({ state: 'failed' });
                        const foreignPath = `/v1/deployments/environments/${f.environment.id}/deployments/${crypto.randomUUID()}/transitions`;
                        const refused = await f.resourceApp.inject({ method: 'POST', url: foreignPath, payload: transition,
                            headers: await f.headers(childAuthorization, { effectActionId: 'deployments.deploy', method: 'POST',
                                path: foreignPath, body: transition }) });
                        expect(refused.statusCode, refused.body).toBe(401);
                    } finally { identity.mockRestore(); restoreHttp(); }
                    return { ok: true, result: null };
                });
            expect(result).toMatchObject({ ok: true });
            expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(1);

            const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
            const domainInput = { serverId: f.serverId, environmentId: f.environment.id, domainId: crypto.randomUUID(),
                expectedRevision: current.revision, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
                requestKey: crypto.randomUUID(), content: { hostname: 'app.example.test',
                    target: { service: 'web', containerPort: 80 }, healthCheck: { path: '/', expectStatus: 200 } } };
            const restoreHttp = installAxiosFastifyAdapter({ app: f.resourceApp, origin: f.origin });
            const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
                privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
            try {
                const domainResult = await f.child(root, { actionId: root.binding.actionId, input },
                    { action: 'deployments.domains.add', role: 'template.domain:web', input: domainInput }, async context => {
                        const child = readHostAdmittedReviewedChildV1(context);
                        if (!child?.deploymentNativeAdmission) throw new Error('Expected the real private Domain projection');
                        const authorization = context.externalActionExecutionAuthorization!;
                        const artifacts = createCredentialedAccountArtifactStore({ token: f.presentUserToken, encryption: null });
                        const content = await runWithServerHttpBaseUrl(f.origin, () => artifacts.create({
                            artifactId: createDeploymentDomainContentArtifactIdV1({ ...root.binding,
                                deploymentNativeAdmission: child.deploymentNativeAdmission!, reviewedChild: child }),
                            header: { kind: 'deployment-domain.v1', title: domainInput.content.hostname },
                            body: JSON.stringify(domainInput.content),
                            authorizationHeaders: request => f.headers(authorization, { ...request, effectActionId: 'deployments.domains.add' }),
                        }));
                        const { content: _authored, ...metadata } = domainInput;
                        const actionOperationId = crypto.randomUUID();
                        const prepared = { ...metadata, contentArtifactId: content.artifactId,
                            contentHeaderVersion: content.revision.headerVersion, contentBodyVersion: content.revision.bodyVersion };
                        const verifyJob = async (job: ReturnType<typeof DeploymentChildRpcV1Schema.parse>, expected: boolean) => {
                            const method = `${job.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
                            const requestId = crypto.randomUUID();
                            const execution = createExternalActionSourceMachineRpcExecution({ authorization, context,
                                target: root.binding.target, sourceMachineId: f.machine.id, sourceInstallationId: f.machine.installationId!,
                                effectActionId: 'deployments.domains.add', method, requestId, params: job,
                                deploymentChildRouting: projectDeploymentChildRoutingV1(job), privateKey: f.keyPair.secretKey });
                            if (!execution) throw new Error('Expected actual private Domain source packet');
                            const admitted = await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params: job,
                                originalActionEnvelope: { v: 1, requestId: root.binding.requestId, target: root.binding.target, input } });
                            if (expected) expect(admitted, job.kind).toMatchObject({ deploymentChildAdmission: { routing: { kind: job.kind } } });
                            else expect(admitted).toBeNull();
                        };
                        const discovery = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover',
                            actionId: 'deployments.domains.add', input: prepared, machineId: f.machine.id,
                            installationId: f.machine.installationId! });
                        await verifyJob(discovery, true);
                        await verifyJob(DeploymentChildRpcV1Schema.parse({ ...discovery, installationId: crypto.randomUUID() }), false);
                        const body = { ...metadata, contentArtifactId: content.artifactId,
                            contentHeaderVersion: content.revision.headerVersion, contentBodyVersion: content.revision.bodyVersion,
                            authoredInputDigest: child.deploymentNativeAdmission.inputDigest,
                            actionOperationId, requestId: root.binding.requestId,
                            placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!,
                                nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'domain-engine' }] };
                        const path = `/v1/deployments/environments/${f.environment.id}/domains`;
                        const response = await f.resourceApp.inject({ method: 'POST', url: path, payload: body,
                            headers: await f.headers(authorization, { effectActionId: 'deployments.domains.add', method: 'POST', path, body }) });
                        expect(response.statusCode, response.body).toBe(200);
                        const created = DeploymentDomainMutationResultV1Schema.parse(response.json());
                        if (!created.ok || !created.domain.placements?.length) throw new Error('Expected accepted Domain capture');
                        const nativeJob = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.add',
                            input: { serverId: f.serverId, environmentId: f.environment.id, domainId: domainInput.domainId },
                            machineId: f.machine.id, installationId: f.machine.installationId!,
                            expectedDomainRevision: created.domain.revision, capture: created.domain.placements[0], actionOperationId });
                        await verifyJob(nativeJob, true);
                        await verifyJob(DeploymentChildRpcV1Schema.parse({ ...nativeJob, expectedDomainRevision: created.domain.revision + 1 }), false);
                        const read = (domainId = domainInput.domainId) => readEnvironmentDomainSecretLaunchAdmissionForHost({
                            credentials: { token: f.presentUserToken, encryption: null }, serverId: f.serverId,
                            serverHttpBaseUrl: f.origin, machineId: f.machine.id, installationId: f.machine.installationId!,
                            environmentId: f.environment.id, targetLinkId: f.link.id, context,
                            signal: new AbortController().signal,
                            materialization: { kind: 'domain', domainId, expectedDomainRevision: created.domain.revision,
                                actionOperationId, capture: created.domain.placements![0]! } });
                        const facts = await read();
                        expect(facts.domainAdmission).toMatchObject({ actionOperationId,
                            controller: { machineId: f.machine.id }, target: { machineId: f.machine.id } });
                        expect(facts.grants).toEqual([]);
                        facts.release();
                        await expect(read(crypto.randomUUID())).rejects.toMatchObject({ code: 'action_forbidden' });
                        return { ok: true, result: null };
                    });
                expect(domainResult).toMatchObject({ ok: true });
            } finally { identity.mockRestore(); restoreHttp(); }
        } finally { await f.close(); }
    });

    it('spends the spawn-reviewed Setup Apply child on its combined Run HTTP storage', async () => {
        const f = await deploymentFixture();
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true } });
            const setup = { homeId: f.serverId, machineId: f.machine.id, sources: [{ kind: 'direct', setup: {} }] };
            const input = getActionSpec('session.spawn_new').inputSchema.parse({
                executionTarget: { serverId: f.serverId, machineId: f.machine.id }, directory: { kind: 'managed' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                machineSetupPlanInput: setup });
            const root = await f.root('session.spawn_new', input);
            const applyInput = { homeId: f.serverId, machineId: f.machine.id,
                targets: [{ ...setup, desiredRevision: 0, recipePlans: [] }] };
            const apply = await f.child(root, { actionId: root.binding.actionId, input },
                { ...SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply, input: applyInput }, async context => {
                    const child = readHostAdmittedReviewedChildV1(context);
                    if (!child) throw new Error('Expected the actual Setup child');
                    const runId = deriveMachineSetupCombinedRunIdV1({ homeId: f.serverId,
                        accountId: f.account.id, requestId: root.binding.requestId, reviewedChild: child });
                    const restoreHttp = installAxiosFastifyAdapter({ app: f.resourceApp, origin: f.origin });
                    const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                        createdAt: 1, installationId: f.machine.installationId!, publicKey: Buffer.from(f.keyPair.publicKey).toString('base64url'),
                        privateKey: Buffer.from(f.keyPair.secretKey).toString('base64url') });
                    try {
                        const read = async (selectedRunId: string) => {
                            const body = { operation: 'get', runId: selectedRunId, publisherMachineId: f.machine.id };
                            const headers = await f.headers(context.externalActionExecutionAuthorization!, {
                                effectActionId: 'machines.setup.apply', method: 'POST', path: '/v3/automations/runs/workflow-storage', body });
                            const storage = createWorkflowRunStorageClient({ token: f.presentUserToken, machineId: f.machine.id,
                                serverHttpBaseUrl: f.origin, resolveAuthorizationHeaders: () => headers });
                            return storage.execute({ operation: 'get', runId: selectedRunId }, { publisherMachineId: f.machine.id });
                        };
                        // The derived Run has not been created. Its storage owner answers
                        // not-found after authorization; an unrelated address is refused earlier.
                        await expect(read(runId)).rejects.toMatchObject({ response: { status: 404, data: { error: 'run_not_found' } } });
                        await expect(read(crypto.randomUUID())).rejects.toMatchObject({ response: { status: 401 } });
                    } finally { identity.mockRestore(); restoreHttp(); }
                    return { ok: true, result: null };
                });
            expect(apply).toMatchObject({ ok: true });
        } finally { await f.close(); }
    });
});
