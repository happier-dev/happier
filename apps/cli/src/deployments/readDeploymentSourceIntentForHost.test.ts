import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { admitProjectSourceSelectionV1, ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1,
    type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { readDeploymentSourceIntentForHost } from './readDeploymentSourceIntentForHost';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { projectDeploymentException, projectDeploymentFailure } from './deploymentFailure';
import { readDeploymentRefusalRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { normalizeActionExecuteResult, projectCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDeploymentSourceMaterializationPort } from './targets/ownServer/exactCommitRelease';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withTempDir } from '@/testkit/fs/tempDir';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

afterEach(() => { withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); });

it.each(['dirty', 'unpushed', 'raw-commit-ref', 'published', 'published-with-newer-remote-head'] as const)('admits the exact reviewed Git-only deployment source when it is %s', async state => {
    await withTempDir('deployment-published-source-', async checkout => {
        const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
        git(['init', '--quiet', '--initial-branch=main']);
        git(['config', 'user.name', 'Source Fixture']);
        git(['config', 'user.email', 'source@example.test']);
        await writeFile(join(checkout, 'index.html'), 'reviewed');
        git(['add', '.']);
        git(['commit', '--quiet', '-m', 'Reviewed source']);
        const first = git(['rev-parse', 'HEAD']);
        await writeFile(join(checkout, 'index.html'), 'next revision');
        git(['commit', '--quiet', '-am', 'Next source']);
        const second = git(['rev-parse', 'HEAD']);
        const sha = state === 'published-with-newer-remote-head' ? first : second;
        if (state === 'dirty') await writeFile(join(checkout, 'index.html'), 'unsaved in Git');
        const environment = createDeploymentEnvironmentDetailV1();
        environment.content.definition = { kind: 'repository', ref: state === 'raw-commit-ref' ? sha : 'main' };
        const sourceId = environment.environment.projectSourceId;
        mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'home',
            machineId: 'controller', rootPath: checkout, createdAtMs: 1, source: { sourceId, revision: 1 } })]);
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({
            ok: true, canManage: true, source: { id: sourceId, revision: 1, name: 'App', audience: [],
                createdByAccountId: 'owner', repository: { protocol: 'https', provider: { id: 'github', kind: 'github',
                    displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: {
                    nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } },
        }) });
        const resolveRepositoryRef = vi.fn(async (_repository: unknown, ref: string) => {
            if (ref === `refs/heads/${sha}`) throw Object.assign(new Error('Branch not found'), { code: 'github_not_found' });
            return ref === 'refs/heads/main' ? state === 'unpushed' ? first : second : sha;
        });
        const source = readDeploymentSourceIntentForHost({ request: { environment, sha, context: {}, publishedGitProviders: ['github'] },
            host: { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
                machineId: 'controller', async assertAuthority() {}, resolveRepositoryRef, async resolveRequesterIdentity() {
                    return { kind: 'owner_person' as const, requester: { serverId: 'home', accountId: 'owner',
                        machineId: 'controller', installationId: 'installation' } };
                } } });
        if (state === 'published' || state === 'published-with-newer-remote-head') {
            await expect(source).resolves.toMatchObject({ sourceIntent: { kind: 'repository', sha } });
        }
        else await expect(source).rejects.toMatchObject({ code: state === 'dirty' ? 'deployment_source_dirty' : 'deployment_source_unpushed' });
        expect(resolveRepositoryRef).toHaveBeenCalledTimes(state === 'dirty' ? 0 : 1);
        if (state !== 'dirty') expect(resolveRepositoryRef).toHaveBeenCalledWith(expect.any(Object),
            state === 'raw-commit-ref' ? `refs/heads/${sha}` : 'refs/heads/main', {});
    });
});

it.each(['remote preview', 'local-only'] as const)('pins and acquires the selected %s branch without moving the checkout', async kind => {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    onTestFinished(() => runtime.dispose());
    await withTempDir('deployment-remote-preview-', async directory => {
        const remote = join(directory, 'remote');
        const checkout = join(directory, 'checkout');
        const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        await mkdir(remote);
        git(remote, ['init', '--quiet', '--initial-branch=main']);
        git(remote, ['config', 'user.name', 'Source Fixture']);
        git(remote, ['config', 'user.email', 'source@example.test']);
        await writeFile(join(remote, 'index.html'), 'main');
        git(remote, ['add', '.']); git(remote, ['commit', '--quiet', '-m', 'Main source']);
        git(directory, ['clone', '--quiet', '--single-branch', '--branch', 'main', remote, checkout]);
        git(remote, ['switch', '--quiet', '-c', 'fixture-specimens-1112-20261112-review-native']);
        await writeFile(join(remote, 'index.html'), 'reviewed preview');
        git(remote, ['add', '.']); git(remote, ['commit', '--quiet', '-m', 'Preview source']);
        const sha = git(remote, ['rev-parse', 'HEAD']);
        if (kind === 'local-only') git(checkout, ['branch', 'fixture-specimens-1112-20261112-review-native']);
        const expectedSha = kind === 'local-only' ? git(checkout, ['rev-parse', 'HEAD']) : sha;
        const cloneUrl = 'https://github.com/happier-dev/triage-qa-sandbox.git';
        git(checkout, ['remote', 'set-url', 'origin', cloneUrl]);
        // The Git transport is a real local fixture; no network or hosting credentials are used.
        git(checkout, ['config', `url.${pathToFileURL(remote).href}.insteadOf`, cloneUrl]);
        const environment = createDeploymentEnvironmentDetailV1();
        environment.content.definition = { kind: 'repository', ref: 'fixture-specimens-1112-20261112-review-native' };
        const sourceId = environment.environment.projectSourceId;
        mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'home',
            machineId: 'controller', rootPath: checkout, createdAtMs: 1, source: { sourceId, revision: 1 } })]);
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({ ok: true,
            canManage: true, source: { id: sourceId, revision: 1, name: 'App', audience: [], createdByAccountId: 'owner',
                repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'happier-dev/triage-qa-sandbox', cloneUrl } } } }) });
        const selected = await readDeploymentSourceIntentForHost({ request: { environment, context: {}, requireWorkspace: true },
            host: { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
                machineId: 'controller', async assertAuthority() {}, async resolveRequesterIdentity() {
                    return { kind: 'owner_person' as const, requester: { serverId: 'home', accountId: 'owner',
                        machineId: 'controller', installationId: 'installation' } };
                },
                async resolveRepositoryRef(_repository, ref) {
                    if (kind === 'local-only') throw new Error('Local refs must not acquire hosting credentials');
                    expect(ref).toBe('fixture-specimens-1112-20261112-review-native');
                    return sha;
                } } });
        expect(selected.sourceIntent).toMatchObject({ kind: 'repository', sha: expectedSha });
        expect(git(checkout, ['show', `${expectedSha}:index.html`])).toBe(kind === 'local-only' ? 'main' : 'reviewed preview');
        expect(git(checkout, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
        expect(git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/happier/source-fetch'])).toBe('');
    });
});

it('retains the Home Source purpose refusal and recovery through the deployment and public CLI result', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
    if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
    // HTTP and the Machine signature are genuine boundaries; Source admission and failure projection stay real.
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'private-root-proof', binding: {
        accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
        machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
        actionId: 'deployments.deploy', requestId: 'upload-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'controller' }, environmentId: environment.environment.id,
    } }), requesterHttpProjection: { accountId: 'owner', serverId: 'home', serverIdentityId: 'home',
        serverHttpBaseUrl: 'https://home.test', accountEncryptionMode: 'plain', isCurrent: async () => true,
        createRequestHeaders: async () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'private-root-proof' }),
    } } satisfies ExternalActionExecutionAuthorizationV1;
    const sourceRead = vi.spyOn(axios, 'request').mockResolvedValue({ status: 401,
        data: { error: 'invalid_token', authorizationRefusal: 'deployment_child_http' } });
    let refusal: unknown;
    try {
        await readDeploymentSourceIntentForHost({ request: { environment, sourceIntent, requireWorkspace: false,
            context: { externalActionExecutionAuthorization: authorization } }, host: {
            credentials: { token: 'unused-host-token', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'controller', async assertAuthority() {}, async resolveRequesterIdentity() {
                throw new Error('Provider source reads do not acquire a host workspace');
            },
        } });
    } catch (error) { refusal = error; }
    expect(sourceRead).toHaveBeenCalledOnce();
    const normalized = normalizeActionExecuteResult(projectDeploymentFailure('action_forbidden', refusal));
    if (normalized.ok) throw new Error('A refused Source read cannot become success');
    const result = projectCliActionFailure(normalized);
    expect(result).toMatchObject({ code: 'action_forbidden', details: {
        requiredFact: 'deployment_child_http', remedy: expect.any(String),
    }, failureCause: { phase: 'home.authorization.deployment_child_http', httpStatus: 401 } });
    expect(JSON.stringify(result)).not.toMatch(/private-root-proof|unused-host-token/u);
});

it('reads restore workspace rows under the signed public root while reading the Source under its own effect', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
    if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
    const native = projectDeploymentNativeAdmissionV1('deployments.backups.restore', { serverId: 'home',
        environmentId: environment.environment.id, machineId: 'controller', installationId: 'installation',
        targetLinkId: 'target', deploymentId: 'capture-receipt', source: { kind: 'repository', snapshotId: 'backup' },
        expectedRevision: 1, mode: 'prepare' });
    const effects: string[] = [];
    // Signing and HTTP are genuine boundaries; retain real Source/Account row admission beneath them.
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-restore', binding: {
        accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
        machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
        actionId: 'deployments.backups.restore', requestId: 'restore-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'controller' }, environmentId: environment.environment.id, deploymentNativeAdmission: native,
    } }), requesterAccountProjection: { accountId: 'owner', serverId: 'home', accountEncryptionMode: 'plain',
        projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain' }), isCurrent: async () => true, readArtifact: async () => null },
        requesterHttpProjection: { accountId: 'owner', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
            accountEncryptionMode: 'plain', isCurrent: async () => true, async createRequestHeaders(request) {
                effects.push(request.effectActionId);
                const admitted = request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                    ? request.effectActionId === 'deployments.backups.restore' : request.effectActionId === 'projects.sources.read';
                return admitted ? { 'x-requester-proof': 'restore' } : null;
            } },
    } satisfies ExternalActionExecutionAuthorizationV1;
    mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'home',
        machineId: 'controller', rootPath: '/restore-source', createdAtMs: 1,
        source: { sourceId: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision } })]);
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({ ok: true,
        canManage: true, source: { id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App', audience: [],
            createdByAccountId: 'owner', repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub',
                baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } }) });
    const context = { authority: 'present_user' as const, externalActionExecutionAuthorization: authorization,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller',
            installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => true };
    const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
    const selected = await readDeploymentSourceIntentForHost({ request: { environment, sourceIntent, actionId: 'deployments.rollback', context },
        host: { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'controller', async assertAuthority() {}, async resolveRequesterIdentity(current) {
                const requester = await identityOwner.resolveActionRequester!(current);
                try { return requester.identity; } finally { await requester.dispose(); }
            } } });
    expect(selected.workspace?.rootPath).toBe('/restore-source');
    expect(effects).toEqual(['projects.sources.read', 'deployments.backups.restore']);
});

it('uses the stored Compose definition for a Use redeploy without acquiring the member workspace', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const document = 'services:\n  app:\n    image: nginx:1\n';
    environment.content.definition = { kind: 'stored', contentRevision: 1,
        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
        document, profiles: [], services: [], primaryService: 'app' };
    const workspaceReads = mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({
        id: 'member-workspace', serverId: 'home', machineId: 'controller', rootPath: '/member/chosen-checkout',
        createdAtMs: 1, source: { sourceId: environment.environment.projectSourceId, revision: 1 },
    })]);
    const sourceReads = vi.spyOn(axios, 'request');
    const context = { authority: 'present_user' as const,
        machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'controller',
            installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => true };
    const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
    const selected = await readDeploymentSourceIntentForHost({ request: { environment, context }, host: {
        credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        machineId: 'controller', async assertAuthority() {}, async resolveRequesterIdentity(current) {
            const requester = await identityOwner.resolveActionRequester!(current);
            try { return requester.identity; } finally { await requester.dispose(); }
        },
    } });
    expect(selected.sourceIntent).toEqual(environment.content.definition);
    expect(selected.workspace).toBeUndefined();
    await expect(selected.assertSourceCurrent()).resolves.toBeUndefined();
    expect(workspaceReads).not.toHaveBeenCalled();
    expect(sourceReads).not.toHaveBeenCalled();
});

it.each([
    { actorAccountId: 'owner', session: false, enabled: true, direct: true },
    { actorAccountId: 'owner', session: true, enabled: false, direct: true },
    { actorAccountId: 'owner', session: true, enabled: true, direct: false },
    { actorAccountId: 'use-grantee', session: false, enabled: false, direct: false },
])('acquires requester workspace only for admitted direct placement ($actorAccountId, session=$session, isolation=$enabled)', async ({ actorAccountId, session, enabled, direct }) => {
    await withTempDir('deployment-source-requester-', async directory => {
        const repository = join(directory, 'repository');
        await mkdir(repository);
        const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        git(['init', '--quiet']); git(['config', 'user.name', 'Source Fixture']); git(['config', 'user.email', 'source@example.test']);
        await writeFile(join(repository, 'compose.yaml'), 'services: {}');
        git(['add', '.']); git(['commit', '--quiet', '-m', 'Pinned source']);
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
        const sourceIntent = { ...receipt.content.sourceIntent, sha: git(['rev-parse', 'HEAD']) };
        const rows = mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'workspace', serverId: 'home',
            machineId: 'controller', rootPath: repository, createdAtMs: 1, source: {
                sourceId: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision } })]);
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({ ok: true,
            canManage: true, source: { id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App',
                audience: [], createdByAccountId: 'owner', repository: { protocol: 'https', provider: {
                    id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: {
                    nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } }) });
        const context = { authority: 'present_user' as const, signal: new AbortController().signal,
            ...(session ? { actionCaller: { kind: 'session' as const, sessionId: 'build-session', starterDepth: 0, turnDepth: 0 } } : {}),
            machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'controller',
                installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true };
        // The existing identity owner consumes held physical receiver facts and admitted ingress.
        const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            readAgentIsolation: () => ({ enabled, workspaceRoots: [], status: enabled
                ? { kind: 'unavailable', code: 'provisioning_unavailable' } : { kind: 'disabled' } }),
            resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
        const host = { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'controller', async assertAuthority() { context.signal.throwIfAborted(); },
            async resolveRequesterIdentity(current: import('@happier-dev/protocol').ActionExecutorContext) {
                const requester = await identityOwner.resolveActionRequester!(current);
                try { return { ...requester.identity, canExecuteWorkspaceOnDaemon: requester.canExecuteWorkspaceOnDaemon }; }
                finally { await requester.dispose(); }
            } };
        const phases: string[] = [];
        const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(),
            onProgress: phase => { phases.push(phase); }, async admit() {
                const selected = await readDeploymentSourceIntentForHost({ host, request: { environment, sourceIntent, context } });
                return { environmentId: environment.environment.id, deploymentId: receipt.deployment.id,
                    environmentInstanceId: 'fixture-instance', machineId: 'controller', installationId: 'installation',
                    deploymentRoot: join(directory, 'deployments'), artifactDirectory: join(directory, 'artifacts'),
                    sourcePath: selected.workspace!.rootPath, commitSha: sourceIntent.sha, assertCurrent: host.assertAuthority };
            } });
        const operation = port.materialize({ environmentId: environment.environment.id, deploymentId: receipt.deployment.id });
        if (direct) {
            const source = await operation;
            expect(await readFile(join(source.rootPath, 'compose.yaml'), 'utf8')).toBe('services: {}');
            expect(phases).toEqual(['export', 'materialize']);
            await source.abort();
        } else {
            await expect(operation).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
            expect(rows).not.toHaveBeenCalled();
            expect(phases).toEqual([]);
        }
    });
});

it.each([true, false])('captures an admitted exact provider Git commit without a local workspace (Compose: %s) and retains Source currentness', async hasCompose => {
    const environment = createDeploymentEnvironmentDetailV1();
    const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
    if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
    if (!hasCompose) {
        if (environment.content.definition.kind !== 'repository') throw new Error('Repository fixture required');
        delete environment.content.definition.compose;
        delete sourceIntent.compose;
    }
    const source = ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true, source: {
        id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App', audience: [],
        createdByAccountId: 'owner', repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub',
            baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } },
    } });
    const workspaceReads = mockProjectAccountRowsHttpBoundary([]);
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: source });
    let current = true;
    const host = { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        machineId: 'controller', async resolveRequesterIdentity() { return { kind: 'unknown' as const, reason: 'requester_authority_unavailable' as const }; },
        async assertAuthority() {
            if (!current) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
        }, async resolveRepositoryRef() { throw new Error('Explicit SHA must not acquire SCM credentials'); } };
    const captured = await readDeploymentSourceIntentForHost({ host,
        request: { environment, sourceIntent, context: {}, requireWorkspace: false } });
    expect(captured.sourceIntent).toEqual(sourceIntent);
    expect(captured.workspace).toBeUndefined();
    const bySha = await readDeploymentSourceIntentForHost({ host,
        request: { environment, sha: sourceIntent.sha, context: {}, requireWorkspace: false } });
    expect(bySha.sourceIntent).toEqual(sourceIntent);
    expect(bySha.workspace).toBeUndefined();
    expect(workspaceReads).not.toHaveBeenCalled();
    await expect(captured.assertSourceCurrent()).resolves.toBeUndefined();
    if (!source.ok) throw new Error('Source fixture required');
    source.source.revision++;
    await expect(captured.assertSourceCurrent()).rejects.toMatchObject({ code: 'deployment_conflict' });
    source.source.revision--;
    source.source.id = 'substituted-source';
    await expect(captured.assertSourceCurrent()).rejects.toMatchObject({ code: 'target_mismatch' });
    source.source.id = sourceIntent.projectSourceId;
    current = false;
    await expect(captured.assertSourceCurrent()).rejects.toMatchObject({ code: 'action_forbidden' });
});

it.each(['no checkout row', 'removed checkout', 'non-Git checkout'] as const)('offers to check out a repository for Upload with %s', async observation => {
    const environment = createDeploymentEnvironmentDetailV1();
    environment.content.definition = { kind: 'repository', ref: 'release' };
    const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
    if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
    const directory = await mkdtemp(join(tmpdir(), 'deployment-checkout-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    onTestFinished(() => runtime.dispose());
    mockProjectAccountRowsHttpBoundary(observation !== 'no checkout row' ? [createPlainProjectAccountRefRow({
        id: 'checkout', serverId: 'home', machineId: 'controller',
        rootPath: observation === 'removed checkout' ? join(directory, 'removed') : directory,
        createdAtMs: 1, source: { sourceId: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision },
    })] : []);
    const source = ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true, source: {
        id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App', audience: [], createdByAccountId: 'owner',
        defaultRef: 'main', subdir: 'workers/site',
        repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } },
    } });
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: source });
    const context = { authority: 'present_user' as const, signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller',
            installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => true };
    const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
    const host = { credentials: { token: 'fixture', encryption: null }, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'controller', async assertAuthority() {},
        async resolveRequesterIdentity(current: import('@happier-dev/protocol').ActionExecutorContext) {
            const requester = await identityOwner.resolveActionRequester!(current);
            try { return requester.identity; } finally { await requester.dispose(); }
        } };
    // The checkout can be absent even when the Account retains a row for it.
    const missingCheckout = await readDeploymentSourceIntentForHost({ host, request: { environment, context, requireWorkspace: true } })
        .then(() => { throw new Error('A missing checkout cannot select a source'); }, (error: unknown) => error);
    const failure = normalizeActionExecuteResult(projectDeploymentException(missingCheckout));
    if (failure.ok) throw new Error('A missing checkout cannot become success');
    const publicFailure = projectCliActionFailure(failure);
    expect(publicFailure).toMatchObject({ code: 'deployment_source_checkout_required',
        details: { requiredFact: 'deploymentActionResult', remedy: expect.any(String) } });
    // Replay the returned input unchanged through the same schema as the public projects.open Action.
    const nextAction = (publicFailure.details as { nextAction?: { input?: unknown } } | undefined)?.nextAction;
    const open = OpenProjectInputV1Schema.parse(nextAction?.input);
    expect(nextAction).toMatchObject({ kind: 'action', actionId: 'projects.open', input: { serverId: 'home', machineId: 'controller',
        source: { kind: 'source', id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, selector: {
            // The Source reader's canonical selector, including its qualified provider id.
            protocol: 'https', provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub',
                baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } } });
    expect(open.materialization).toMatchObject({ kind: 'clone', destinationDirectoryName: 'app' });
    if (open.source.kind !== 'source') throw new Error('Projects Open must use the recorded Source');
    expect(open.source.defaultRef).toBe('main');
    await expect(admitProjectSourceSelectionV1({ serverId: open.serverId, sourceId: open.source.id,
        captured: open.source, ...(open.ref === undefined ? {} : { ref: open.ref }), async readSource() { return source; } })).resolves.toMatchObject({
        kind: 'admitted', ref: 'release', subdir: 'workers/site',
    });
    // The app keeps its navigate route from the same recovery owner.
    expect(readDeploymentRefusalRecoveryV1(publicFailure.code, publicFailure.details)).toMatchObject({
        nextAction: { kind: 'navigate', destination: 'source', label: 'Open checkout' } });
    await expect(readDeploymentSourceIntentForHost({ host, request: { environment, requireWorkspace: false, context } }))
        .rejects.toMatchObject({ code: 'deployment_source_unavailable' });
});


it('selects the retained serving stored U for Add after an undeployed edit B, while ordinary deploy stays strict', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const serving = { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services:\n  app:\n    image: nginx:1\n', profiles: [], services: ['app'] };
    environment.content.definition = { ...serving, contentRevision: 2, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  app:\n    image: nginx:2\n' };
    const host = { credentials: { token: 'fixture', encryption: null }, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'controller', async assertAuthority() {},
        async resolveRequesterIdentity(): Promise<never> { throw new Error('Stored source needs no workspace'); } };
    await expect(readDeploymentSourceIntentForHost({ host, request: { environment, sourceIntent: serving,
        actionId: 'deployments.deploy', context: {} } })).rejects.toMatchObject({ code: 'deployment_conflict' });
    const selected = await readDeploymentSourceIntentForHost({ host, request: { environment,
        sourceIntent: serving, retainedSourceIntent: serving, actionId: 'deployments.deploy', context: {} } });
    expect(selected.sourceIntent).toEqual(serving);
    expect(selected.sourceIntent).not.toEqual(environment.content.definition);
    expect(selected.workspace).toBeUndefined();
});
