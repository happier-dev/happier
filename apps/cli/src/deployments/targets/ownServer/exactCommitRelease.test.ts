import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDeploymentGitRegistry } from './exactCommitRelease.testkit';
export { createDeploymentGitRegistry } from './exactCommitRelease.testkit';
import { createDeploymentManifestInputReader, createDeploymentSourceMaterializationPort, isDeploymentSourceUnchangedManifestInput,
    readDeploymentSourceManifestForHost, type AdmittedDeploymentSourceV1 } from './exactCommitRelease';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import { PluginError } from '@happier-dev/plugin-sdk';
import * as persistence from '@/persistence';
import { createDeploymentTargetRoleAdmissionFixture } from '../deploymentTargetRoleAdmission.testkit';
import { admitDeploymentTargetRoleForHost } from '../admitDeploymentTargetRoleForHost';
import { createDeploymentTargetRoleSourceAdmissionForHost } from '../createDeploymentTargetRoleAdmissionHost';
import { admitStoredComposeDefinition, normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { exportWorkspaceCommit, resolveWorkspaceCommitRef } from '@/scm/workspace/workspaceCommitExport';
import { createScmBackendRegistry } from '@/scm/registry';
import { readDeploymentSourceIdentityForHost, resolveDeploymentSourcePathForHost } from './paths';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import axios from 'axios';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function withCommittedSource(run: (source: AdmittedDeploymentSourceV1 & { sourcePath: string; commitSha: string }) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-release-custody-'));
    try {
        const repository = join(root, 'repository');
        await mkdir(repository);
        git(repository, ['init', '--quiet']);
        git(repository, ['config', 'user.name', 'Deployment Fixture']);
        git(repository, ['config', 'user.email', 'deployment@example.test']);
        await writeFile(join(repository, 'compose.yaml'), 'services:\n  web:\n    image: example/commit-A\n');
        git(repository, ['add', '.']);
        git(repository, ['commit', '--quiet', '-m', 'A']);
        await run({ environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment-A', machineId: 'machine',
            installationId: 'installation', sourcePath: repository, commitSha: git(repository, ['rev-parse', 'HEAD']),
            deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'artifacts'), async assertCurrent() {} });
    } finally { await rm(root, { recursive: true, force: true }); }
}

const request = { environmentId: 'environment', deploymentId: 'deployment-A' };

it('captures the selected immutable commit subject rather than the current checkout subject', async () => {
    await withCommittedSource(async source => {
        await writeFile(join(source.sourcePath, 'later'), 'later');
        git(source.sourcePath, ['add', 'later']);
        git(source.sourcePath, ['commit', '--quiet', '-m', 'Unrelated later commit']);
        const exported = await exportWorkspaceCommit({ sourcePath: source.sourcePath, commitSha: source.commitSha,
            artifactDirectory: source.artifactDirectory, registry: createDeploymentGitRegistry() });
        try { expect(exported).toMatchObject({ commitSubject: 'A', commitSha: source.commitSha }); }
        finally { await exported.blobProvider.dispose?.(); await exported.dispose(); }
    });
});

describe('native generation path routing through the source path owner', () => {
    it('round-trips only canonical runtime release and restoration locations without granting source custody', () => {
        const deploymentRoot = join(tmpdir(), 'happier-generation-routing');
        const release = { deploymentRoot, environmentInstanceId: 'instance', deploymentId: 'original-A' };
        const releasePath = resolveDeploymentSourcePathForHost(release);
        expect(readDeploymentSourceIdentityForHost({ deploymentRoot, sourcePath: releasePath }))
            .toEqual({ environmentInstanceId: 'instance', deploymentId: 'original-A' });
        const restoration = { ...release, restorationForDeploymentId: 'restoration-B' };
        expect(readDeploymentSourceIdentityForHost({ deploymentRoot, sourcePath: resolveDeploymentSourcePathForHost(restoration) }))
            .toEqual({ environmentInstanceId: 'instance', deploymentId: 'original-A', restorationForDeploymentId: 'restoration-B' });
        for (const rootPath of [
            resolveDeploymentSourcePathForHost({ ...release, materializationRole: 'build' }),
            resolveDeploymentSourcePathForHost({ ...release, deploymentRoot: `${deploymentRoot}-sibling` }),
            join(releasePath, 'compose.yaml'),
        ]) expect(readDeploymentSourceIdentityForHost({ deploymentRoot, sourcePath: rootPath })).toBeNull();
        // Native path spelling is normalized by the path owner; this routing
        // hint still does not grant source or physical materialization custody.
        for (const sourcePath of [
            `${deploymentRoot}${sep}instance${sep}releases${sep}..${sep}releases${sep}original-A`,
            `${releasePath}${sep}`,
        ]) expect(readDeploymentSourceIdentityForHost({ deploymentRoot, sourcePath }))
            .toEqual({ environmentInstanceId: 'instance', deploymentId: 'original-A' });
    });
});

describe('exact deployment source through the public port', () => {
    it('preserves the shared workspace Use refusal through upload source acquisition', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('uploadDeploy');
        fixture.state.receipt.content.sourceMethod = 'upload';
        const context = { ...fixture.request.context, authority: 'present_user' as const,
            machineAdmission: { actorAccountId: 'custody-account', custodianAccountId: 'physical-owner',
                machineId: 'controller', installationId: 'installation-controller', role: 'use' as const,
                encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
        const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation-controller',
                custodianAccountId: 'physical-owner' }) });
        const host = { ...fixture.host,
            async resolveRequesterIdentity(current: import('@happier-dev/protocol').ActionExecutorContext) {
                const requester = await identityOwner.resolveActionRequester!(current);
                try { return requester.identity; } finally { await requester.dispose(); }
            } };
        const admission = await admitDeploymentTargetRoleForHost({ ...fixture.request, context }, host);
        if (!admission.receipt) throw new Error('Expected the canonical admitted receipt');
        const identity = { environmentId: admission.environment.environment.id, deploymentId: admission.receipt.deployment.id };
        const lifetime = createPluginInvocationLifetime();
        const port = createDeploymentSourceMaterializationPort({
            admit: createDeploymentTargetRoleSourceAdmissionForHost({ ...admission, receipt: admission.receipt }, host, context),
            invocation: { identity, signal: lifetime.signal, retainCleanup: lifetime.retainCleanup,
                assertCurrent() { lifetime.signal.throwIfAborted(); } },
        });
        const network = vi.spyOn(axios, 'request');
        try {
            await expect(port.materialize(identity)).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
            expect(network).not.toHaveBeenCalled();
        } finally { network.mockRestore(); await lifetime.complete(); }
    });
    it.each(['environmentId', 'deploymentId'] as const)('refuses another %s before source admission IO', async field => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('uploadDeploy');
        const definition = await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services: {}', profiles: [], services: [] });
        fixture.state.environment.content.definition = definition;
        fixture.state.receipt.content.sourceIntent = definition;
        fixture.state.receipt.content.sourceMethod = 'upload';
        const admission = await admitDeploymentTargetRoleForHost({ ...fixture.request,
            input: { ...fixture.input, sourceIntent: definition } }, fixture.host);
        if (!admission.receipt) throw new Error('Expected the canonical admitted receipt');
        const identity = { environmentId: admission.environment.environment.id, deploymentId: admission.receipt.deployment.id };
        const lifetime = createPluginInvocationLifetime();
        const port = createDeploymentSourceMaterializationPort({
            admit: createDeploymentTargetRoleSourceAdmissionForHost({ ...admission, receipt: admission.receipt }, fixture.host, fixture.request.context),
            invocation: { identity, signal: lifetime.signal, retainCleanup: lifetime.retainCleanup,
                assertCurrent() { lifetime.signal.throwIfAborted(); } },
        });
        // Saved-profile persistence is the first OS acquisition made by this real stored-source helper.
        const settings = vi.spyOn(persistence, 'readSettings').mockRejectedValue(new Error('Source admission reached saved-profile IO'));
        try {
            await expect(port.materialize({ ...identity, [field]: 'another-record' })).rejects.toMatchObject({ code: 'target_mismatch' });
            expect(settings).not.toHaveBeenCalled();
        } finally { settings.mockRestore(); await lifetime.complete(); }
    });
    it.each([true, false])('keeps exact Git and manifest custody when source acquisition retires (committed=%s)', async committed => {
        await withCommittedSource(async source => {
            await writeFile(join(source.sourcePath, 'compose.yaml'), 'services: {}');
            git(source.sourcePath, ['add', '.']);
            git(source.sourcePath, ['commit', '--quiet', '-m', 'Later unreviewed checkout']);
            const lifetime = createPluginInvocationLifetime();
            const port = createDeploymentSourceMaterializationPort({ admit: async () => source, registry: createDeploymentGitRegistry(),
                invocation: { identity: { environmentId: source.environmentId, deploymentId: source.deploymentId },
                    signal: lifetime.signal, retainCleanup: lifetime.retainCleanup,
                    assertCurrent() {
                        if (lifetime.signal.aborted) throw new PluginError({ code: 'plugin_service_unavailable', message: 'Invocation ended' });
                    } } });
            const materialized = await port.materialize(request);
            expect(await readFile(join(materialized.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            expect(readDeploymentSourceManifestForHost(materialized)).toEqual(expect.arrayContaining([
                expect.objectContaining({ relativePath: 'compose.yaml' }),
            ]));
            expect(await isDeploymentSourceUnchangedManifestInput(materialized, join(materialized.rootPath, 'compose.yaml'))).toBe(true);
            if (committed) await materialized.commit();
            await lifetime.complete();
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
            await materialized.commit();
            await materialized.abort();
            if (committed) expect(await readFile(join(materialized.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            else await expect(readFile(join(materialized.rootPath, 'compose.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
    it('keeps retained operation-log inputs inside the physical source root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-log-source-root-'));
        try {
            const sourceRoot = join(root, 'source');
            const directory = join(sourceRoot, '.happier');
            const log = join(directory, 'deploy.log');
            await mkdir(directory, { recursive: true });
            await writeFile(log, 'operation output');
            const read = await createDeploymentManifestInputReader({ rootPath: sourceRoot, manifest: [], operationLog: true });
            expect(await read(log)).toBe(true);
            await rename(directory, join(root, 'retained-log'));
            const foreign = join(root, 'foreign');
            await mkdir(foreign);
            await writeFile(join(foreign, 'deploy.log'), 'foreign bytes');
            await symlink(foreign, directory, 'dir');
            expect(await read(log)).toBe(false);
            expect(await readFile(join(foreign, 'deploy.log'), 'utf8')).toBe('foreign bytes');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it.each(['commit', 'abort'] as const)('preserves the pinned same-host build log through runtime source %s', async settlement => {
        await withCommittedSource(async source => {
            const releaseRoot = join(source.deploymentRoot, source.environmentInstanceId, 'releases', source.deploymentId);
            const log = join(releaseRoot, '.happier', 'deploy.log');
            await mkdir(join(releaseRoot, '.happier'), { recursive: true, mode: 0o700 });
            await writeFile(log, 'PORT=3000 [REDACTED] build\n', { mode: 0o600 });
            const before = await stat(log, { bigint: true });
            const rootBefore = await stat(releaseRoot, { bigint: true });
            const operationLog = true;
            const progress: string[] = [];
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(),
                onProgress: phase => { progress.push(phase); }, async admit() {
                return { ...source, operationLog };
            } });
            const release = await port.materialize(request);
            expect(progress).toEqual(['export', 'materialize']);
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            expect((await stat(log, { bigint: true })).ino).toBe(before.ino);
            expect((await stat(releaseRoot, { bigint: true })).ino).toBe(rootBefore.ino);
            expect(await isDeploymentSourceUnchangedManifestInput(release, release.rootPath)).toBe(true);
            await writeFile(log, 'more redacted output\n', { flag: 'a' });
            expect(await isDeploymentSourceUnchangedManifestInput(release, release.rootPath)).toBe(true);
            await release[settlement]();
            expect(await readFile(log, 'utf8')).toBe('PORT=3000 [REDACTED] build\nmore redacted output\n');
            expect((await stat(log, { bigint: true })).ino).toBe(before.ino);
            if (settlement === 'abort') await expect(access(join(releaseRoot, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
    it('leaves foreign root reoccupation and foreign extra bytes untouched during retained-log abort', async () => {
        await withCommittedSource(async source => {
            const releaseRoot = join(source.deploymentRoot, source.environmentInstanceId, 'releases', source.deploymentId);
            const log = join(releaseRoot, '.happier', 'deploy.log');
            await mkdir(join(releaseRoot, '.happier'), { recursive: true, mode: 0o700 });
            await writeFile(log, 'retained output\n', { mode: 0o600 });
            const before = await stat(log, { bigint: true });
            const operationLog = true;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...source, operationLog };
            } });
            const release = await port.materialize(request);
            await writeFile(join(releaseRoot, 'foreign'), 'must remain');
            await release.abort();
            expect(await readFile(join(releaseRoot, 'foreign'), 'utf8')).toBe('must remain');
            expect(await readFile(log, 'utf8')).toBe('retained output\n');
            await rm(join(releaseRoot, 'foreign'));
            const next = await port.materialize(request);
            const ownedRoot = `${releaseRoot}-retained`;
            await rename(releaseRoot, ownedRoot);
            await mkdir(releaseRoot, { mode: 0o755 });
            await writeFile(join(releaseRoot, 'foreign'), 'foreign root');
            const mode = (await stat(releaseRoot)).mode;
            await expect(next.abort()).rejects.toThrow();
            expect(await readdir(releaseRoot)).toEqual(['foreign']);
            expect((await stat(releaseRoot)).mode).toBe(mode);
            expect(await readFile(join(releaseRoot, 'foreign'), 'utf8')).toBe('foreign root');
            expect((await stat(join(ownedRoot, '.happier', 'deploy.log'), { bigint: true })).ino).toBe(before.ino);
        });
    });
    it.each(['foreign', 'tracked'] as const)('refuses %s bytes rather than broadening the operation-log admission', async collision => {
        await withCommittedSource(async source => {
            const releaseRoot = join(source.deploymentRoot, source.environmentInstanceId, 'releases', source.deploymentId);
            const log = join(releaseRoot, '.happier', 'deploy.log');
            await mkdir(join(releaseRoot, '.happier'), { recursive: true, mode: 0o700 });
            await writeFile(log, 'operation output', { mode: 0o600 });
            const before = await stat(log, { bigint: true });
            const operationLog = true;
            let commitSha = source.commitSha;
            if (collision === 'foreign') await writeFile(join(releaseRoot, 'foreign'), 'foreign bytes');
            else {
                await mkdir(join(source.sourcePath, '.happier'));
                await writeFile(join(source.sourcePath, '.happier', 'deploy.log'), 'tracked source bytes');
                git(source.sourcePath, ['add', '.']); git(source.sourcePath, ['commit', '--quiet', '-m', 'tracked log collision']);
                commitSha = git(source.sourcePath, ['rev-parse', 'HEAD']);
            }
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...source, commitSha, operationLog };
            } });
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'deployment_log_unavailable' });
            expect(await readFile(log, 'utf8')).toBe('operation output');
            expect((await stat(log, { bigint: true })).ino).toBe(before.ino);
            if (collision === 'foreign') expect(await readFile(join(releaseRoot, 'foreign'), 'utf8')).toBe('foreign bytes');
        });
    });
    it.each(['commit', 'tree', 'blob'] as const)('exports original immutable bytes despite local %s replacement refs', async kind => {
        await withCommittedSource(async source => {
            await writeFile(join(source.sourcePath, 'compose.yaml'), 'services: {web: {image: substituted-B}}');
            git(source.sourcePath, ['add', '.']); git(source.sourcePath, ['commit', '--quiet', '-m', 'replacement B']);
            const suffix = kind === 'tree' ? '^{tree}' : kind === 'blob' ? ':compose.yaml' : '';
            const original = git(source.sourcePath, ['rev-parse', `${source.commitSha}${suffix}`]);
            const replacement = git(source.sourcePath, ['rev-parse', `HEAD${suffix}`]);
            git(source.sourcePath, ['replace', original, replacement]);
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return source; } });
            const release = await port.materialize(request);
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            await release.abort();
        });
    });
    it('fetches the base PR ref and refuses a different approved SHA, advanced head, missing ref or withdrawn base access before materialization', async () => {
        await withCommittedSource(async source => {
            const base = join(source.sourcePath, '..', 'base.git');
            git(source.sourcePath, ['init', '--bare', '--quiet', base]);
            const cloneUrl = 'https://github.example.test/base/project.git';
            git(source.sourcePath, ['remote', 'add', 'base', cloneUrl]);
            git(source.sourcePath, ['config', `url.${pathToFileURL(base).href}.insteadOf`, cloneUrl]);
            git(source.sourcePath, ['push', 'base', `${source.commitSha}:refs/pull/7/head`]);
            await writeFile(join(source.sourcePath, 'compose.yaml'), 'services: {web: {image: base-B}}');
            git(source.sourcePath, ['add', '.']); git(source.sourcePath, ['commit', '--quiet', '-m', 'base B']);
            const baseSha = git(source.sourcePath, ['rev-parse', 'HEAD']);
            const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.example.test' },
                repository: { nameWithOwner: 'base/project', cloneUrl }, protocol: 'https' as const };
            let commitSha = source.commitSha;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...source, commitSha, pullRequestHead: { number: 7 }, repository };
            } });
            const approved = await port.materialize(request);
            expect(await readFile(join(approved.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            await approved.abort();
            commitSha = baseSha;
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'approval_stale' });
            commitSha = source.commitSha;
            git(source.sourcePath, ['push', '--force', 'base', `${baseSha}:refs/pull/7/head`]);
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'approval_stale' });
            git(source.sourcePath, ['push', 'base', ':refs/pull/7/head']);
            await expect(port.materialize(request)).rejects.toThrow();
            await rename(base, `${base}.withdrawn`);
            await expect(port.materialize(request)).rejects.toThrow();
            expect(git(source.sourcePath, ['rev-parse', 'HEAD'])).toBe(baseSha);
            await expect(access(join(source.deploymentRoot, 'instance', 'releases', source.deploymentId))).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
    it('resolves the selected ref through the registered backend and refuses missing refs without moving HEAD', async () => {
        await withCommittedSource(async source => {
            const registry = createDeploymentGitRegistry();
            git(source.sourcePath, ['branch', 'selected-release']);
            await writeFile(join(source.sourcePath, 'compose.yaml'), 'different HEAD');
            git(source.sourcePath, ['add', '.']); git(source.sourcePath, ['commit', '--quiet', '-m', 'B']);
            const head = git(source.sourcePath, ['rev-parse', 'HEAD']);
            expect(await resolveWorkspaceCommitRef({ sourcePath: source.sourcePath, ref: 'selected-release', registry })).toBe(source.commitSha);
            await expect(resolveWorkspaceCommitRef({ sourcePath: source.sourcePath, ref: 'does-not-exist', registry }))
                .rejects.toMatchObject({ code: 'git_selection_unavailable' });
            expect(git(source.sourcePath, ['rev-parse', 'HEAD'])).toBe(head);
        });
    });
    it('admits current-home absolute binds in both separator styles without treating them as repository files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-stored-home-bind-'));
        const document = JSON.stringify({ services: { web: { image: 'app', volumes: [
            '~/data:/data', { type: 'bind', source: '~\\data', target: '/other' },
        ] } } });
        const port = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment-A',
                machineId: 'machine', installationId: 'installation', deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'artifacts'),
                definition: { kind: 'stored' as const, contentRevision: 1, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] },
                async assertCurrent() {} };
        } });
        try {
            const release = await port.materialize(request);
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toBe(document);
            await release.abort();
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('pins declared public sidecar bytes and materializes them through the stored source port', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-stored-sidecars-'));
        const document = JSON.stringify({ services: { web: { image: 'app', env_file: './files/app.env', volumes: ['./files/data:/app/data'],
            configs: [{ source: 'settings', target: '/app/settings.json' }] } },
            configs: { settings: { file: './files/settings.json' } } });
        const input = { from: 'compose' as const, document, profiles: [], services: ['web'],
            publicFiles: [{ path: 'files/settings.json', content: '{"port":8080}\n' }, { path: 'files/app.env', content: 'MODE=public\n' }] };
        try {
            const definition = await normalizeStoredComposeDefinitionInput(input);
            expect(definition).toMatchObject({ publicFiles: input.publicFiles });
            const changed = await normalizeStoredComposeDefinitionInput({ ...input,
                publicFiles: [{ path: 'files/settings.json', content: '{"port":8081}\n' }, input.publicFiles[1]!] });
            expect(changed.composeDigest).not.toBe(definition.composeDigest);
            const reordered = await normalizeStoredComposeDefinitionInput({ ...input, publicFiles: [...input.publicFiles].reverse() });
            expect(reordered.composeDigest).not.toBe(definition.composeDigest);
            await expect(admitStoredComposeDefinition({ ...changed, composeDigest: definition.composeDigest }))
                .rejects.toMatchObject({ code: 'approval_stale' });
            const port = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment-A',
                    machineId: 'machine', installationId: 'installation', deploymentRoot: join(root, 'deployments'),
                    artifactDirectory: join(root, 'artifacts'), definition, async assertCurrent() {} };
            } });
            const release = await port.materialize(request);
            expect(await readFile(join(release.rootPath, 'files/settings.json'), 'utf8')).toBe(input.publicFiles[0]!.content);
            expect(readDeploymentSourceManifestForHost(release)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'file', relativePath: 'files/settings.json' }),
            ]));
            await release.abort();
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('refuses undeclared sidecars, escaping paths and changed source digests before creating materialization files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-stored-boundary-'));
        let document = '';
        let digest: string | undefined;
        const port = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment-A',
                machineId: 'machine', installationId: 'installation', deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'artifacts'),
                definition: { kind: 'stored' as const, contentRevision: 1, document,
                    composeDigest: digest ?? `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] },
                async assertCurrent() {} };
        } });
        try {
            for (const source of [
                { services: { web: { image: 'app', volumes: ['../data:/data'] } } },
                { services: { web: { image: 'app', volumes: [{ type: 'bind', source: '../settings.json', target: '/app/settings' }] } } },
                { services: { web: { image: 'app', env_file: './variables' } } },
                { services: { web: { build: '.' } } },
                { include: './other.yaml', services: { web: { image: 'app' } } },
                { services: { web: { extends: { file: './other.yaml', service: 'web' } } } },
                { configs: { app: { file: './settings.json' } }, services: { web: { image: 'app' } } },
                { secrets: { app: { file: '/private/secret' } }, services: { web: { image: 'app' } } },
            ]) {
                document = JSON.stringify(source);
                await expect(port.materialize(request)).rejects.toMatchObject({ code: 'needs_repository' });
                expect(await readdir(root)).toEqual([]);
            }
            document = 'services: {web: {image: app}}'; digest = `sha256:${'0'.repeat(64)}`;
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'approval_stale' });
            expect(await readdir(root)).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('materializes an exact stored inline config without a repository or SCM export', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-stored-release-'));
        const document = 'services:\n  web:\n    image: example/app\n    configs:\n      - source: settings\n        target: /app/settings.json\nconfigs:\n  settings:\n    content: |\n      {"port":"${PORT:?required}"}\n';
        try {
            const port = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment-A',
                    machineId: 'machine', installationId: 'installation', deploymentRoot: join(root, 'deployments'),
                    artifactDirectory: join(root, 'artifacts'),
                    definition: { kind: 'stored' as const, contentRevision: 3, document,
                        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] },
                    async assertCurrent() {} };
            } });
            const release = await port.materialize(request);
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toBe(document);
            expect(await readdir(release.rootPath)).toEqual(['compose.yaml']);
            await release.commit();
            await release.assertCurrent();
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('refuses cancelled, substituted and path-escaping admission before materialization', async () => {
        let admissions = 0;
        const progress: string[] = [];
        const port = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
            onProgress: phase => { progress.push(phase); }, async admit() {
            admissions++;
            return { environmentId: 'environment', environmentInstanceId: '../outside', deploymentId: 'deployment', machineId: 'machine',
                installationId: 'installation', sourcePath: '/unused', commitSha: 'a'.repeat(40), deploymentRoot: '/unused',
                artifactDirectory: '/unused', async assertCurrent() {} };
        } });
        const controller = new AbortController(); controller.abort();
        await expect(port.materialize({ environmentId: 'environment', deploymentId: 'deployment' }, { signal: controller.signal })).rejects.toThrow();
        expect(admissions).toBe(0);
        await expect(port.materialize({ environmentId: 'another', deploymentId: 'deployment' })).rejects.toMatchObject({ code: 'target_mismatch' });
        await expect(port.materialize({ environmentId: 'environment', deploymentId: 'deployment' })).rejects.toMatchObject({ code: 'invalid_request' });
        expect(progress).toEqual([]);
    });
    it('materializes the selected commit while HEAD, index and dirty workspace all contain different bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-exact-release-'));
        try {
            const repository = join(root, 'repository');
            await mkdir(repository);
            git(repository, ['init', '--quiet']);
            git(repository, ['config', 'user.name', 'Deployment Fixture']);
            git(repository, ['config', 'user.email', 'deployment@example.test']);
            await writeFile(join(repository, 'compose.yaml'), 'services:\n  web:\n    image: example/commit-A\n');
            await writeFile(join(repository, 'binary'), Buffer.from([0, 255, 12]));
            await writeFile(join(repository, 'entry.sh'), '#!/bin/sh\nprintf A\n');
            git(repository, ['add', '.']);
            git(repository, ['update-index', '--chmod=+x', 'entry.sh']);
            git(repository, ['commit', '--quiet', '-m', 'A']);
            const commitSha = git(repository, ['rev-parse', 'HEAD']);
            await writeFile(join(repository, 'compose.yaml'), 'services:\n  web:\n    image: example/HEAD-B\n');
            git(repository, ['add', '.']); git(repository, ['commit', '--quiet', '-m', 'B']);
            await writeFile(join(repository, 'compose.yaml'), 'index-C'); git(repository, ['add', '.']);
            await writeFile(join(repository, 'compose.yaml'), 'dirty-D');
            await writeFile(join(repository, 'untracked'), 'never deploy this');
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment-A', machineId: 'machine',
                    installationId: 'installation', sourcePath: repository, commitSha, deploymentRoot: join(root, 'deployments'),
                    artifactDirectory: join(root, 'artifacts'), async assertCurrent() {} };
            } });
            const release = await port.materialize({ environmentId: 'environment', deploymentId: 'deployment-A' });
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            expect(await readFile(join(release.rootPath, 'binary'))).toEqual(Buffer.from([0, 255, 12]));
            if (process.platform !== 'win32') expect((await stat(join(release.rootPath, 'entry.sh'))).mode & 0o100).not.toBe(0);
            expect(await readdir(release.rootPath)).not.toContain('untracked');
            await release.commit();
            expect(await readFile(join(repository, 'compose.yaml'), 'utf8')).toBe('dirty-D');
            expect(git(repository, ['show', ':compose.yaml'])).toBe('index-C');
            expect(release).not.toHaveProperty('requester');
            expect(release).not.toHaveProperty('workspace');
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('refuses mutable or missing commits and never replaces a previously committed release', async () => {
        await withCommittedSource(async source => {
            let selected = source;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return selected; } });
            for (const commitSha of ['HEAD', source.commitSha.slice(0, 12), '0'.repeat(40)]) {
                selected = { ...source, commitSha };
                await expect(port.materialize(request)).rejects.toMatchObject({ code: 'git_selection_unavailable' });
            }
            selected = source;
            const release = await port.materialize(request);
            await release.commit();
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'approval_stale' });
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            expect(await readdir(source.artifactDirectory)).toEqual([]);
        });
    });

    it('keeps builder and runtime source custody disjoint for the same receipt on one Machine', async () => {
        await withCommittedSource(async admitted => {
            let materializationRole: 'build' | undefined = 'build';
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...admitted, ...(materializationRole ? { materializationRole } : {}) };
            } });
            const built = await port.materialize(request);
            await built.commit();
            materializationRole = undefined;
            const runtime = await port.materialize(request);
            expect(runtime.deploymentId).toBe(built.deploymentId);
            expect(runtime.manifestFingerprint).toBe(built.manifestFingerprint);
            expect(runtime.rootPath).not.toBe(built.rootPath);
            expect(await readFile(join(runtime.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            await runtime.abort();
            expect(await readFile(join(built.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
        });
    });

    it('keeps overlapping backup source materializations independent for the same serving generation', async () => {
        await withCommittedSource(async admitted => {
            const materialize = (maintenanceOperationId: string) => createDeploymentSourceMaterializationPort({
                registry: createDeploymentGitRegistry(), async admit() {
                    return { ...admitted, restorationForDeploymentId: admitted.deploymentId, maintenanceOperationId };
                },
            }).materialize(request);
            const testing = await materialize('destination-test');
            try {
                const backup = await materialize('backup-now');
                try {
                    expect(backup.deploymentId).toBe(testing.deploymentId);
                    expect(backup.manifestFingerprint).toBe(testing.manifestFingerprint);
                    expect(backup.rootPath).not.toBe(testing.rootPath);
                    // Finishing Test cannot dispose the concurrent backup's source.
                    await testing.abort();
                    expect(await readFile(join(backup.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
                    expect(readDeploymentSourceIdentityForHost({ deploymentRoot: admitted.deploymentRoot,
                        sourcePath: backup.rootPath })).toBeNull();
                } finally { await backup.abort(); }
            } finally { await testing.abort(); }
        });
    });

    it('materializes a selected uniform release for compensation without replacing either committed release', async () => {
        await withCommittedSource(async admitted => {
            let parentDeploymentId: string | undefined;
            let selectedDeploymentId = admitted.deploymentId;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...admitted, deploymentId: selectedDeploymentId,
                    ...(parentDeploymentId ? { restorationForDeploymentId: parentDeploymentId } : {}) };
            } });
            const uniform = await port.materialize(request);
            await uniform.commit();
            parentDeploymentId = 'deployment-v3';
            const restored = await port.materialize(request);
            expect(restored.deploymentId).toBe(uniform.deploymentId);
            expect(await readFile(join(restored.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            selectedDeploymentId = parentDeploymentId;
            parentDeploymentId = undefined;
            const failed = await port.materialize({ ...request, deploymentId: selectedDeploymentId });
            await failed.commit();
            expect(restored.rootPath).not.toBe(failed.rootPath);
            await restored.abort();
            expect(await readFile(join(uniform.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            expect(await readFile(join(failed.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            await expect(stat(restored.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
            selectedDeploymentId = admitted.deploymentId;
            parentDeploymentId = '../outside';
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'invalid_request' });
        });
    });

    it('disposes exported bytes on stale review, cancellation and authority withdrawal', async () => {
        await withCommittedSource(async source => {
            const controller = new AbortController();
            let withdrawal: 'cancel' | 'revoke' | null = null;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...source, async assertCurrent() {
                    const artifacts = await readdir(source.artifactDirectory).catch((error: NodeJS.ErrnoException) => {
                        if (error.code === 'ENOENT') return [];
                        throw error;
                    });
                    if (artifacts.length === 0) return;
                    if (withdrawal === 'cancel') controller.abort();
                    if (withdrawal === 'revoke') throw Object.assign(new Error('Authority withdrawn'), { code: 'permission_denied' });
                } };
            } });
            await expect(port.materialize({ ...request, expectedManifestFingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'deployment_conflict' });
            expect(await readdir(source.artifactDirectory)).toEqual([]);
            withdrawal = 'cancel';
            await expect(port.materialize(request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
            expect(await readdir(source.artifactDirectory)).toEqual([]);
            withdrawal = 'revoke';
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'permission_denied' });
            expect(await readdir(source.artifactDirectory)).toEqual([]);
        });
    });

    it('does not multiply authoritative admission reads by committed file count', async () => {
        await withCommittedSource(async source => {
            let selected = source;
            let authorityReads = 0;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...selected, async assertCurrent() { authorityReads++; } };
            } });
            const first = await port.materialize(request);
            const firstReads = authorityReads;
            await first.abort();
            for (let index = 0; index < 20; index++) await writeFile(join(source.sourcePath, `file-${index}`), 'committed');
            git(source.sourcePath, ['add', '.']);
            git(source.sourcePath, ['commit', '--quiet', '-m', 'More source files']);
            selected = { ...source, commitSha: git(source.sourcePath, ['rev-parse', 'HEAD']) };
            authorityReads = 0;
            const second = await port.materialize(request);
            expect(authorityReads).toBe(firstReads);
            expect(await readFile(join(second.rootPath, 'file-19'), 'utf8')).toBe('committed');
            await second.abort();
        });
    });

    it('can relinquish rollback custody after cancellation once native activation may have consumed the release', async () => {
        await withCommittedSource(async source => {
            const controller = new AbortController();
            let deployerRevoked = false;
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() {
                return { ...source, async assertCurrent() {
                    if (deployerRevoked) throw Object.assign(new Error('Deployer access withdrawn'), { code: 'permission_denied' });
                } };
            } });
            const release = await port.materialize(request, { signal: controller.signal });
            deployerRevoked = true;
            await expect(release.assertCurrent()).rejects.toMatchObject({ code: 'permission_denied' });
            deployerRevoked = false;
            controller.abort();
            await expect(release.assertCurrent()).rejects.toMatchObject({ name: 'AbortError' });
            await release.commit();
            await release.commit();
            deployerRevoked = true;
            // Retained service logs/controls check physical release custody,
            // not the ended deploy caller's cancellation/approval lifetime.
            await expect(release.assertCurrent()).resolves.toBeUndefined();
            await release.abort();
            expect(await readFile(join(release.rootPath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            await rename(release.rootPath, `${release.rootPath}.retired`);
            await mkdir(release.rootPath);
            await expect(release.assertCurrent()).rejects.toThrow();
        });
    });

    it('refuses nonportable committed paths instead of deploying renamed files', async () => {
        await withCommittedSource(async source => {
            await writeFile(join(source.sourcePath, ' trailing '), 'must retain its exact name');
            git(source.sourcePath, ['add', '.']);
            git(source.sourcePath, ['commit', '--quiet', '-m', 'literal path']);
            const admitted = { ...source, commitSha: git(source.sourcePath, ['rev-parse', 'HEAD']) };
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return admitted; } });
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'unsupported' });
            expect(await readdir(source.artifactDirectory)).toEqual([]);
        });
    });

    it('refuses unmaterialized Git submodules instead of silently omitting them', async () => {
        await withCommittedSource(async source => {
            git(source.sourcePath, ['update-index', '--add', '--cacheinfo', `160000,${source.commitSha},dependency`]);
            git(source.sourcePath, ['commit', '--quiet', '-m', 'gitlink']);
            const admitted = { ...source, commitSha: git(source.sourcePath, ['rev-parse', 'HEAD']) };
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return admitted; } });
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'unsupported' });
        });
    });

    it.skipIf(process.platform === 'win32')('preserves contained commit symlinks and aborts only the owned release', async () => {
        await withCommittedSource(async source => {
            await symlink('compose.yaml', join(source.sourcePath, 'compose-link'));
            git(source.sourcePath, ['add', '.']);
            git(source.sourcePath, ['commit', '--quiet', '-m', 'contained link']);
            const admitted = { ...source, commitSha: git(source.sourcePath, ['rev-parse', 'HEAD']) };
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return admitted; } });
            const release = await port.materialize(request);
            expect(await readlink(join(release.rootPath, 'compose-link'))).toBe('compose.yaml');
            await release.abort();
            await expect(readFile(join(release.rootPath, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile(join(source.sourcePath, 'compose.yaml'), 'utf8')).toContain('example/commit-A');
            expect(await readdir(source.artifactDirectory)).toEqual([]);
        });
    });

    it.skipIf(process.platform === 'win32')('refuses escaping commit symlinks without writing outside custody', async () => {
        await withCommittedSource(async source => {
            await symlink('../../outside', join(source.sourcePath, 'escape'));
            git(source.sourcePath, ['add', '.']);
            git(source.sourcePath, ['commit', '--quiet', '-m', 'escaping link']);
            const admitted = { ...source, commitSha: git(source.sourcePath, ['rev-parse', 'HEAD']) };
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return admitted; } });
            await expect(port.materialize(request)).rejects.toThrow(/symlink.*escapes/u);
            expect(await readdir(source.artifactDirectory)).toEqual([]);
            await expect(readFile(join(source.deploymentRoot, 'instance', 'releases', source.deploymentId, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    it.skipIf(process.platform === 'win32')('refuses release parents redirected outside the admitted deployment root', async () => {
        await withCommittedSource(async source => {
            const outside = join(source.sourcePath, 'outside');
            await mkdir(outside);
            await writeFile(join(outside, 'sentinel'), 'preserve');
            await mkdir(source.deploymentRoot);
            await symlink(outside, join(source.deploymentRoot, source.environmentInstanceId));
            const port = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), async admit() { return source; } });
            await expect(port.materialize(request)).rejects.toMatchObject({ code: 'invalid_request' });
            expect(await readdir(outside)).toEqual(['sentinel']);
            expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('preserve');
        });
    });
});
