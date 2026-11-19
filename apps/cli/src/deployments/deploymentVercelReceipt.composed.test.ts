import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { PLUGIN_MANIFEST as githubManifest } from '../../../../packages/plugins/scm-github/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { stagePluginDaemonRuntime } from '@/plugins/authoring/bundleDaemonRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { reloadConfiguration } from '@/configuration';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { REQUESTER_ACCOUNT_MCP_AGENT_PLUGIN, startRequesterAccountMcpSession } from '@/agent/runtime/session/loop/requesterAccountMcpSession.testkit';
import { resolve } from 'node:path';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { encodeBase64, DeploymentTransitionInputV1Schema } from '@happier-dev/protocol';
import { DeploymentPlatformContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader, listRuntimeContributedActionDefinitions }
    from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import * as installationStore from '@/daemon/identity/store';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';

import * as vercel from '../../../../packages/plugins/deploy-vercel/src/index';
import { PLUGIN_MANIFEST as vercelAccountManifest } from '../../../../packages/plugins/machine-vercel/src/manifest';

// Only Home persistence and provider HTTP are replaced. The actual Vercel
// Account artifact, role admission, reviewed child and transition writer stay real.
vi.mock('undici', async importOriginal => ({
    ...await importOriginal<typeof import('undici')>(),
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
vi.mock('socket.io-client', async importOriginal => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    return { ...actual, io: () => createApiSessionSocketStub() };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// QA cli75: a rev2 running receipt must converge after finite provider observation.
it.each([
    { scenario: 'READY', title: 'settles the retained Vercel receipt from READY' },
    { scenario: 'ERROR', title: 'settles the retained Vercel receipt from ERROR' },
    { scenario: 'concurrent observer', title: 'returns the settled Vercel receipt when another observer activates it during the provider read' },
    { scenario: 'exact SHA', title: 'prepares an exact-SHA Vercel deploy without Compose' },
    { scenario: 'Session GitHub HEAD', title: 'prepares Vercel from native GitHub HEAD through its retained Session MCP' },
] as const)('$title through its real runtime', async ({ scenario }) => {
    const sessionHead = scenario === 'Session GitHub HEAD';
    const readyState = scenario === 'exact SHA' || sessionHead || scenario === 'concurrent observer' ? 'READY' : scenario;
    const accountId = 'owner', origin = 'https://platform-home.test', serverId = 'srv_vercel_receipt_home';
    const providerAccountId = 'team_reviewed', projectId = 'prj_reviewed', sha = 'f'.repeat(40);
    const app = fastify();
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId });
    // The containing runtime admits the portable Home from its authenticated
    // features, just as SessionClient.getServerIdentityId does in production.
    const serverIdentityId = readServerIdentityIdFromFeaturesSnapshot({ status: 'ready', provenance: 'authenticated', features: homeFeatures });
    if (!serverIdentityId) throw new Error('Expected the admitted Vercel fixture Home');
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest: vercel.manifest,
        projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/deploy-vercel'),
        entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/deploy-vercel/src/accountRuntime.ts'),
        manifestExport: null,
    }, ...(sessionHead ? { additional: [{ manifest: githubManifest,
        projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/scm-github'),
        entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/scm-github/src/accountRuntime.ts'),
        artifactId: 'github-account-runtime', activateExport: 'activate', manifestExport: null }] } : {}) });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 7,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(83));
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'installation-a', createdAt: 1, publicKey: encodeBase64(installation.publicKey, 'base64url'),
        privateKey: encodeBase64(installation.secretKey, 'base64url') });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.serverId = serverIdentityId;
    environment.environment.owner = { kind: 'account', accountId };
    delete environment.environment.buildMachineId;
    environment.content.definition = { kind: 'repository', ref: 'main', ...(scenario === 'exact SHA' || sessionHead ? {} : { compose: { path: 'compose.yaml', profiles: [], services: [] } }) };
    const sourceIntent = { kind: 'repository' as const, projectSourceId: environment.environment.projectSourceId,
        sourceRevision: 1, sha, compose: environment.content.definition.compose };
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' };
    const row = environment.targetLinks[0]!;
    row.targetLink.source = { kind: 'plugin', contribution: { pluginId: vercel.manifest.id, localId: 'runtime' } };
    row.targetLink.targetKind = 'vercel';
    row.targetLink.createdByAccountId = accountId;
    row.targetLink.machines = []; row.targetLink.members = [];
    const descriptor = vercelAccountManifest.contributes.connectedAccountDescriptors?.[0];
    if (!descriptor) throw new Error('Vercel Account declaration required');
    const service = { pluginId: vercelAccountManifest.id, localId: descriptor.id };
    const credentialRef = { service, accountId: 'connected-original' };
    row.content = { credentialPrincipal: { kind: 'account', accountId,
        purpose: { consumer: { pluginId: vercel.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account: credentialRef } },
        providerIdentity: { providerAccountId, providerResourceId: projectId, providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, repositoryAccess: { status: 'ready', repository },
        preparedNative: { projectName: 'app', gitSource: { type: 'github', repoId: '123' } } };
    const seed = (id: string, kind: string, content: unknown) => authored.artifacts.seed(id,
        encodePlainArtifactStoredContent({ kind, title: 'Preview' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
    seed(environment.environment.contentArtifactId, 'deployment-environment.v1', environment.content);
    seed(row.targetLink.contentArtifactId, 'deployment-target-link.v1', row.content);
    const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: credentialRef, status: 'connected',
        authenticationModeId: descriptor.authentication.defaultModeId, revisionSemantics: 'revisioned', credentialRevision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
        displayName: 'Original Vercel', scopes: [] });
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
    let settleConcurrentObservation: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.origin === origin) {
            const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST',
                url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init?.headers)),
                ...(init?.body ? { payload: await new Response(init.body).text() } : {}) });
            return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
        }
        if (sessionHead && parsed.origin === 'https://api.github.com') {
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-native-github-secret');
            return Response.json(parsed.pathname.endsWith('/commits/main') ? { sha }
                : { full_name: repository.repository, default_branch: 'main' });
        }
        expect(parsed.origin).toBe('https://api.vercel.com');
        expect(new Headers(init?.headers).get('authorization') === 'Bearer preview-fixture-secret').toBe(true);
        providerRequests.push({ method: init?.method ?? 'GET', path: parsed.pathname, body: null });
        settleConcurrentObservation?.();
        return Response.json({ id: 'dpl_reviewed', projectId, readyState,
            ...(readyState === 'ERROR' ? { errorCode: 'NOW_SANDBOX_WORKER_ROOTDIR_NOT_EXIST',
                errorMessage: 'provider-private-output-must-not-escape' } : {}) });
    });
    let receipt = createDeploymentReceiptHeaderV1({ id: 'preview-receipt', environmentId: environment.environment.id,
        targetLinkId: row.targetLink.id, requestKey: 'reviewed-preview', actionOperationId: 'preview-operation',
        state: 'running', revision: 2, requestedAtMs: 0, startedAtMs: 1, settledAtMs: undefined,
        acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' } } });
    const transitions: unknown[] = [];
    app.get('/v1/projects/sources/:sourceId', async () => ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true,
        source: { id: sourceIntent.projectSourceId, revision: 1, name: 'App', owner: { kind: 'account', accountId },
            audience: [], createdByAccountId: accountId, repository: { protocol: 'https',
                provider: { id: sessionHead ? `${githubManifest.id}/github` : 'github', kind: 'github', displayName: 'GitHub', baseUrl: repository.deployment },
                repository: { nameWithOwner: repository.repository, cloneUrl: 'https://github.com/example/app.git' } } } }));
    app.get('/v1/deployments/environments/:environmentId', async () => ({ ok: true,
        environment: environment.environment, secretScope: environment.secretScope, targetLinks: [row.targetLink] }));
    app.get('/v1/deployments/receipts/:deploymentId', async () => ({ ok: true, deployment: receipt }));
    app.get('/v1/deployments/environments/:environmentId/deployments', async request => ({ ok: true,
        items: (request.query as { inProgressOnly?: string }).inProgressOnly === 'true'
            && (receipt.state === 'failed' || receipt.state === 'succeeded') ? [] : [receipt], nextCursor: null }));
    app.post('/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions', async request => {
        const body = DeploymentTransitionInputV1Schema.parse(request.body);
        transitions.push(body);
        // Home already accepts an identical settled state before checking the
        // old receipt/TargetLink revisions (transitionDeploymentInTx).
        if (receipt.state === body.state && receipt.state === 'succeeded') return {
            ok: true, environmentId: receipt.environmentId, revision: 1,
            deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state,
        };
        const stored = authored.artifacts.read(body.contentArtifactId);
        if (!stored || !body.contentUpdate) throw new Error('Expected the admitted receipt update');
        authored.artifacts.seed(body.contentArtifactId, body.contentUpdate.header ?? stored.header, body.contentUpdate.body ?? stored.body);
        receipt = { ...receipt, state: body.state, revision: receipt.revision + 1,
            ...((body.state === 'failed' || body.state === 'succeeded') ? { settledAtMs: 2 } : {}) };
        return { ok: true, environmentId: receipt.environmentId, revision: 1,
            deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state };
    });
    if (sessionHead) {
        app.get('/v1/account/entity-rows/connected-accounts/purposes', async () => ({ status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } }));
    }
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const mounted = await createAuthoredAdmittedPluginRuntimeFixture({
        runtimeOptions: { connectedAccounts: purposeOwner, actionFormConnectedAccounts: purposeOwner,
            accountExecution: { credentials, serverUrl: origin, serverId, serverIdentityId, machineId: 'machine-a', isCurrent: async () => true },
            resolveCurrentMachineId: () => 'machine-a' },
        plugins: [{ manifest: vercel.manifest, files: { [vercel.manifest.entrypoints!.daemon!]: 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: vercel.activate }) },
            ...(sessionHead ? [{ manifest: githubManifest, files: { [githubManifest.entrypoints!.daemon!]: 'export function activate() {}' } }] : [])],
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    let sourceSession: Awaited<ReturnType<typeof startRequesterAccountMcpSession>> | undefined;
    let githubRuntime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    let githubHome: string | undefined;
    const sessionEnv = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    try {
        if (sessionHead) {
            githubHome = await mkdtemp(resolve(tmpdir(), 'vercel-session-github-'));
            sessionEnv.patch({ HAPPIER_HOME_DIR: githubHome });
            reloadConfiguration();
            const declaration = normalizePluginManifestV2(githubManifest);
            const stagedRoot = resolve(githubHome, 'github-daemon');
            await mkdir(stagedRoot);
            const staged = await stagePluginDaemonRuntime({
                sourceRootPath: resolve(import.meta.dirname, '../../../../packages/plugins/scm-github'),
                sourceEntryPath: resolve(import.meta.dirname, '../../../../packages/plugins/scm-github/src/index.ts'),
                stagedRootPath: stagedRoot, daemonEntrypoint: declaration.entrypoints!.daemon!,
            });
            const files: Record<string, string | Uint8Array> = Object.fromEntries(declaration.contributes.resources.flatMap(resource =>
                'path' in resource && typeof resource.path === 'string' ? [[resource.path, '{}']] : []));
            for (const path of staged.outputRelativePaths) files[path] = await readFile(resolve(stagedRoot, path));
            files['package.json'] = JSON.stringify({ type: 'module' });
            const executableDirectory = resolve(githubHome, 'bin');
            await writeExecutableShim({ dir: executableDirectory, fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
                contents: process.platform === 'win32' ? '@echo off\r\necho session-native-github-secret\r\n'
                    : '#!/bin/sh\nprintf \'%s\\n\' \'session-native-github-secret\'\n' });
            sessionEnv.patch({ PATH: `${executableDirectory}${delimiter}${process.env.PATH ?? ''}` });
            githubRuntime = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: githubHome,
                controller: pluginReloadController, plugins: [{ manifest: declaration, files }, REQUESTER_ACCOUNT_MCP_AGENT_PLUGIN], coldStart: true });
            await runWithServerHttpBaseUrl(origin, () => ensureCliActionPolicySettings(credentials, origin));
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected Vercel Session requester policy');
            sourceSession = await startRequesterAccountMcpSession({ credentials, snapshot, serverId,
                serverHttpBaseUrl: origin, accountId, machineId: 'machine-a', installationId: 'installation-a',
                sessionId: 'vercel-github-head-session', happyHomeDir: githubHome, pluginRuntimeRegistryLease: githubRuntime.lease });
        }
        const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => serverIdentityId,
            resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: accountId }) });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId, serverHttpBaseUrl: origin, machineId: 'machine-a',
            resolveRequesterIdentity: async context => {
                const requester = await identityOwner.resolveActionRequester!(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            },
            ...(sourceSession ? { executeSourceReadAction: sourceSession.executeSourceReadAction } : {}),
            runtime: { async acquire() { throw new Error('Provider Git deployment must not acquire native runtime'); } },
            acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry }) });
        const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId,
            actionCaller: { kind: 'host' }, serverId, serverIdentityId,
            machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: 'machine-a',
                installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
            actionsSettings: normalizeActionsSettingsV1(undefined), presentUserConfirmation: { actionId: 'deployments.deploy' },
            operationAcceptance: { operationId: 'preview-operation', accept() {} } };
        if (scenario === 'exact SHA' || sessionHead) {
            const prepared = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: {
                serverId, environmentId: environment.environment.id, targetLinkId: row.targetLink.id,
                requestKey: 'replay147-vercel-exact-deploy', ...(sessionHead ? {} : { sha: '9275dfbb315739d0ccb463075ab8d2b4966b08fc' }) }, context });
            expect(prepared, JSON.stringify(prepared)).toMatchObject({ input: { serverId,
                environmentId: environment.environment.id, targetLinkId: row.targetLink.id },
                preview: { sourceMethod: 'gitIntegration', sourceIntent: {
                    kind: 'repository', sha: sessionHead ? sha : '9275dfbb315739d0ccb463075ab8d2b4966b08fc' } } });
            if ('preview' in prepared) expect(prepared.preview).not.toHaveProperty('sourceIntent.compose');
            expect(providerRequests).toEqual([]);
            return;
        }
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
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
            listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
            invokeContributedAction: invoke });
        receipt.contentArtifactId = candidate.input.contentArtifactId;
        seed(receipt.contentArtifactId, 'deployment-receipt.v1', { ...candidate.content,
            platform: { ...candidate.content.platform, observation: { v: 1, state: 'running',
                providerDeploymentId: 'dpl_reviewed', observedAtMs: 1 } } });
        if (scenario === 'concurrent observer') settleConcurrentObservation = () => {
            // The provider response overlaps the Home boundary's other observer,
            // which has committed this receipt and advanced its serving Link.
            receipt = { ...receipt, state: 'succeeded', revision: 3, settledAtMs: 2 };
            row.targetLink = { ...row.targetLink, revision: row.targetLink.revision + 1,
                activeDeploymentId: receipt.id, state: 'deployed' };
            seed(receipt.contentArtifactId, 'deployment-receipt.v1', { ...candidate.content,
                platform: { ...candidate.content.platform, observation: { v: 1, state: 'succeeded',
                    providerDeploymentId: 'dpl_reviewed', observedAtMs: 2 } } });
        };
        const input = { serverId, environmentId: environment.environment.id, deploymentId: receipt.id };
        const observed = await executor.execute('deployments.receipts.observe', input, context);
        const state = readyState === 'READY' ? 'succeeded' : 'failed';
        expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true, result: {
            state, deploymentId: receipt.id, deploymentRevision: 3 } });
        expect(receipt).toMatchObject({ state, revision: 3 });
        expect(transitions).toHaveLength(1);
        if (scenario === 'concurrent observer') {
            expect(transitions[0]).toMatchObject({ expectedTargetLinkRevision: candidate.content.platform.targetLinkRevision });
        }
        expect(providerRequests).toEqual([{ method: 'GET', path: '/v13/deployments/dpl_reviewed', body: null }]);
        const stored = authored.artifacts.read(receipt.contentArtifactId);
        if (!stored) throw new Error('Expected retained receipt Artifact');
        const decoded = decodePlainArtifactStoredContent(stored.body);
        if (!decoded || typeof decoded !== 'object' || !('body' in decoded) || typeof decoded.body !== 'string')
            throw new Error('Expected persisted receipt content');
        expect(DeploymentPlatformContentV1Schema.parse(JSON.parse(decoded.body)).platform.observation)
            .toMatchObject({ state, providerDeploymentId: 'dpl_reviewed' });
        expect(JSON.stringify({ observed, stored })).not.toContain('provider-private-output-must-not-escape');
        expect(JSON.stringify({ observed, stored })).not.toContain('preview-fixture-secret');
        expect(await executor.execute('deployments.receipts.observe', input, context))
            .toMatchObject({ ok: true, result: { state, deploymentRevision: 3 } });
        expect(transitions).toHaveLength(1);
        expect(providerRequests).toHaveLength(1);
    } finally {
        try { await sourceSession?.stop(); await githubRuntime?.dispose(); await mounted.dispose(); }
        finally {
            sessionEnv.restore(); reloadConfiguration(); resetActiveAccountSettingsSnapshotForTests();
            restoreHttp(); await app.close();
            if (githubHome) await rm(githubHome, { recursive: true, force: true });
        }
    }
}, 60_000);
