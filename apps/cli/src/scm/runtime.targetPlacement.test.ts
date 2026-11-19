import { execFileSync, spawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { attachSessionHolderWorkspaceClient, openSessionHolderWorkspaceClient, spawnSessionHolderChild, type SessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';
import { createHostScmCommandRunner, runScmCommand, runWithRequesterScmCommandRunner } from '@/scm/runtime';
import { runWithScmCommandOperation } from '@/scm/commandOperation';

import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { runRepositoryCheckpointPhase } from '@/scm/checkpoints/repositoryCheckpointPhase';
import { startGitSmartHttpFixture } from '@/testkit/scm/gitSmartHttpFixture';
import { materializeManagedProjectClone, runScmRepositoryCloneRoute } from '@/scm/rpc/repositoryProvisioningDispatch';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createBareRemoteRepository, makeCloneTargetDescription, makeProviderRegistry, makeRequest, runGit }
    from '../../../../packages/plugins/scm-git/src/operations/repositoryCloneOperations.test-support';

const holderExecutable = resolveSessionHolderExecutablePath();
const helperExecutable = resolveProcessCustodySupportExecutable('linux');

describe.skipIf(process.platform !== 'linux' || !holderExecutable || !helperExecutable)('placed Session SCM execution', () => {
    let directory: string;
    let root: string;
    let holder: SessionHolderChild;
    let agent: SessionHolderChild;
    let target: SessionHolderTarget;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'hws-'));
        root = join(directory, 'ws');
        await mkdir(root);
        target = {
            id: 'local-test-target', holderPath: holderExecutable!, socketDirectory: directory,
            exec: command => new Promise((resolve, reject) => {
                const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, HAPPIER_TEST_SCM_LOCATION: 'target' } });
                let stdout = '';
                child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                child.once('error', reject);
                child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
            }),
            openChannel: argv => {
                const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
                child.once('close', () => channel.destroy());
                return channel;
            },
        };
        agent = spawnSessionHolderChild({ executablePath: holderExecutable!, socketPath: join(directory, 'h.sock'),
            command: 'sleep', args: ['600'], cwd: root, target });
        await new Promise<void>((resolve, reject) => { agent.once('spawn', () => resolve()); agent.once('error', reject); });
        // Workspace operations use their own client beside the Agent-control client.
        holder = await attachSessionHolderWorkspaceClient(join(directory, 'h.sock'), target);
    });
    afterAll(async () => {
        holder?.detach();
        await agent?.terminateGroup({ graceMs: 100 });
        await rm(directory, { recursive: true, force: true });
    });

    it('captures a copied dirty workspace checkpoint through disjoint holder paths', async () => {
        const repository = join(root, 'checkpoint-copy');
        const addressedRoot = join(directory, 'controller-checkpoints');
        const addressedRepository = join(addressedRoot, 'checkpoint-copy');
        await mkdir(repository);
        await mkdir(addressedRepository, { recursive: true });
        const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        await writeFile(join(repository, 'README.md'), 'committed\n');
        git('add', 'README.md');
        git('commit', '-qm', 'baseline');
        await writeFile(join(repository, 'README.md'), 'dirty tracked snapshot\n');
        await writeFile(join(repository, 'host-sentinel.txt'), 'copied untracked snapshot\n');
        await writeFile(join(addressedRepository, 'README.md'), 'controller unchanged\n');
        const indexBefore = await readFile(join(repository, '.git/index'));
        const source = createHolderWorkspaceSource({ id: 'checkpoint-copy', rootPath: addressedRoot,
            guestRootPath: root, holder, helperPath: helperExecutable! });
        const isolatedSource = { ...source, spawn: (request: Parameters<typeof source.spawn>[0]) => {
            const output = request.args.find(argument => argument.startsWith('--output='));
            if (!output) return source.spawn(request);
            // This holder shares the test host's filesystem. Hide the controller's
            // temporary directory at the OS boundary to model the guest namespace.
            const outputDirectory = dirname(output.slice('--output='.length));
            const hiddenDirectory = `${outputDirectory}.controller`;
            renameSync(outputDirectory, hiddenDirectory);
            let restored = false;
            const restore = () => {
                if (restored) return;
                restored = true;
                renameSync(hiddenDirectory, outputDirectory);
            };
            try {
                const child = source.spawn(request);
                child.once('close', restore);
                child.once('error', restore);
                return child;
            } catch (error) { restore(); throw error; }
        } };
        await runWithWorkspaceSource(isolatedSource, async () => {
            const context = await resolveGitCheckpointBackendContext({ cwd: addressedRepository });
            expect(context?.detection.rootPath).toBe(addressedRepository);
            if (!context?.checkpointGitPaths) throw new Error('Checkpoint repository paths unavailable');
            const refs = buildRepositoryCheckpointRefs({ scopeId: 'placed-copy', messageId: 'message', turnId: 'turn' });
            if (!refs.messageStart || !refs.turnFinal) throw new Error('Checkpoint refs unavailable');
            const request = { cwd: context.cwd, projectKey: context.projectKey,
                rootPath: context.detection.rootPath!, checkpointGitPaths: context.checkpointGitPaths };
            const baseline = await runRepositoryCheckpointPhase({ repository: request, checkpointRef: refs.messageStart }, {});
            expect(baseline.captured).toMatchObject({ success: true });
            if (!baseline.captured.success) throw new Error('Checkpoint baseline unavailable');
            await writeFile(join(repository, 'muse-output.txt'), 'MACH_WAVE_176_A_MUSE_WRITE\n');
            const final = await runRepositoryCheckpointPhase({ repository: request, checkpointRef: refs.turnFinal,
                diff: { baseRef: refs.messageStart, baseRefSource: 'message_start', baseCommitSha: baseline.captured.commitSha } }, {});
            expect(final.captured).toMatchObject({ success: true });
            expect(final.diff).toMatchObject({ success: true, contentConfidence: 'exact', files: [
                expect.objectContaining({ filePath: 'muse-output.txt', changeKind: 'added', source: 'scm_checkpoint' }),
            ] });
        });
        expect(await readFile(join(repository, '.git/index'))).toEqual(indexBefore);
        expect(await readFile(join(addressedRepository, 'README.md'), 'utf8')).toBe('controller unchanged\n');
        await expect(readFile(join(addressedRepository, 'muse-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(addressedRepository, '.git/index'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('prepares and publishes the selected branch through the target filesystem', async () => {
        const remote = createBareRemoteRepository();
        const sourceRepository = join(remote, '..', 'source');
        runGit(sourceRepository, ['switch', '-c', 'feature/target-files']);
        await writeFile(join(sourceRepository, 'branch-sentinel'), 'target branch\n');
        runGit(sourceRepository, ['add', 'branch-sentinel']);
        runGit(sourceRepository, ['commit', '-m', 'target branch']);
        runGit(sourceRepository, ['push', remote, 'feature/target-files']);
        const description = makeCloneTargetDescription(remote);
        const registration = createGitScmBackendRuntimeRegistration();
        if (!registration.runtime) throw new Error('Git backend unavailable');
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
            executableDefinition: registration.runtime, registration,
            hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(
                makeProviderRegistry(description)),
        })]);
        const source = createHolderWorkspaceSource({ id: 'clone-target', rootPath: root,
            holder, helperPath: helperExecutable! });
        const filesystemWrites: string[] = [];
        // Genuine OS boundary: observe the real holder filesystem, preserving every operation.
        const observedSource = { ...source,
            mkdir: async (...args: Parameters<typeof source.mkdir>) => {
            filesystemWrites.push(args[0]);
            await source.mkdir(...args);
        } };
        const response = await runWithWorkspaceSource(observedSource, () => runScmRepositoryCloneRoute({
            request: { ...makeRequest(root, remote, 'cloned-branch'),
                initialCheckout: { branch: 'feature/target-files' } }, workingDirectory: root, registry,
        }));
        expect(response, response.success ? undefined : response.error).toMatchObject({ success: true,
            snapshot: { branch: { head: 'feature/target-files', detached: false } } });
        expect(filesystemWrites).toContain(join(root, 'cloned-branch'));
        expect(await source.readFile(join(root, 'cloned-branch', 'branch-sentinel'))).toEqual(Buffer.from('target branch\n'));
    });

    it('clones through the workspace channel before an Agent is created', async () => {
        const forge = await startGitSmartHttpFixture({ authorization: 'Basic fixture', branch: 'project-files' });
        try {
            const original = makeCloneTargetDescription('unused');
            const description = { ...original, repository: { ...original.repository, cloneUrl: forge.url,
                provider: { ...original.repository.provider, urlSafety: { allowedSchemes: ['http:', 'https:'] } } },
                targets: [{ protocol: 'https' as const, url: forge.url, isDefault: true }] };
            const registration = createGitScmBackendRuntimeRegistration();
            if (!registration.runtime) throw new Error('Git backend unavailable');
            const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
                definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
                executableDefinition: registration.runtime, registration,
                hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(makeProviderRegistry(description, {
                    describeCloneTargets: async () => description,
                    resolveCloneAuthentication: async () => ({ kind: 'available', authorizationHeader: 'Basic fixture' }),
                }, forge.url)),
            })]);
            const launched: string[][] = [];
            const targetBoundary = { id: 'pre-session', holderPath: holderExecutable!, helperPath: helperExecutable!,
                exec: target.exec, openChannel: (argv: readonly string[]) => {
                    launched.push([...argv]);
                    return target.openChannel(argv);
                } };
            const request = makeRequest(root, 'unused', 'before-agent');
            const clone = await materializeManagedProjectClone({ target: targetBoundary,
                selection: { kind: 'git_clone', source: { provider: request.provider, repository: request.repository, protocol: 'https' }, branch: 'project-files' },
                destinationParentPath: root, destinationDirectoryName: 'before-agent', registry, signal: new AbortController().signal });
            expect(launched.map(argv => argv[1])).toEqual(['workspace']);
            expect(await readFile(join(clone.targetRoot, 'sentinel.txt'), 'utf8')).toBe('selected branch\n');
            expect(runGit(clone.targetRoot, ['branch', '--show-current'])).toBe('project-files');
            expect(clone.baseline?.entries.map(entry => entry.relativePath)).toContain('sentinel.txt');
            expect(clone.baseline?.entries.some(entry => entry.relativePath === '.git' || entry.relativePath.startsWith('.git/'))).toBe(false);
        } finally { await forge.close(); }
    });

    it.each(['available', 'unavailable', 'unavailable-bare'] as const)('keeps Git panel hooks on an %s target when a requester host runner is selected', async availability => {
        const repository = join(root, `scm-panel-${availability}`);
        await mkdir(repository);
        execFileSync('git', ['init', '-q'], { cwd: repository });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repository });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: repository });
        const hook = join(repository, '.git/hooks/pre-commit');
        await writeFile(hook, '#!/bin/sh\nif [ "$HAPPIER_TEST_SCM_LOCATION" = target ]; then printf target > .git/target-execution; else printf host > .git/host-escape; fi\n');
        await chmod(hook, 0o755);
        const unavailable = availability !== 'available'
            ? openSessionHolderWorkspaceClient(join(directory, 'missing-primary.sock'), target) : null;
        try {
            const source = createHolderWorkspaceSource({ id: `target:scm-${availability}`, rootPath: root,
                holder: unavailable ?? holder, helperPath: helperExecutable! });
            const runner = createHostScmCommandRunner({ isCurrent: () => true,
                agentIsolation: { read: () => ({ enabled: false,
                    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }) } });
            const git = availability === 'unavailable-bare' ? 'git' : await realpath(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
            const outcome = await runWithScmCommandOperation(undefined, () => runWithRequesterScmCommandRunner(runner,
                () => runWithWorkspaceSource(source, () => runScmCommand({ bin: git, cwd: repository,
                    args: ['commit', '--allow-empty', '-qm', 'panel commit'] }))))
                .then(result => ({ result }), (error: unknown) => ({ error }));
            expect(await readFile(join(repository, '.git/host-escape'), 'utf8').catch(() => null)).toBeNull();
            if (availability === 'available') {
                expect(outcome).toMatchObject({ result: { success: true, exitCode: 0 } });
                expect(await readFile(join(repository, '.git/target-execution'), 'utf8')).toBe('target');
                const destination = join(root, 'published.git');
                execFileSync('git', ['init', '--bare', '-q', destination]);
                await writeFile(join(repository, '.git/hooks/pre-push'), await readFile(hook));
                await chmod(join(repository, '.git/hooks/pre-push'), 0o755);
                await rm(join(repository, '.git/target-execution'));
                const published = await runWithRequesterScmCommandRunner(runner, () => runWithWorkspaceSource(source,
                    () => runScmCommand({ bin: 'git', cwd: repository, args: ['push', destination, 'HEAD:refs/heads/published'] })));
                expect(published).toMatchObject({ success: true });
                expect(await readFile(join(repository, '.git/target-execution'), 'utf8')).toBe('target');
                expect(await readFile(join(repository, '.git/host-escape'), 'utf8').catch(() => null)).toBeNull();
            } else {
                expect(outcome).toMatchObject({ error: { actionErrorCode: 'agent_cli_target_unavailable' } });
                await expect(readFile(join(repository, '.git/target-execution'))).rejects.toMatchObject({ code: 'ENOENT' });
            }
        } finally { unavailable?.detach(); }
    });
});
