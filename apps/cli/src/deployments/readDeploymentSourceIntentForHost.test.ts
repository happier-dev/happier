import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
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
import { normalizeActionExecuteResult, projectCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDeploymentSourceMaterializationPort } from './targets/ownServer/exactCommitRelease';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

afterEach(() => { withdrawActiveProjectAccountRowsSnapshot(); vi.restoreAllMocks(); });

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

it.each(['owner', 'use-grantee'] as const)('acquires requester workspace source only for the physical Machine owner (%s)', async actorAccountId => {
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
            machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'controller',
                installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true };
        // The existing identity owner consumes held physical receiver facts and admitted ingress.
        const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
        const host = { credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'controller', async assertAuthority() { context.signal.throwIfAborted(); },
            async resolveRequesterIdentity(current: import('@happier-dev/protocol').ActionExecutorContext) {
                const requester = await identityOwner.resolveActionRequester!(current);
                try { return requester.identity; } finally { await requester.dispose(); }
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
        if (actorAccountId === 'owner') {
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

it('requires a local workspace for native materialization and refuses provider refs without a resolver', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const sourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
    if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
    mockProjectAccountRowsHttpBoundary([]);
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true, source: {
        id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision, name: 'App', audience: [], createdByAccountId: 'owner',
        repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } },
    } }) });
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
    // No checkout row on the controller: a typed remedy that survives deployment and public CLI projection.
    const missingCheckout = await readDeploymentSourceIntentForHost({ host, request: { environment, sourceIntent, context } })
        .then(() => { throw new Error('A missing checkout cannot select a source'); }, (error: unknown) => error);
    const failure = normalizeActionExecuteResult(projectDeploymentException(missingCheckout));
    if (failure.ok) throw new Error('A missing checkout cannot become success');
    const publicFailure = projectCliActionFailure(failure);
    expect(publicFailure).toMatchObject({ code: 'deployment_source_checkout_required',
        details: { requiredFact: 'deploymentActionResult', remedy: expect.any(String) } });
    // Agents and the app read the public code through the one recovery owner: Open checkout, not Source setup.
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
