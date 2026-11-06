import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import * as undici from 'undici';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import { z } from 'zod/mini';
import { ApprovalRequestV2Schema, QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentReceiptResultV1Schema,
    DeploymentTransitionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentPlatformContentV1Schema } from '@happier-dev/deployment-protocol';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { manifest } from '@/plugins/runtime/deploymentRoleAccount.test-support';
import { createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
    resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { executeScmSourceReadForRequester, type ExecuteScmSourceReadAction } from '@/scm/hostingProviders/resolveRefForHost';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createCliActionExecutor } from './createCliActionExecutor';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import { executeAccountPluginAction } from './executeAccountPluginAction';

// Genuine network boundary: preserve native transport classes and replace only provider Fetch.
vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof import('undici')>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

afterEach(() => { vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

// The trusted UI host, factory, approval Artifact, Account runtime and purpose
// owner stay real. Only Home/provider HTTP and temporary OS custody vary.
it.each(['compact repository', 'compact repository build running', 'compact repository accepted read', 'compact repository refused admission', 'compact repository provider refusal', 'compact repository missing ref', 'compact repository missing requester executor', 'generic', 'qualified', 'changed candidate', 'registry retired', 'transition refused', 'encrypted'] as const)(
'reviews the actual Account deployment before reserving (%s)', async scenario => {
    const compactRepository = scenario.startsWith('compact repository');
    let artifactWrites = 0;
    const phases: Readonly<{ phase: string; at: number }>[] = [];
    const note = (phase: string) => {
        const observation = { phase, at: Date.now() };
        phases.push(observation);
        if (process.env.D5_TRACE_ACCOUNT_ROLE_PHASES === '1') console.info({ scenario, ...observation,
            generation: pluginReloadController.getState().generation,
            registryCurrent: runtime ? pluginReloadController.isRuntimeRegistryCurrent(runtime.registry) : null });
    };
    onTestFailed(() => console.info({ scenario, accountRolePhases: phases }));
    const home = await mkdtemp(join(tmpdir(), 'deployment-role-account-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const app = fastify();
    app.addHook('onResponse', async (request, reply) => {
        if (request.method === 'POST' && request.routeOptions.url === '/v1/artifacts' && reply.statusCode < 300) artifactWrites++;
        if (reply.statusCode >= 400) note(`http:${request.method}:${request.routeOptions.url ?? 'unmatched'}:${reply.statusCode}`);
    });
    let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    note('fixture-start');
    try {
        env.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();
        const identity = await readOrCreateInstallationIdentity();
        const accountId = 'deployment-role-owner';
        const serverId = 'home';
        const machineId = 'machine-a';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const encryptionMode = scenario === 'encrypted' ? 'e2ee' : 'plain';
        const accountKeys = encryptionMode === 'e2ee' ? tweetnacl.box.keyPair() : null;
        const credentials: StoredCredentials = { token, encryption: accountKeys ? { type: 'dataKey',
            machineKey: accountKeys.secretKey, publicKey: accountKeys.publicKey } : null, credentialProvenance: 'stored_session' };
        const authored = await registerAuthoredAccountActionRelease(app, accountId, { encryptionMode, primary: {
            manifest, projectRoot: resolve(import.meta.dirname, '../../..'),
            entryPath: resolve(import.meta.dirname, '../../plugins/runtime/deploymentRoleAccount.test-support.ts'),
        } });
        note('author-release-prepared');
        const action = { pluginId: authored.pluginId, localId: 'deploy' };
        const requiredActionId = scenario === 'qualified' || compactRepository ? formatQualifiedPluginActionId(action) : 'action.invoke';
        const settings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'deployments.deploy': ['ui'] },
            actions: { [requiredActionId]: { approvalRequiredSurfaces: ['ui'] } },
        }) };
        const settingsContent = prepareAccountSettingsV2Content({ credentials, raw: settings,
            envelopeKind: encryptionMode === 'e2ee' ? 'encrypted' : 'plain', randomBytes: tweetnacl.randomBytes });
        const artifacts = authored.artifacts;
        const store = createCredentialedAccountArtifactStore(credentials);
        let serverHttpBaseUrl: string;
        const put = (id: string, kind: string, content: unknown) => runWithServerHttpBaseUrl(serverHttpBaseUrl,
            () => store.create({ artifactId: id, header: { kind, title: 'Platform' }, body: JSON.stringify(content) }));
        const readBody = async (id: string) => runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
            const opened = await store.read(id);
            if (!opened || typeof opened.body !== 'string') throw new Error('Expected admitted Account Artifact content');
            return opened.body;
        });
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.contentArtifactId = randomUUID();
        environment.environment.owner = { kind: 'account', accountId };
        environment.environment.createdByAccountId = accountId;
        delete environment.environment.buildMachineId;
        const link = environment.targetLinks[0]!;
        link.targetLink.contentArtifactId = randomUUID();
        link.targetLink.createdByAccountId = accountId;
        link.targetLink.source = { kind: 'plugin', contribution: { pluginId: authored.pluginId, localId: 'runtime' } };
        link.targetLink.targetKind = 'platform'; link.targetLink.machines = []; link.targetLink.members = [];
        const service = { pluginId: authored.pluginId, localId: 'platform' };
        link.content = { credentialPrincipal: { kind: 'account', accountId,
            purpose: { consumer: { pluginId: authored.pluginId, localId: 'link' }, purpose: 'deploy-manage' },
            target: { kind: 'account', account: { service, accountId: 'recorded-linker' } } },
            providerIdentity: { providerAccountId: 'provider-account', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' } };
        environment.content.definition = { kind: 'stored', document: 'services: {}', contentRevision: 1,
            composeDigest: `sha256:${'a'.repeat(64)}`, profiles: [], services: [] };
        const sourceRef = 'release/current';
        const reviewedSha = 'a'.repeat(40);
        let branchHead = reviewedSha;
        let sourceReads = 0;
        if (compactRepository) {
            environment.content.definition = { kind: 'repository', ref: sourceRef };
            app.get(`/v1/projects/sources/${environment.environment.projectSourceId}`, async () => ({ ok: true, canManage: true,
                source: { id: environment.environment.projectSourceId, revision: 1, name: 'App', audience: [],
                    createdByAccountId: accountId, attachments: [], repository: { protocol: 'https',
                        provider: { id: `${authored.pluginId}/forge`, kind: 'github', displayName: 'Fixture forge', baseUrl: 'https://github.com' },
                        repository: { nameWithOwner: 'owner/project', cloneUrl: 'https://github.com/owner/project.git' } } } }));
            app.get(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, async () => ({ status: 'present', revision: 1,
                content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{
                    purpose: { consumer: { pluginId: authored.pluginId, localId: 'resolve-ref' }, purpose: 'deploy-manage' },
                    target: { kind: 'account', account: { service, accountId: 'recorded-linker' } },
                }] } } } }));
            app.get('/v4/connect/qualified/credential', async request => {
                expect(request.headers.authorization).toBe(`Bearer ${token}`);
                return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: { service, accountId: 'recorded-linker' },
                    authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    configurationRevision: null, content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                        payload: { v: 1, values: { token: 'fixture-scm-token' } }, randomBytes: tweetnacl.randomBytes }), metadata: { scopes: [] } });
            });
        }
        app.get('/v1/account/encryption', async () => ({ mode: encryptionMode, updatedAt: 1 }));
        app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: encryptionMode,
            version: 1, updatedAt: 1, contentKeyFingerprint: accountKeys ? computeContentPublicKeyFingerprint(accountKeys.publicKey) : null }));
        app.get('/v1/account/profile', async () => ({ id: accountId }));
        app.get('/v2/account/settings', async () => ({ content: settingsContent, version: 1 }));
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'recorded-linker' }, status: 'connected',
            authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
            displayName: 'Recorded linker', scopes: [] });
        app.get('/v4/connect/qualified/accounts', async request => {
            expect(request.headers.authorization).toBe(`Bearer ${token}`);
            return { service, accounts: [profile] };
        });
        const features = { features: { connectedServices: { enabled: true } }, capabilities: {
            serverIdentity: { serverIdentityId: serverId }, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } };
        app.get('/v1/features', async () => features); app.get('/v1/features/authenticated', async () => features);
        app.get(`/v1/deployments/environments/${environment.environment.id}`, async () => DeploymentEnvironmentGetResultV1Schema.parse({
            ok: true, environment: environment.environment, targetLinks: [link.targetLink] }));
        let reservations = 0;
        let receipt: ReturnType<typeof createDeploymentReceiptHeaderV1> | undefined;
        app.post(`/v1/deployments/environments/${environment.environment.id}/deploy`, async request => {
            reservations++;
            // Accepted-operation fields come from the real root, not a fabricated child scope.
            const input = z.looseObject({ requestKey: z.string(), actionOperationId: z.string(), contentArtifactId: z.string() }).parse(request.body);
            if (scenario === 'compact repository accepted read') {
                // Home's accepted-receipt read retains custody, not permission
                // to admit another deployment (deploymentEnvironmentService).
                environment.environment.capabilities = { role: 'reader', read: true, deploy: false,
                    manage: false, manageBindings: false, manageTargets: false, delete: false };
            }
            if (scenario === 'compact repository refused admission') link.targetLink.createdByAccountId = 'another-account';
            environment.environment.revision = 7;
            receipt = createDeploymentReceiptHeaderV1({ id: 'platform-receipt', environmentId: environment.environment.id,
                targetLinkId: link.targetLink.id, state: 'queued', requestKey: input.requestKey, actionOperationId: input.actionOperationId,
                requestedByAccountId: accountId, startedAtMs: undefined, settledAtMs: undefined, contentArtifactId: randomUUID(),
                acceptedExecution: { v: 1, controller: { machineId, installationId: identity.installationId } } });
            const candidate = artifacts.read(input.contentArtifactId);
            if (!candidate) throw new Error('Expected the actual reviewed candidate');
            await put(receipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, JSON.parse(await readBody(candidate.id)));
            return DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: receipt.environmentId,
                deploymentId: receipt.id, revision: 7, deploymentRevision: receipt.revision, state: 'queued' });
        });
        app.get('/v1/deployments/receipts/platform-receipt', async () =>
            DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt }));
        app.post(`/v1/deployments/environments/${environment.environment.id}/deployments/platform-receipt/transitions`, async (request, reply) => {
            note('transition-received');
            const wire = DeploymentTransitionInputV1Schema.parse(request.body);
            note(`transition-state:${wire.state}`);
            if (!receipt || !wire.contentUpdate) throw new Error('Expected accepted receipt and canonical content update');
            expect(wire.machineId).toBe(machineId); expect(wire.installationId).toBe(identity.installationId);
            expect(wire.expectedRevision).toBe(receipt.revision);
            if (scenario === 'transition refused') return reply.code(409).send(
                DeploymentReceiptResultV1Schema.parse({ ok: false, error: 'deployment_conflict' }));
            const row = artifacts.read(receipt.contentArtifactId);
            if (!row) throw new Error('Expected receipt content');
            expect(wire.contentUpdate.expectedHeaderVersion).toBe(row.headerVersion);
            expect(wire.contentUpdate.expectedBodyVersion).toBe(row.bodyVersion);
            Object.assign(row, { header: wire.contentUpdate.header, body: wire.contentUpdate.body,
                ...(wire.contentUpdate.provenance === undefined ? {} : { provenance: wire.contentUpdate.provenance }),
                ...(wire.contentUpdate.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: wire.contentUpdate.provenanceDataEncryptionKey }),
                headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 });
            receipt = { ...receipt, state: wire.state, revision: receipt.revision + 1,
                contentHeaderVersion: row.headerVersion, contentBodyVersion: row.bodyVersion, settledAtMs: Date.now() };
            environment.environment.revision++;
            note('transition-committed');
            return DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: receipt.environmentId,
                deploymentId: receipt.id, revision: environment.environment.revision, deploymentRevision: receipt.revision, state: receipt.state });
        });
        serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => authored.publishArtifacts(credentials));
        await put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
        await put(link.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, link.content);
        note('home-artifacts-stored');
        let providerSends = 0;
        const originalFetch = globalThis.fetch;
        const providerFetch: typeof globalThis.fetch = async (url, init) => {
            if (String(url) === `https://purpose-provider.example/commits/${encodeURIComponent(sourceRef)}`) {
                sourceReads++;
                const authorized = new Headers(init?.headers).get('authorization') === 'Bearer fixture-scm-token';
                note(`provider-source:authorized-${authorized}:reservations-${reservations}`);
                if (!authorized) return new Response('', { status: 401 });
                return scenario === 'compact repository missing ref' ? new Response('', { status: 404 }) : new Response(branchHead);
            }
            if (String(url) !== 'https://purpose-provider.example/deploy') return await originalFetch(url, init);
            providerSends++;
            if (compactRepository) expect(new Headers(init?.headers).get('x-reviewed-sha')).toBe(reviewedSha);
            expect(new Headers(init?.headers).has('authorization')).toBe(false);
            if (scenario === 'compact repository provider refusal') return new Response('', { status: 403 });
            if (scenario === 'registry retired') {
                if (!runtime) throw new Error('Expected admitted runtime');
                await retireAdmittedPluginRuntimeRegistry({ controller: runtime.controller, registry: runtime.registry,
                    happyHomeDir: home, generationAuthority: runtime.committed });
            }
            return Response.json({ accepted: true,
                ...(scenario === 'compact repository build running' ? { state: 'BUILDING' } : {}) });
        };
        vi.stubGlobal('fetch', providerFetch);
        // Undici accepts the same Fetch boundary, with additional native dispatcher options.
        vi.mocked(undici.fetch).mockImplementation(providerFetch as unknown as typeof undici.fetch);
        runtime = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            // The daemon contributes declarations only. Executable Account handlers
            // are loaded from the actual authored Account Artifact below.
            plugins: [{ manifest: authored.manifest, files: { 'dist/index.js': 'exports.activate = () => {};' } }], coldStart: true });
        note('runtime-admitted');
        const admittedRuntime = runtime;
        const acquireLease = async () => {
            const lease = admittedRuntime.controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Fixture registry retired');
            return lease;
        };
        await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ensureCliActionPolicySettings(credentials, serverHttpBaseUrl));
        note('account-settings-admitted');
        const snapshot = getActiveAccountSettingsSnapshot();
        if (!snapshot) throw new Error('Expected original Account policy');
        const actionsSettings = snapshot.settings.actionsSettingsV1;
        if (!actionsSettings) throw new Error('Expected the original Account Action settings');
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl,
            isCurrent: async () => lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
                && getActiveAccountSettingsSnapshot()?.scopeKey === snapshot.scopeKey });
        const host = { token, credentials, happyHomeDir: home, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
            serverId, serverIdentityId: serverId, serverHttpBaseUrl, runtimeActionMachineId: machineId, savedSecretOperationContext };
        const sourceExecutor = createCliActionExecutor({ ...host, accountPluginActions: true });
        const executeSourceReadAction: ExecuteScmSourceReadAction = async (action, input, context) => {
            const result = await executeScmSourceReadForRequester(sourceExecutor, action, input, context);
            if (!result.ok) note(`source-read:${result.errorCode}:${result.cause?.errorCode ?? 'no-cause'}`);
            return result;
        };
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async context => selectHostRequesterExecutionIdentity({ actionContext: { ...context,
                authenticatedLocalRootCustody: { serverIdentityId: serverId, accountId, machineId, installationId: identity.installationId } },
                hostHomeServerIdentityId: serverId, hostCustodianAccountId: accountId,
                hostExecutionTarget: { machineId, installationId: identity.installationId } }),
            credentials, serverId, serverHttpBaseUrl, machineId, savedSecretOperationContext,
            acquirePluginRuntimeRegistryLease: acquireLease,
            executeSourceReadAction,
            runtime: { async acquire() { throw new Error('Platform must not acquire native execution'); } } });
        const operations = createHostActionOperationRuntime({ serverId, machineId,
            custodyBinding: { serverId, installationId: identity.installationId },
            resolveAccountId: async () => accountId, generateOperationId: () => 'platform-operation' });
        const harness = createCliActionExecutorHarness(host, { ...deps,
            listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(admittedRuntime.registry, selection),
            invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease }),
            isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, serverId,
                serverApiUrl: serverHttpBaseUrl, machineId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) }),
            routeHostChildAction: async request => {
                const attempt = await executeAccountPluginAction({ host, deps: harness.deps,
                    actionId: request.actionId, input: request.input, context: request.context });
                if (attempt.matched) note(`account-child:${attempt.result.ok ? 'ok' : attempt.result.errorCode}`);
                return attempt.matched ? attempt.result : null;
            },
            runActionOperation: async request => {
                const result = await operations.runActionOperation(request);
                note(`operation:${request.actionId}:${result.ok ? 'ok' : result.errorCode}`);
                return result;
            },
        });
        let context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
            serverIdentityId: serverId, runtimeAccountId: accountId, actionRequestId: 'platform-request',
            executionRunTargetMachineId: machineId, actionsSettings };
        if (scenario === 'compact repository missing requester executor') {
            const target = { kind: 'machine' as const, machineId };
            const envelope = { v: 1 as const, requestId: context.actionRequestId!, target,
                input: { serverId, environmentId: environment.environment.id, targetLinkId: link.targetLink.id } };
            context = { ...context, externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
                token: 'fixture-signed-admission-without-requester-port', binding: { serverIdentityId: serverId,
                    accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 1 },
                    admittedMachineRole: 'manage', accountEncryptionMode: 'plain', actionId: 'deployments.deploy',
                    requestId: envelope.requestId, machineId, installationId: identity.installationId, target,
                    environmentId: environment.environment.id, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } }) };
        }
        const execute = (id: Parameters<typeof harness.executor.execute>[0], input: unknown, current = context) =>
            runWithServerHttpBaseUrl(serverHttpBaseUrl, () => harness.executor.execute(id, input, current));
        const artifactWritesBeforeCandidate = artifactWrites;
        if (scenario === 'compact repository missing requester executor') {
            const result = await executeSourceReadAction({ pluginId: authored.pluginId, localId: 'resolve-ref' }, {}, context);
            expect(result).toMatchObject({ ok: false, errorCode: 'scm_ref_credential_unavailable' });
            expect(sourceReads).toBe(0); expect(artifactWrites).toBe(artifactWritesBeforeCandidate);
            expect(reservations).toBe(0); expect(providerSends).toBe(0);
            return;
        }
        const candidate = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => deps.prepareDeployCandidate({
            environmentId: environment.environment.id, ...(compactRepository ? { targetLinkId: link.targetLink.id }
                : { sourceIntent: environment.content.definition, sourceMethod: 'gitIntegration' as const }),
            requestKey: 'platform-request', context }));
        if (scenario === 'compact repository missing ref') {
            expect(candidate).toMatchObject({ ok: false, errorCode: 'scm_ref_unavailable' });
            expect(sourceReads).toBe(1);
            expect(artifactWrites).toBe(artifactWritesBeforeCandidate);
            expect(reservations).toBe(0); expect(providerSends).toBe(0);
            return;
        }
        if (!candidate.ok) throw new Error(candidate.errorCode);
        note('candidate-prepared');
        if (compactRepository) {
            expect(candidate.content).toMatchObject({ sourceIntent: { kind: 'repository', sha: reviewedSha }, machines: [] });
            expect(sourceReads).toBe(1);
            branchHead = 'b'.repeat(40);
        }
        const proposal = await execute('deployments.deploy', candidate.input);
        note('root-proposed');
        expect(proposal).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(reservations).toBe(0); expect(providerSends).toBe(0);
        const created = z.looseObject({ ok: z.literal(true), result: z.looseObject({ artifactId: z.string() }) }).parse(proposal);
        const approval = artifacts.read(created.result.artifactId);
        if (!approval) throw new Error('Expected actual root approval Artifact');
        const request = ApprovalRequestV2Schema.parse(JSON.parse(await readBody(approval.id)));
        if (compactRepository) {
            expect(request.summary).toContain(sourceRef);
            expect(request.summary).toContain(reviewedSha.slice(0, 7));
        }
        expect(request.executionOriginV1).toMatchObject({ authority: 'present_user', surface: 'ui', accountId, machineId });
        expect(request.preview).toMatchObject({ hostReviewedChildren: { children: expect.arrayContaining([{ action, role: 'deploy' }]) } });
        if (scenario === 'changed candidate') {
            const row = artifacts.read(candidate.input.contentArtifactId);
            if (!row) throw new Error('Expected reviewed candidate');
            const content = DeploymentPlatformContentV1Schema.parse(JSON.parse(await readBody(row.id)));
            if (content.sourceIntent.kind !== 'stored') throw new Error('Expected stored candidate');
            content.sourceIntent.contentRevision++;
            const updated = await originalFetch(`${serverHttpBaseUrl}/v1/artifacts/${row.id}`, { method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ expectedHeaderVersion: row.headerVersion, expectedBodyVersion: row.bodyVersion,
                    header: row.header, body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }) }) });
            expect(updated.status).toBe(200);
        }
        const decide = () => execute('approval.request.decide', { artifactId: created.result.artifactId, decision: 'approve' },
            { ...context, actionRequestId: 'approve-platform-request' });
        const decision = await decide();
        note('root-replayed');
        const failedExecution = z.looseObject({ result: z.looseObject({ execution: z.looseObject({ errorCode: z.string(),
            failureCause: z.optional(z.looseObject({ phase: z.optional(z.string()), errorCode: z.optional(z.nullable(z.string())) })) }) }) }).safeParse(decision);
        if (failedExecution.success) {
            const failure = failedExecution.data.result.execution;
            note(`replay-failure:${failure.errorCode}:${failure.failureCause?.phase ?? 'no-phase'}:${failure.failureCause?.errorCode ?? 'no-cause'}`);
        }
        if (scenario === 'changed candidate') {
            expect(decision).toMatchObject({ ok: true, result: { status: 'failed' } });
            expect(reservations).toBe(0); expect(providerSends).toBe(0);
        } else if (scenario === 'compact repository refused admission') {
            expect(decision).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                ok: false, errorCode: 'deployment_access_denied', effectAttempted: false,
                failureCause: { phase: 'deployment.target.admission.link_author' },
            } } });
            expect(reservations).toBe(1); expect(providerSends).toBe(0);
            if (!receipt) throw new Error('The refused accepted deployment must retain its receipt');
            expect(JSON.parse(await readBody(receipt.contentArtifactId))).toMatchObject({ failure: {
                code: 'deployment_access_denied', phase: 'admission', effectAttempted: false,
                failureCause: { phase: 'deployment.target.admission.link_author' },
            } });
        } else if (scenario === 'compact repository provider refusal') {
            expect(decision).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                ok: false, errorCode: 'deployment_access_denied', failureCause: {
                    phase: 'deployment.provider.send', errorCode: null, httpStatus: 403 },
            } } });
            expect(reservations).toBe(1); expect(providerSends).toBe(1);
            if (!receipt || !failedExecution.success) throw new Error('The failed provider deployment must retain its receipt and failure');
            expect(JSON.parse(await readBody(receipt.contentArtifactId))).toMatchObject({ failure: {
                code: 'deployment_access_denied', phase: 'send', failureCause: failedExecution.data.result.execution.failureCause,
            } });
        } else {
            if (scenario !== 'transition refused') expect(decision).not.toHaveProperty('result.execution.errorCode');
            expect(decision).toMatchObject(scenario === 'transition refused'
                ? { ok: true, result: { status: 'outcome_unknown', execution: { ok: false,
                    errorCode: 'outcome_unknown', effectAttempted: true } } }
                : { ok: true, result: { status: 'executed', execution: { ok: true } } });
            if (scenario !== 'transition refused') expect(receipt?.state)
                .toBe(scenario === 'compact repository build running' ? 'running' : 'succeeded');
            if (scenario === 'compact repository build running') {
                expect(decision).toMatchObject({ result: { execution: { ok: true,
                    result: { state: 'running', deploymentId: 'platform-receipt' } } } });
                const publicRead = await execute('approval.request.get', { artifactId: created.result.artifactId });
                expect(publicRead).toMatchObject({ ok: true, result: { request: { status: 'executed', execution: {
                    ok: true, result: { state: 'running', deploymentId: 'platform-receipt' },
                } } } });
            }
            if (compactRepository) {
                if (!receipt) throw new Error('Expected exact-SHA receipt');
                expect(JSON.parse(await readBody(receipt.contentArtifactId))).toMatchObject({ sourceIntent: { kind: 'repository', sha: reviewedSha } });
                expect(sourceReads).toBe(1);
            }
            if (scenario === 'encrypted') {
                expect(approval.encryptionMode).toBe('e2ee');
                expect(decodePlainArtifactStoredContent(approval.body)).toBeNull();
                if (!receipt) throw new Error('Expected signed receipt');
                const storedReceipt = artifacts.read(receipt.contentArtifactId);
                expect(storedReceipt?.encryptionMode).toBe('e2ee');
                expect(storedReceipt?.body).not.toContain('provider-platform-receipt');
                expect(DeploymentPlatformContentV1Schema.parse(JSON.parse(await readBody(receipt.contentArtifactId))))
                    .toMatchObject({ platform: { observation: { state: 'succeeded', providerDeploymentId: 'provider-platform-receipt' } } });
            }
            expect(reservations).toBe(1); expect(providerSends).toBe(1);
            await decide();
            expect(reservations).toBe(1); expect(providerSends).toBe(1);
        }
    } finally {
        note('cleanup-start');
        try { await runtime?.dispose(); }
        finally {
            try { await app.close(); }
            finally {
                env.restore(); reloadConfiguration();
                await rm(home, { recursive: true, force: true });
                note('cleanup-complete');
            }
        }
    }
});
