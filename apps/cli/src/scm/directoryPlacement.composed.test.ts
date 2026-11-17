import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import type { RpcHandler } from '@/api/rpc/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createHostScmCommandRunner } from '@/scm/runtime';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSessionHolderChild, type SessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';
import { createGitScmBackendRuntimeRegistration } from '../../../../packages/plugins/scm-git/src/backend';

const holderPath = resolveSessionHolderExecutablePath();
const helperPath = resolveProcessCustodySupportExecutable('linux');
const devcontainerImage = process.env.HAPPIER_TEST_SCM_DEVCONTAINER_IMAGE;
const dockerPath = process.env.HAPPIER_TEST_SCM_DOCKER_BIN ?? 'docker';

describe.skipIf(process.platform !== 'linux' || !holderPath || !helperPath)('directory-only daemon SCM placement', () => {
    const status = { method: RPC_METHODS.SCM_STATUS_SNAPSHOT, operation: {} };
    const commit = { method: RPC_METHODS.SCM_COMMIT_CREATE, operation: { message: 'panel change', scope: { kind: 'all-pending' } } };
    const push = { method: RPC_METHODS.SCM_REMOTE_PUSH, operation: { remote: 'origin', branch: 'main' } };
    it.each([
        ...[true, false].flatMap(placed => [status, commit, push].map(request => ({ placed, caller: 'none', ...request }))),
        // SEC1116H §4b: Manage on a member's folder whose placed Session shares the root.
        ...[status, commit].map(request => ({ placed: true, caller: 'manage', ...request })),
        // SEC1116I item 1: the member's own read of their placed root; another member stays in their own child.
        { placed: true, caller: 'member', ...status },
        { placed: true, caller: 'other-member', ...status },
    ] as const)('keeps $method hooks at their workspace authority (placed=$placed, caller=$caller)', async ({ placed, caller, method, operation }) => {
        const directory = await mkdtemp(join(tmpdir(), 'scm-directory-'));
        const root = join(directory, 'workspace-sync');
        const destination = join(directory, 'destination.git');
        const lifetime = new AbortController();
        let agent: SessionHolderChild | undefined;
        let containerId: string | undefined;
        try {
            await mkdir(root);
            const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
            git('init', '-q', '-b', 'main');
            git('config', 'user.name', 'Test');
            git('config', 'user.email', 'test@example.com');
            await writeFile(join(root, 'notes.txt'), 'initial\n');
            git('add', 'notes.txt');
            git('commit', '-qm', 'initial');
            git('init', '--bare', '-q', destination);
            git('remote', 'add', 'origin', destination);
            for (const hook of ['pre-commit', 'pre-push', 'fsmonitor']) {
                const file = join(root, '.git/hooks', hook);
                await writeFile(file, '#!/bin/sh\nprintf "%s\\n" "${HAPPIER_TEST_SCM_LOCATION:-host}" >> .git/executions\n');
                await chmod(file, 0o755);
            }
            // Git runs the monitor from the worktree, so one relative path serves host and target.
            git('config', 'core.fsmonitor', '.git/hooks/fsmonitor');
            await writeFile(join(root, 'notes.txt'), 'changed\n');
            if (placed) {
                if (devcontainerImage) {
                    // Devcontainer's image workspaceFolder mode binds this host root at /workspace.
                    // Mount only the packaged native tools beside that real shared workspace.
                    const toolRoots = [...new Set([dirname(holderPath!), dirname(helperPath!)])];
                    containerId = execFileSync(dockerPath, ['run', '--detach', '--pull=never',
                        '--user', `${process.getuid!()}:${process.getgid!()}`,
                        '--mount', `type=bind,source=${root},target=/workspace`,
                        ...toolRoots.flatMap(path => ['--mount', `type=bind,source=${path},target=${path},readonly`]),
                        '--workdir', '/workspace', '--entrypoint', 'sleep', devcontainerImage, '600'], { encoding: 'utf8' }).trim();
                    const mounts: unknown = JSON.parse(execFileSync(dockerPath,
                        ['inspect', '--format', '{{json .Mounts}}', containerId], { encoding: 'utf8' }));
                    expect(mounts).toEqual(expect.arrayContaining([expect.objectContaining({
                        Type: 'bind', Source: root, Destination: '/workspace',
                    })]));
                }
                const inTarget = (argv: readonly string[]) => containerId
                    ? [dockerPath, 'exec', '-i', '-e', 'HAPPIER_TEST_SCM_LOCATION=target', containerId, ...argv]
                    : [...argv];
                // Provider process/channel boundaries are real local processes; the shared
                // directory and distinct environment also expose the escape without Docker.
                const target: SessionHolderTarget = {
                    id: devcontainerImage ? 'devcontainer:directory-bind' : 'directory-rpc-target',
                    holderPath: holderPath!, socketDirectory: containerId ? '/tmp' : directory,
                    exec: command => new Promise((resolve, reject) => {
                        const argv = inTarget(['sh', '-c', command]);
                        const child = spawn(argv[0]!, argv.slice(1), { env: { ...process.env, HAPPIER_TEST_SCM_LOCATION: 'target' } });
                        let stdout = ''; let stderr = '';
                        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
                        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
                        child.once('error', reject);
                        child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
                    }),
                    openChannel: argv => {
                        const command = inTarget(argv);
                        const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                        const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
                        child.once('close', () => channel.destroy());
                        return channel;
                    },
                };
                const primarySocketPath = containerId ? '/tmp/scm-primary.sock' : join(directory, 'primary.sock');
                const targetRoot = containerId ? '/workspace' : root;
                agent = spawnSessionHolderChild({ executablePath: holderPath!, socketPath: primarySocketPath,
                    command: 'sleep', args: ['600'], cwd: targetRoot, target });
                await new Promise<void>((resolve, reject) => { agent!.once('spawn', resolve); agent!.once('error', reject); });
                registerSessionTargetWorkspace({ sessionId: 'directory-rpc-session', lifetime: lifetime.signal,
                    primarySocketPath, target: { ...target, helperPath: helperPath! }, workspace: { hostRoot: root, targetRoot } });
            }
            const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
            if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT && placed) {
                const source = admission.selectWorkspaceSource(undefined, { cwd: root });
                expect(source).toMatchObject({ kind: 'target', id: expect.stringContaining(':directory-rpc-session') });
                await mkdir(join(root, 'nested'));
                const alias = join(directory, 'alias');
                await symlink(root, alias);
                for (const cwd of [join(root, 'nested'), join(root, 'not-created'), join(alias, 'nested')]) {
                    expect(admission.selectWorkspaceSource(undefined, { cwd }).kind).toBe('target');
                }
                expect(admission.selectWorkspaceSource(undefined, { cwd: `${root}-sibling` }).kind).toBe('local');
            }
            const registration = createGitScmBackendRuntimeRegistration();
            const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
                definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
                executableDefinition: registration.runtime!, registration,
                scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true }),
                hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }),
            })]);
            const handlers = new Map<string, RpcHandler>();
            // The member child is a separate OS account; reaching it at all means the member's own
            // host account would run the placed Session's hooks.
            const memberLaunches: string[] = [];
            const requester = { serverId: 'home', accountId: 'member-account', machineId: 'machine', installationId: 'installation' };
            registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, root,
                { registry, selectWorkspaceSource: admission.selectWorkspaceSource,
                    ...(caller !== 'none' ? {
                        resolveRequester: async () => ({ identity: caller === 'manage'
                            ? { kind: 'owner_person' as const, requester: { ...requester, accountId: 'owner-account' } }
                            : { kind: 'isolated' as const, separationRequired: true,
                                requester: caller === 'member' ? requester : { ...requester, accountId: 'other-member-account' } },
                            dispose: async () => {} }),
                        nativeOperationRuntime: {
                            readMemberFolderOwner: async () => ({ kind: 'isolated' as const, separationRequired: true, requester }),
                            prepareNativeOperation: (async () => {
                                memberLaunches.push(method);
                                throw Object.assign(new Error('member child'), { code: 'agent_isolation_unavailable' });
                            }) as unknown as ApiMachineClient['prepareNativeOperation'],
                        },
                    } : {}) });
            const response = await handlers.get(method)!({ cwd: root, ...operation },
                caller !== 'none' ? { signal: new AbortController().signal } : undefined);
            if (caller === 'other-member') {
                // Another person's placed root is never reached through its holder; their own child decides.
                expect(memberLaunches).toEqual([method]);
                await expect(readFile(join(root, '.git/executions'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                return;
            }
            expect(memberLaunches).toEqual([]);
            // A target may refuse a capability, but must never retry it on the host.
            expect(response, JSON.stringify(response)).toMatchObject({ success: placed ? expect.any(Boolean) : true });
            const executions = await readFile(join(root, '.git/executions'), 'utf8');
            expect(executions.split('\n').filter(Boolean)).toEqual(expect.arrayContaining([placed ? 'target' : 'host']));
            if (placed) expect(executions.split('\n')).not.toContain('host');
        } finally {
            lifetime.abort();
            await agent?.terminateGroup({ graceMs: 100 });
            if (containerId) execFileSync(dockerPath, ['rm', '--force', containerId], { stdio: 'pipe' });
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
