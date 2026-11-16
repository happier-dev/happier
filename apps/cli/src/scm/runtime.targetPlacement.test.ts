import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { attachSessionHolderWorkspaceClient, openSessionHolderWorkspaceClient, spawnSessionHolderChild, type SessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';
import { createHostScmCommandRunner, runScmCommand, runWithRequesterScmCommandRunner } from '@/scm/runtime';
import { runWithScmCommandOperation } from '@/scm/commandOperation';

import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';

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
