import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { encodeBase64, DeploymentTransitionInputV1Schema, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ActionOperationFailureV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { AutomationEventActionHttpPathsV1 } from '@happier-dev/protocol/automations/event';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { DeploymentFailedEventV1ProtocolSchema, DeploymentReceiptOutcomeEventV1ProtocolSchema,
    DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { canTransitionDeploymentV1, DeploymentPlatformContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture, requireDaemonEntrypoint } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader, listRuntimeContributedActionDefinitions }
    from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import * as installationStore from '@/daemon/identity/store';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import * as cloudflare from '../../../../packages/plugins/deploy-cloudflare/src/index';
import * as machineServices from '../../../../packages/plugins/machine-services/src/index';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import * as persistence from '@/persistence';
import { createDeploymentReceiptEventSourceAdapter, deploymentEventActions } from '../../../../packages/plugins/machine-services/src/deploymentEvents';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// Node's HTTP adapter uses Undici fetch; keep it on the same fixture network
// boundary as portable Account fetch so no provider call reaches a real tenant.
vi.mock('undici', async importOriginal => ({
    ...await importOriginal<typeof import('undici')>(),
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

// The fixture Home uses HTTP injection, so its Account update channel is the
// canonical Socket.IO network stub; currentness and its readers remain real.
vi.mock('socket.io-client', async importOriginal => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    return { ...actual, io: () => createApiSessionSocketStub() };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Home persistence and Cloudflare HTTP are the boundaries. The actual portable
// Account artifact, role admission, reviewed child and receipt writer stay real.
it.each(['queued', 'succeeded', 'second-preview', 'production', 'failed', 'lost-response', 'missing-preview', 'settled-preview', 'settled-worker', 'settled-pages', 'watched-non-production',
    'settled authored replay', 'same authored retry after no effect', 'changed authored sha after no effect'] as const)('deploys the reviewed Cloudflare source through the plugin target and retains its %s outcome', async scenario => {
    const watched = scenario === 'watched-non-production';
    const retryAfterNoEffect = scenario === 'same authored retry after no effect' || scenario === 'changed authored sha after no effect';
    const authoredRetry = scenario === 'settled authored replay' || retryAfterNoEffect;
    const worker = scenario === 'production' || scenario === 'settled-worker';
    const outcome = authoredRetry || scenario === 'second-preview' || scenario === 'production' ? 'succeeded'
        : scenario === 'lost-response' || scenario === 'missing-preview' ? 'outcome_unknown'
        : scenario.startsWith('settled-') || watched ? 'queued' : scenario;
    const accountId = 'owner', origin = 'https://platform-home.test';
    const providerAccountId = 'a'.repeat(32), workerTag = 'b'.repeat(32), previewId = (scenario === 'second-preview' ? 'd' : 'c').repeat(32);
    const sha = 'f'.repeat(40), gitBranch = scenario === 'second-preview' ? 'feature/another-review' : 'feature/reviewed',
        previewName = scenario === 'second-preview' ? 'review/18' : 'review/17';
    const app = fastify();
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId: 'srv_cloudflare_preview_home' });
    // The containing runtime admits the portable Home from its authenticated
    // features, just as SessionClient.getServerIdentityId does in production.
    const serverIdentityId = readServerIdentityIdFromFeaturesSnapshot({ status: 'ready', provenance: 'authenticated', features: homeFeatures });
    if (!serverIdentityId) throw new Error('Expected the admitted Cloudflare fixture Home');
    const serverId = serverIdentityId;
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest: cloudflare.manifest,
        projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/deploy-cloudflare'),
        entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/deploy-cloudflare/src/accountRuntime.ts'),
        manifestExport: null,
    } });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 7,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(83));
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'installation-a', createdAt: 1, publicKey: encodeBase64(installation.publicKey, 'base64url'),
        privateKey: encodeBase64(installation.secretKey, 'base64url') });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.serverId = serverIdentityId;
    if (watched) environment.environment.protection = 'nonProduction';
    environment.environment.owner = { kind: 'account', accountId };
    delete environment.environment.buildMachineId;
    environment.content.definition = { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } };
    const sourceIntent = { kind: 'repository' as const, projectSourceId: environment.environment.projectSourceId,
        sourceRevision: 1, sha, compose: environment.content.definition.compose };
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' };
    const row = environment.targetLinks[0]!;
    row.targetLink.source = { kind: 'plugin', contribution: { pluginId: cloudflare.manifest.id, localId: 'workers' } };
    row.targetLink.targetKind = 'cloudflare-workers';
    row.targetLink.createdByAccountId = accountId;
    row.targetLink.machines = []; row.targetLink.members = [];
    const descriptor = cloudflare.manifest.contributes.connectedAccountDescriptors?.[0];
    if (!descriptor) throw new Error('Cloudflare Account declaration required');
    const service = { pluginId: cloudflare.manifest.id, localId: descriptor.id };
    const credentialRef = { service, accountId: 'connected-original' };
    row.content = { credentialPrincipal: { kind: 'account', accountId,
        purpose: { consumer: { pluginId: cloudflare.manifest.id, localId: 'workers-link' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account: credentialRef } },
        providerIdentity: { providerAccountId, providerResourceId: workerTag,
            providerEnvironment: `preview:${JSON.stringify(['app', previewName])}` },
        providerEnvironment: { kind: 'preview', scriptName: 'app', previewName },
        repositoryAccess: { status: 'ready', repository },
        preparedNative: { projectName: 'app', previewId, gitBranch, workerTag, scriptName: 'app' } };
    if (worker) {
        row.content.providerIdentity.providerEnvironment = 'script:app';
        row.content.providerEnvironment = { kind: 'script', scriptName: 'app' };
        row.content.preparedNative = { projectName: 'app', triggerUuid: 'production-trigger' };
    }
    if (scenario === 'settled-pages') {
        row.targetLink.source = { kind: 'plugin', contribution: { pluginId: cloudflare.manifest.id, localId: 'pages' } };
        row.targetLink.targetKind = 'cloudflare-pages';
        row.content.credentialPrincipal.purpose.consumer.localId = 'pages-link';
        row.content.providerIdentity.providerEnvironment = 'production';
        row.content.providerEnvironment = { kind: 'production' };
        row.content.preparedNative = { projectName: 'app', pages: { projectMode: 'directUpload', productionBranch: 'main' } };
    }
    const seed = (id: string, kind: string, content: unknown) => authored.artifacts.seed(id,
        encodePlainArtifactStoredContent({ kind, title: 'Preview' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
    seed(environment.environment.contentArtifactId, 'deployment-environment.v1', environment.content);
    seed(row.targetLink.contentArtifactId, 'deployment-target-link.v1', row.content);
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: credentialRef, status: 'connected',
        authenticationModeId: descriptor.authentication.defaultModeId, revisionSemantics: 'revisioned', credentialRevision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
        displayName: 'Original Cloudflare', scopes: [] });
    const materializations: unknown[] = [];
    const purposeOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: accountId,
        store: { read: async () => ({ v: 1, bindings: [] }), update: async () => { throw new Error('No preference writes'); },
            subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('Deployment must not reopen Account selection'); },
        resolveTarget: createPurposeTargetResolver({ available: true,
            resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
        resolveCredentialRevision: async () => credentialRevision,
        materializeAccount: async request => { materializations.push(request.account);
            request.credentialRevisionBasis?.captureCredentialRevision(credentialRevision);
            return { kind: 'httpHeaders', headers: { authorization: 'Bearer preview-fixture-secret' } }; },
        projectTargetAccounts: async () => [], assertTargetAccountMaterializable: async () => undefined,
    });
    const providerRequests: { method: string; path: string; body: unknown }[] = [];
    let observingReceipt = false;
    let watchedState: 'queued' | 'failed' | 'succeeded' = 'queued';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.origin === origin) {
            if (parsed.pathname === '/v1/features') return Response.json(homeFeatures);
            const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST',
                url: `${parsed.pathname}${parsed.search}`, headers: Object.fromEntries(new Headers(init?.headers)),
                ...(init?.body ? { payload: await new Response(init.body).text() } : {}) });
            return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
        }
        expect(parsed.origin).toBe('https://api.cloudflare.com');
        expect(new Headers(init?.headers).get('authorization') === 'Bearer preview-fixture-secret').toBe(true);
        providerRequests.push({ method: init?.method ?? 'GET', path: parsed.pathname,
            body: init?.body ? JSON.parse(await new Response(init.body).text()) : null });
        if (scenario === 'lost-response') throw new Error('Lost the accepted provider response');
        if (scenario === 'missing-preview') return Response.json({ success: false, errors: [{ code: 10090 }] }, { status: 404 });
        if (scenario === 'settled-pages') return Response.json({ success: true, result: {
            id: 'reviewed-preview-build', environment: 'production', latest_stage: { name: 'deploy', status: 'success' },
            url: 'https://app.pages.dev',
        } });
        if (parsed.pathname.endsWith('/workers/scripts/app/deployments')) return Response.json({ success: true,
            result: { deployments: [{ versions: [{ version_id: 'production-version', percentage: 100 }] }] } });
        if (parsed.searchParams.has('version_ids')) return Response.json({ success: true,
            result: { builds: { 'provider-owned-key': { build_uuid: 'reviewed-preview-build' } } } });
        if (watched) return Response.json({ success: true, result: parsed.pathname.endsWith('/deployments/latest')
            ? { id: 'preview-deployment', urls: ['https://reviewed-preview.example.workers.dev'] }
            : { build_uuid: 'reviewed-preview-build', status: watchedState === 'queued' ? 'queued' : 'stopped',
                ...(watchedState === 'failed' ? { build_outcome: 'fail' } : {}),
                ...(watchedState === 'succeeded' ? { build_outcome: 'success', preview_url: 'https://reviewed-preview.example.workers.dev' } : {}) } });
        return Response.json({ success: true, result: parsed.pathname.endsWith('/deployments/latest')
            ? { id: 'preview-deployment', urls: ['https://reviewed-preview.example.workers.dev'] }
            : { build_uuid: 'reviewed-preview-build', status: outcome === 'queued' && !observingReceipt ? 'queued' : 'stopped',
                ...(outcome === 'failed' ? { build_outcome: 'fail' } : {}),
                ...(outcome === 'succeeded' || observingReceipt ? { build_outcome: 'success', preview_url: 'https://reviewed-preview.example.workers.dev' } : {}) } });
    });
    let receipt = createDeploymentReceiptHeaderV1({ id: 'preview-receipt', environmentId: environment.environment.id,
        targetLinkId: row.targetLink.id, requestKey: 'reviewed-preview', actionOperationId: 'preview-operation',
        state: 'queued', startedAtMs: undefined, settledAtMs: undefined,
        acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' } } });
    const transitions: unknown[] = [];
    let refusedReceiptId: string | undefined;
    let deployAdmissions = 0;
    let time = Date.now();
    const admissions: unknown[] = [];
    app.get('/v1/projects/sources/:sourceId', async () => ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true,
        source: { id: sourceIntent.projectSourceId, revision: 1, name: 'App', owner: { kind: 'account', accountId },
            audience: [], createdByAccountId: accountId, repository: { protocol: 'https',
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: repository.deployment },
                repository: { nameWithOwner: repository.repository, cloneUrl: 'https://github.com/example/app.git' } } } }));
    app.get('/v1/deployments/environments/:environmentId', async () => ({ ok: true,
        environment: environment.environment, secretScope: environment.secretScope, targetLinks: [row.targetLink] }));
    app.get('/v1/deployments/receipts/:deploymentId', async (request, reply) => {
        if ((request.params as { deploymentId: string }).deploymentId === refusedReceiptId) {
            return reply.code(404).send({ ok: false, error: 'deployment_not_found' });
        }
        return { ok: true, deployment: receipt };
    });
    app.get('/v1/deployments/environments/:environmentId/deployments', async request => ({ ok: true,
        items: (request.query as { inProgressOnly?: string }).inProgressOnly === 'true'
            && (receipt.state === 'failed' || receipt.state === 'succeeded') ? [] : [receipt], nextCursor: null }));
    app.post(AutomationEventActionHttpPathsV1['automation.event.admit'], async request => {
        admissions.push(request.body);
        return { results: [{ kind: 'observed', checkpointSafe: true }],
            continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } };
    });
    app.post(AutomationEventActionHttpPathsV1['automation.event.source.status.report'], async () => ({}));
    app.post('/v1/deployments/environments/:environmentId/deploy', async request => {
        const body = request.body as { contentArtifactId: string; requestKey: string; actionOperationId: string };
        if (authoredRetry) {
            deployAdmissions++;
            receipt = createDeploymentReceiptHeaderV1({ ...receipt, id: `retry-receipt-${deployAdmissions}`,
                actionOperationId: body.actionOperationId, contentArtifactId: body.contentArtifactId, requestKey: body.requestKey,
                state: 'queued', revision: 1, startedAtMs: undefined, settledAtMs: undefined });
            if (retryAfterNoEffect && deployAdmissions === 1) refusedReceiptId = receipt.id;
            return { ok: true, environmentId: receipt.environmentId, revision: environment.environment.revision,
                deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state };
        }
        receipt = watched && receipt.state === 'failed'
            ? createDeploymentReceiptHeaderV1({ ...receipt, id: 'recovery-receipt', revision: 1, state: 'queued',
                contentArtifactId: body.contentArtifactId, requestKey: body.requestKey, settledAtMs: undefined, startedAtMs: undefined })
            : { ...receipt, contentArtifactId: body.contentArtifactId };
        return { ok: true, environmentId: receipt.environmentId, revision: 1,
            deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state };
    });
    app.post('/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions', async request => {
        const body = DeploymentTransitionInputV1Schema.parse(request.body);
        transitions.push(body);
        // Preserve Home's canonical lifecycle contract at the persistence boundary.
        if (!canTransitionDeploymentV1(receipt.state, body.state)) return { ok: false, error: 'deployment_conflict' };
        const stored = authored.artifacts.read(body.contentArtifactId);
        if (!stored || !body.contentUpdate) throw new Error('Expected the admitted receipt update');
        authored.artifacts.seed(body.contentArtifactId, body.contentUpdate.header ?? stored.header, body.contentUpdate.body ?? stored.body);
        receipt = { ...receipt, state: body.state, revision: receipt.revision + 1,
            ...(watched && (body.state === 'failed' || body.state === 'succeeded') ? { settledAtMs: time } : {}) };
        return { ok: true, environmentId: receipt.environmentId, revision: 1,
            deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state };
    });
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const mounted = await createAuthoredAdmittedPluginRuntimeFixture({
        runtimeOptions: { connectedAccounts: purposeOwner, actionFormConnectedAccounts: purposeOwner,
            accountExecution: { credentials, serverUrl: origin, serverId, serverIdentityId, machineId: 'machine-a', isCurrent: async () => true },
            resolveCurrentMachineId: () => 'machine-a' },
        plugins: [{ manifest: cloudflare.manifest, files: { [requireDaemonEntrypoint(cloudflare.manifest)]: 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: cloudflare.activate }) }],
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    try {
        const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => serverIdentityId,
            resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: accountId }) });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId, serverHttpBaseUrl: origin, machineId: 'machine-a',
            resolveRequesterIdentity: async context => {
                const requester = await identityOwner.resolveActionRequester!(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            },
            runtime: { async acquire() { throw new Error('Provider Git deployment must not acquire native runtime'); } },
            acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry }) });
        const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId,
            actionCaller: { kind: 'host' }, serverId, serverIdentityId,
            machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: 'machine-a',
                installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
            actionsSettings: normalizeActionsSettingsV1(undefined), presentUserConfirmation: { actionId: 'deployments.deploy' },
            operationAcceptance: { operationId: 'preview-operation', accept() {} } };
        const candidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
            requestKey: 'reviewed-preview', sourceIntent, sourceMethod: 'gitIntegration', context });
        expect(candidate, JSON.stringify(candidate)).toMatchObject({ ok: true,
            content: { sourceIntent, platform: { preparedNative: row.content.preparedNative } } });
        if (!candidate.ok) throw new Error(candidate.errorCode);
        const list: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['listContributedActionDefinitions']> =
            selection => listRuntimeContributedActionDefinitions(mounted.registry, selection);
        const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
            const lease = mounted.controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Fixture registry unavailable');
            return lease;
        } });
        const operations = authoredRetry ? createHostActionOperationRuntime({
            serverId, machineId: 'machine-a', resolveAccountId: async () => accountId,
        }) : undefined;
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
            ...(operations ? { runActionOperation: operations.runActionOperation,
                resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: environment.environment.id } }) } : {}),
            listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
            invokeContributedAction: invoke });
        if (authoredRetry) {
            const { operationAcceptance: _fixtureAcceptance, ...authoredContext } = context;
            const input = { serverId, environmentId: environment.environment.id, targetLinkId: row.targetLink.id,
                requestKey: 'reviewed-preview', sourceIntent, sourceMethod: 'gitIntegration' as const };
            const invoke = (intent: typeof input, actionRequestId: string) =>
                executor.execute('deployments.deploy', intent, { ...authoredContext, actionRequestId });
            const providerDeploys = () => providerRequests.filter(request => request.method === 'POST');
            const first = await invoke(input, 'first-authored-deploy');
            expect(deployAdmissions, JSON.stringify(first)).toBe(1);
            if (retryAfterNoEffect) {
                expect(first).toMatchObject({ ok: false, effectAttempted: false });
                expect(providerDeploys()).toHaveLength(0);
            } else {
                expect(first).toMatchObject({ ok: true, result: { state: 'succeeded' } });
                expect(providerDeploys()).toHaveLength(1);
            }

            // Keep the prepared CAS equal for the changed-source case, where only
            // the fresh candidate identifies the different source in the operand.
            if (scenario !== 'changed authored sha after no effect') environment.environment.revision++;
            const retry = await invoke(scenario === 'changed authored sha after no effect'
                ? { ...input, sourceIntent: { ...sourceIntent, sha: 'e'.repeat(40) } } : input, 'second-authored-deploy');
            if (scenario === 'changed authored sha after no effect') {
                expect.soft(retry).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
                expect.soft(deployAdmissions).toBe(1);
                expect(providerDeploys()).toHaveLength(0);
            } else if (retryAfterNoEffect) {
                expect(retry).toMatchObject({ ok: true, result: { state: 'succeeded' } });
                expect(deployAdmissions).toBe(2);
                expect(providerDeploys()).toMatchObject([{ body: { commit_hash: sha, branch: gitBranch } }]);
            } else {
                expect(retry).toEqual(first);
                expect(deployAdmissions).toBe(1);
                expect(providerDeploys()).toHaveLength(1);
            }
            return;
        }
        if (scenario === 'settled-pages') {
            // Home persistence is the boundary: this is the accepted upload
            // receipt tested separately through the real Pages upload Action.
            receipt.contentArtifactId = candidate.input.contentArtifactId;
            seed(receipt.contentArtifactId, 'deployment-receipt.v1', { ...candidate.content, sourceMethod: 'upload',
                platform: { ...candidate.content.platform, observation: { v: 1, state: 'queued',
                    providerDeploymentId: 'reviewed-preview-build', observedAtMs: 1 } } });
            const observed = await executor.execute('deployments.receipts.observe', {
                serverId, environmentId: environment.environment.id, deploymentId: receipt.id,
            }, context);
            expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true, result: { state: 'succeeded' } });
            expect(receipt.state).toBe('succeeded');
            expect(providerRequests).toEqual([{ method: 'GET',
                path: `/client/v4/accounts/${providerAccountId}/pages/projects/app/deployments/reviewed-preview-build`, body: null }]);
            expect(materializations).not.toHaveLength(0);
            for (const account of materializations) expect(account).toEqual(credentialRef);
            return;
        }
        const result = await executor.execute('deployments.deploy', candidate.input, context);
        // A queued response retains progress; the watched case below settles
        // it through the same public SDK observer without a UI refresh.
        expect(result, JSON.stringify({ result, providerRequests })).toMatchObject(outcome === 'outcome_unknown'
            ? { ok: false, errorCode: scenario === 'missing-preview' ? 'deployment_unavailable' : 'outcome_unknown' }
            : outcome === 'failed' ? { ok: false, errorCode: 'deployment_failed', details: { state: 'failed', deploymentId: receipt.id } }
            : { ok: true, result: { state: outcome, deploymentId: receipt.id } });
        expect(providerRequests).toEqual(worker ? [{ method: 'POST',
            path: `/client/v4/accounts/${providerAccountId}/builds/triggers/production-trigger/builds`, body: { commit_hash: sha } },
            ...(outcome === 'queued' ? [] : [
            { method: 'GET', path: `/client/v4/accounts/${providerAccountId}/workers/scripts/app/deployments`, body: null },
            { method: 'GET', path: `/client/v4/accounts/${providerAccountId}/builds/builds`, body: null },
            { method: 'GET', path: `/client/v4/accounts/${providerAccountId}/workers/scripts/app/subdomain`, body: null }])] : [{ method: 'POST',
            path: `/client/v4/accounts/${providerAccountId}/builds/workers/${workerTag}/previews/${previewId}/builds`,
            body: { commit_hash: sha, branch: gitBranch } }, ...(outcome === 'succeeded' ? [{ method: 'GET',
                path: `/client/v4/accounts/${providerAccountId}/workers/workers/app/previews/${previewId}/deployments/latest`, body: null }] : [])]);
        expect(materializations).not.toHaveLength(0);
        for (const account of materializations) expect(account).toEqual(credentialRef);
        expect(transitions).toEqual([expect.objectContaining({ state: scenario === 'missing-preview' ? 'failed' : outcome,
            contentArtifactId: receipt.contentArtifactId })]);
        const stored = authored.artifacts.read(receipt.contentArtifactId);
        if (!stored) throw new Error('Expected the retained receipt Artifact');
        const decoded = decodePlainArtifactStoredContent(stored.body);
        if (!decoded || typeof decoded !== 'object' || !('body' in decoded) || typeof decoded.body !== 'string') throw new Error('Expected persisted receipt');
        const content = DeploymentPlatformContentV1Schema.parse(JSON.parse(decoded.body));
        expect(content.platform).toMatchObject({ ...row.content,
            ...(scenario === 'missing-preview' ? {} : { observation: { state: scenario === 'lost-response' ? 'queued' : outcome,
                ...(scenario === 'lost-response' ? {} : { providerDeploymentId: 'reviewed-preview-build' }) } }) });
        if (scenario === 'lost-response') {
            expect(receipt.state).toBe('outcome_unknown');
            expect(content.platform?.observation?.providerDeploymentId).toBeUndefined();
            if (result.ok) throw new Error('A lost provider response must retain its uncertain settlement');
            expect(result.details).toMatchObject({ deploymentId: receipt.id, failure: {
                phase: 'send', requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
            const publicFailure = ActionOperationFailureV1Schema.parse({ errorCode: result.errorCode,
                error: result.error, details: result.details });
            expect(publicFailure.details).toMatchObject({ deploymentId: receipt.id, failure: {
                phase: 'send', requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
        }
        expect(providerRequests.some(request => request.path.includes('/workers/scripts/'))).toBe(scenario === 'production');
        expect(JSON.stringify({ result, content })).not.toContain('preview-fixture-secret');
        if (watched) {
            const periodMs = 7300;
            // Background setup belongs to the daemon; the Account registry
            // above owns the provider Actions, not daemon-only setup Actions.
            const daemon = await runWithServerHttpBaseUrl(origin, async () => createAuthoredAdmittedPluginRuntimeFixture({
                runtimeOptions: { scopedActionRuntime: { credentials,
                    actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false }) },
                    externalActionHomeBinding: { serverId, serverIdentityId },
                    resolveCurrentMachineId: () => 'machine-a',
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId: 'machine-a' }) },
                plugins: [{ manifest: cloudflare.manifest, files: { [requireDaemonEntrypoint(cloudflare.manifest)]: 'export function activate() {}' },
                    instantiateCommittedModule: () => ({ activate: cloudflare.activate }) },
                { manifest: machineServices.manifest, files: { [requireDaemonEntrypoint(machineServices.manifest)]: 'export function activate() {}',
                    ...Object.fromEntries(await Promise.all((machineServices.manifest.contributes.resources ?? [])
                        .filter(resource => resource.kind === 'asset').map(async resource => [resource.path,
                            await readFile(new URL(`../../../../packages/plugins/machine-services/${resource.path}`, import.meta.url))]))) },
                    instantiateCommittedModule: () => ({ activate: machineServices.activate }) }],
                resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
            }));
            try {
                time = Date.now();
                const caller = daemon.lease.resolveCurrentPluginMaterializationRef?.(machineServices.manifest.id);
                if (!caller) throw new Error('Expected the published machine-services materialization');
                const sourceCustody = daemon.registry.readPluginSourceCustody?.(machineServices.manifest.id);
                const pluginOccurrenceId = daemon.registry.readPluginOccurrenceId?.(machineServices.manifest.id);
                if (!sourceCustody || !pluginOccurrenceId) throw new Error('Expected the admitted background source occurrence');
                vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId: 'machine-a' });
                vi.spyOn(installationStore, 'readOrCreateInstallationIdentity').mockResolvedValue({ version: 1,
                    installationId: 'installation-a', createdAt: 1, publicKey: encodeBase64(installation.publicKey, 'base64url'),
                    privateKey: encodeBase64(installation.secretKey, 'base64url') });
                let adopted: ReturnType<typeof createAutomationEventAdoptedDefinitionSetHostV1> | null = null;
                let activeOccurrenceId: string | null = null;
                const cli = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
                    serverId, serverHttpBaseUrl: origin,
                    acquireAutomationEventObservationRegistry: () => daemon.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => daemon.registry }),
                    resolveAutomationEventAdoptedDefinitionSet: (_caller, _occurrence, transport) =>
                        transport.kind === 'checkpointedPull' ? adopted : null,
                    revalidatePluginActionCallerMaterialization: async materialization => materialization.materializationId === caller.materializationId
                        && materialization.pluginId === caller.pluginId && materialization.machineId === caller.machineId,
                    revalidatePluginActionCallerOccurrence: async occurrence => occurrence.pluginId === caller.pluginId && occurrence.occurrenceId === activeOccurrenceId });
                const observerExecutor = createActionExecutor({ ...cli, ...deps, listContributedActionDefinitions: list,
                    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list), invokeContributedAction: invoke });
                let observationCommitted = () => {};
                let failObservation = (_error: Error) => {};
                function observerContext(controller: AbortController, occurrenceId: string) {
                    activeOccurrenceId = occurrenceId;
                    const seed: PluginInvocationServicesSeed = { plugin: { id: caller.pluginId, version: machineServices.manifest.version }, occurrenceId,
                        approvalContext: { serverId, serverIdentityId, runtimeAccountId: accountId },
                        sourceCustody, contribution: { id: 'deployment-receipt-observer', qualifiedId: `${caller.pluginId}/backgroundServices/deployment-receipt-observer` },
                        surface: 'background', signal: controller.signal, resolveCurrentPluginMaterializationRef: () => caller,
                        isOccurrenceCurrent: () => !controller.signal.aborted };
                    const actions = createPluginInvocationActionsService({ seed, actionExecutor: {
                        ...observerExecutor, execute: async (id, input, actionContext) => {
                            const result = await observerExecutor.execute(id, input, { ...actionContext,
                            actionsSettings: setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
                                actionId: 'automation.event.admit', surface: 'plugin', approvalRequired: false }) });
                            if (!result.ok) failObservation(new Error(JSON.stringify({ actionId: id,
                                errorCode: result.errorCode, failureCause: result.failureCause })));
                            else if (id === 'automation.event.admit' && admissions.length) observationCommitted();
                            return result;
                        },
                    }, invokeContributedAction: invoke });
                    // Authenticated wake delivery is the boundary.
                    return { ...seed, materialization: caller, invokedAtMs: time, services: { actions,
                        events: { host: { subscribe: () => ({ dispose() {} }) } } } } as unknown as BackgroundServiceContext;
                }
                // This composition substitutes Home persistence, not signed
                // Machine admission. Use the real setup owner with the same
                // native SDK executor as the observer, never a fake Action result.
                const setupController = new AbortController();
                const setups = await runWithServerHttpBaseUrl(origin, () => Promise.all(Object.values(DEPLOYMENT_RECEIPT_EVENT_REFS_V1)
                    .map(async eventRef => ({ eventRef, setup: PluginEventAutomationSetupResultV1Schema.parse(
                        await deploymentEventActions[`${eventRef.localId}/setup`]!.run({ v: 1, serverId, environmentId: environment.environment.id,
                            targetLinkId: row.targetLink.id, periodMs }, observerContext(setupController, pluginOccurrenceId))) }))));
                setupController.abort();
                for (const { setup } of setups) expect(setup.sourceConfig).toMatchObject({ periodMs, credentialPrincipal: row.content.credentialPrincipal });
                const retained: AutomationEventStoredDefinitionProjectionV1[] = setups.map(({ eventRef, setup }) => {
                    const binding = { v: 1 as const, automationId: randomUUID(), triggerId: eventRef.localId, triggerRevision: 1,
                        triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: randomUUID() };
                    return {
                    automationId: binding.automationId, triggerId: binding.triggerId, triggerRevision: binding.triggerRevision,
                    eventRef: binding.eventRef, sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
                    observationOnly: { kind: 'observationOnly' }, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller },
                    payloadSchema: (eventRef.localId === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId
                        ? DeploymentFailedEventV1ProtocolSchema : DeploymentReceiptOutcomeEventV1ProtocolSchema).jsonSchema,
                    storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                        definition: { v: 1, sourceInstanceId: setup.sourceInstanceId, sourceConfig: setup.sourceConfig,
                            displayLabel: setup.displayLabel, filter: null, maximumObservationAgeMs: null } }) };
                });
                async function cycle(continuous: boolean) {
                    const controller = new AbortController();
                    const occurrenceId = pluginOccurrenceId;
                    const context = observerContext(controller, occurrenceId);
                    adopted = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller, occurrenceId, sourceCustody,
                        transport: { kind: 'checkpointedPull' }, occurrenceSignal: controller.signal,
                        isOccurrenceCurrent: () => !controller.signal.aborted,
                        revalidateCallerMaterialization: async () => daemon.controller.isRuntimeRegistryCurrent(daemon.registry),
                        revalidateCallerOccurrence: async () => !controller.signal.aborted,
                        resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: 'aemk1_signing',
                            contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
                        resolveAccountEncryptionMaterial: async () => null,
                        readStoredDefinitions: async () => ({ kind: 'page', revision: '1', definitions: retained, nextCursor: null,
                            eventDeclarationRelease: { release: { pluginId: caller.pluginId, version: machineServices.manifest.version },
                                archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }),
                    });
                    const committed = new Promise<void>((resolve, reject) => { observationCommitted = resolve; failObservation = reject; });
                    const sleep = vi.fn(async (delay: number) => { expect(delay).toBe(periodMs); time += delay; watchedState = 'failed'; });
                    const running = runWithServerHttpBaseUrl(origin, () => runCheckpointedPluginEventObserverV1({ context,
                        source: createDeploymentReceiptEventSourceAdapter(context.services.events.host, () => time),
                        mode: continuous ? 'continuous' : 'once', now: () => time, sleep }));
                    try {
                        if (continuous) {
                            await committed;
                            const idleRequests = providerRequests.length;
                            time += periodMs * 10;
                            await new Promise<void>(resolve => setImmediate(resolve));
                            expect(providerRequests).toHaveLength(idleRequests);
                            expect(sleep).toHaveBeenCalledOnce();
                        } else await running;
                    } finally { controller.abort(); await running; }
                }
                await cycle(true);
                expect(receipt.state).toBe('failed');
                expect(providerRequests.filter(request => request.method === 'GET')).toHaveLength(2);
                expect(transitions).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'failed' })]));
                expect(admissions).toHaveLength(1);
                const noticeRows = async () => {
                    const rows = (await app.inject({ method: 'GET', url: '/v1/artifacts' })).json<Array<{ id: string; header: string }>>();
                    return rows.flatMap(item => { const header = decodePlainArtifactStoredContent(item.header);
                        return header && typeof header === 'object' && 'healthPhase' in header ? [{ id: item.id, header }] : []; });
                };
                const failure = await noticeRows();
                expect(failure).toHaveLength(1);
                expect(failure[0]!.header).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false });
                watchedState = 'queued';
                const recoveryCandidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    requestKey: 'reviewed-preview-recovery', sourceIntent, sourceMethod: 'gitIntegration', context });
                if (!recoveryCandidate.ok) throw new Error(recoveryCandidate.errorCode);
                expect(await executor.execute('deployments.deploy', recoveryCandidate.input, context)).toMatchObject({ ok: true,
                    result: { state: 'queued', deploymentId: receipt.id } });
                time += periodMs;
                watchedState = 'succeeded';
                await cycle(false);
                expect(receipt.state).toBe('succeeded');
                expect(transitions).toEqual(['queued', 'failed', 'queued', 'succeeded'].map(state => expect.objectContaining({ state })));
                expect(admissions).toHaveLength(2);
                expect(await noticeRows()).toEqual([{ id: failure[0]!.id,
                    header: expect.objectContaining({ type: 'update', healthPhase: 'recovered', resolved: false }) }]);
            } finally { await daemon.dispose(); }
        }
        if (scenario === 'settled-preview' || scenario === 'settled-worker') {
            const targetKind = row.targetLink.targetKind;
            row.targetLink.targetKind = 'cloudflare-pages';
            const mismatched = await executor.execute('deployments.receipts.observe', {
                serverId, environmentId: environment.environment.id, deploymentId: receipt.id,
            }, context);
            expect(mismatched).toMatchObject({ ok: false, errorCode: 'deployment_target_role_unavailable' });
            expect(providerRequests.filter(request => request.method === 'GET')).toHaveLength(0);
            row.targetLink.targetKind = targetKind;
            observingReceipt = true;
            const observed = await executor.execute('deployments.receipts.observe', {
                serverId, environmentId: environment.environment.id, deploymentId: receipt.id,
            }, context);
            expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true, result: { state: 'succeeded', deploymentId: receipt.id } });
            expect(receipt.state).toBe('succeeded');
            expect(providerRequests.filter(request => request.method === 'POST')).toHaveLength(1);
            expect(providerRequests.at(-1)?.path).toBe(worker
                ? `/client/v4/accounts/${providerAccountId}/workers/scripts/app/subdomain`
                : `/client/v4/accounts/${providerAccountId}/workers/workers/app/previews/${previewId}/deployments/latest`);
        }
    } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
});
