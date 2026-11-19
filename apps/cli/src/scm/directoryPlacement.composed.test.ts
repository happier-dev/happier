import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { registerManagedWorkspaceTarget, registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createScmBackendRegistry } from '@/scm/registry';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ScmWorkspaceWatchResponseSchema } from '@happier-dev/protocol/scm';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
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

it.skipIf(process.platform !== 'linux' || !holderPath || !helperPath)(
    'F2: managed Project Push uses its recorded repository source and refuses a Project without one', async () => {
        const rootPath = await mkdtemp(join(tmpdir(), 'managed-scm-push-'));
        const lifetime = new AbortController();
        const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'push-project', managedId: 'guest',
            controller: { machineId: 'controller', installationId: 'install' }, rootPath } as const;
        const holderExits: Promise<number | null>[] = [];
        try {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: rootPath, stdio: 'pipe' });
            git('init', '-q', '--initial-branch=main');
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
            git('remote', 'add', 'origin', 'https://github.com/example/checkout.git');
            registerManagedWorkspaceTarget({ workspace, target: { lifetime: lifetime.signal,
                holderPath: holderPath!, helperPath: helperPath!, openChannel(argv) {
                    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                    holderExits.push(new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }));
                    return Duplex.from({ readable: child.stdout, writable: child.stdin });
                } } });
            const source = ProjectSourceV1Schema.parse({ id: 'confirmed-source', revision: 1, name: 'Confirmed',
                createdByAccountId: 'owner', audience: [], repository: {
                    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'example/confirmed', cloneUrl: 'https://github.com/example/confirmed.git' },
                    protocol: 'https',
                } });
            const registration = createGitScmBackendRuntimeRegistration();
            const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
                definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
                executableDefinition: registration.runtime!, registration,
                scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true }),
                hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }),
            })]);
            const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
                resolveWorkspaceTarget: resolveSessionTargetWorkspace });
            const handlers = new Map<string, RpcHandler>();
            let recordedSource = source.repository;
            const deps = { registry, machineId: 'controller', selectWorkspaceSource: admission.selectWorkspaceSource,
                admitWorkspaceSource: admission.rpc, readManagedProjectRepository: async () => recordedSource };
            registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, rootPath, deps);
            const context: RpcHandlerContext = { signal: lifetime.signal, callerAuthority: 'present_user',
                machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller',
                    installationId: 'install', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
            const push = () => handlers.get(RPC_METHODS.SCM_REMOTE_PUSH)!({ v: 1, kind: 'targeted_action_rpc',
                target: workspace, input: { cwd: rootPath, remote: 'origin', branch: 'main', outcomeVersion: 1 } }, context);
            const changed = await push();
            expect(changed, JSON.stringify(changed)).toMatchObject({ success: false, errorCode: 'SCM_SOURCE_CHANGED' });
            recordedSource = undefined;
            await expect(push()).resolves.toMatchObject({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED' });
        } finally {
            lifetime.abort();
            await Promise.all(holderExits);
            await rm(rootPath, { recursive: true, force: true });
        }
    }, 30_000,
);

it('refuses an exact managed SCM request when the guest source is not registered', async () => {
    const handlers = new Map<string, RpcHandler>();
    const admission = createFilesystemEffectAdmission({});
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); } }, process.cwd(),
        { machineId: 'controller', selectWorkspaceSource: admission.selectWorkspaceSource });
    const request = { v: 1, kind: 'targeted_action_rpc', input: { cwd: process.cwd() }, target: {
        v: 2, kind: 'managed', serverId: 'home', workspaceId: 'project', managedId: 'guest',
        controller: { machineId: 'controller', installationId: 'install' }, rootPath: process.cwd(),
    } };
    await expect(handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT)!(request, undefined)).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
});

it('refuses an unadmitted SCM requester before opening a registered managed workspace', async () => {
    const lifetime = new AbortController();
    const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'project', managedId: 'guest',
        controller: { machineId: 'controller', installationId: 'install' }, rootPath: process.cwd() } as const;
    const handlers = new Map<string, RpcHandler>();
    const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
    let channels = 0;
    try {
        registerManagedWorkspaceTarget({ workspace, target: { lifetime: lifetime.signal, holderPath: 'holder', helperPath: 'helper',
            openChannel() { channels += 1; throw new Error('Unexpected guest channel'); } } });
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); } }, process.cwd(),
            { machineId: 'controller', selectWorkspaceSource: admission.selectWorkspaceSource, admitWorkspaceSource: admission.rpc });
        const response = await handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT)!({ v: 1, kind: 'targeted_action_rpc',
            input: { cwd: process.cwd() }, target: workspace }, { signal: lifetime.signal });
        expect(response).toMatchObject({ success: false, actionErrorCode: 'filesystem_identity_custody_unavailable' });
        expect(channels).toBe(0);
    } finally { lifetime.abort(); }
});

it('F2: a managed Project watch cannot observe a same-path fallback or bypass requester admission', async () => {
    const lifetime = new AbortController();
    const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'watch-project', managedId: 'guest',
        controller: { machineId: 'controller', installationId: 'install' }, rootPath: process.cwd() } as const;
    const handlers = new Map<string, RpcHandler>();
    const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); } }, process.cwd(),
        { machineId: 'controller', selectWorkspaceSource: admission.selectWorkspaceSource, admitWorkspaceSource: admission.rpc });
    const observe = () => handlers.get(RPC_METHODS.SCM_WORKSPACE_WATCH)!({ directory: workspace.rootPath, workspace }, { signal: lifetime.signal });
    try {
        await expect(observe()).resolves.toMatchObject({ status: 'unavailable', reason: { code: 'workspace_target_unavailable' } });
        let channels = 0;
        registerManagedWorkspaceTarget({ workspace, target: { lifetime: lifetime.signal, holderPath: 'holder', helperPath: 'helper',
            openChannel() { channels += 1; throw new Error('An unadmitted watch opened a guest channel'); } } });
        await expect(observe()).resolves.toMatchObject({ status: 'unavailable', reason: { code: 'filesystem_identity_custody_unavailable' } });
        expect(channels).toBe(0);
    } finally { lifetime.abort(); }
});

it.skipIf(process.platform !== 'linux' || !holderPath || !helperPath)(
    'F2: a managed Project watch receives guest Git changes over one holder until presentation ends', async () => {
        const rootPath = await mkdtemp(join(tmpdir(), 'managed-scm-watch-'));
        const guestLifetime = new AbortController();
        const presentation = new AbortController();
        const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'native-watch-project', managedId: 'guest',
            controller: { machineId: 'controller', installationId: 'install' }, rootPath } as const;
        const holderExits: Promise<number | null>[] = [];
        let parked: Promise<unknown> | undefined;
        try {
            const tracked = join(rootPath, 'notes.txt');
            await writeFile(tracked, 'first\n');
            const git = (...args: string[]) => execFileSync('git', args, { cwd: rootPath, stdio: 'pipe' });
            git('init', '-q');
            git('add', 'notes.txt');
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
            registerManagedWorkspaceTarget({ workspace, target: { lifetime: guestLifetime.signal,
                holderPath: holderPath!, helperPath: helperPath!, openChannel(argv) {
                    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                    holderExits.push(new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }));
                    return Duplex.from({ readable: child.stdout, writable: child.stdin });
                } } });
            const registration = createGitScmBackendRuntimeRegistration();
            const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
                definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
                executableDefinition: registration.runtime!, registration,
                scmCommandRunner: createHostScmCommandRunner({ isCurrent: () => true }),
                hostingProviderRuntimeServices: createHostScmHostingProviderRuntimeServices({ contributes: {}, scmHostingProvidersById: new Map() }),
            })]);
            const handlers = new Map<string, RpcHandler>();
            const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
                resolveWorkspaceTarget: resolveSessionTargetWorkspace });
            registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, rootPath,
                { registry, machineId: 'controller', selectWorkspaceSource: admission.selectWorkspaceSource, admitWorkspaceSource: admission.rpc });
            const context: RpcHandlerContext = { signal: presentation.signal, callerAuthority: 'present_user',
                machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller', installationId: 'install',
                    role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
            const observe = (observation: { observationOnly?: true; sinceRevision?: number } = {}) =>
                handlers.get(RPC_METHODS.SCM_WORKSPACE_WATCH)!({ directory: rootPath, workspace, ...observation }, context);
            parked = observe({ observationOnly: true });
            const ready = ScmWorkspaceWatchResponseSchema.parse(await observe());
            expect(ready.status, JSON.stringify(ready)).toBe('ready');
            if (ready.status !== 'ready') throw new Error('The guest did not start its workspace watch');
            const next = observe({ sinceRevision: ready.revision });
            await writeFile(tracked, 'changed in the guest\n');
            await expect(next).resolves.toMatchObject({ status: 'changed' });
            expect(holderExits).toHaveLength(1);
            presentation.abort();
            await expect(parked).resolves.toEqual({ status: 'cancelled' });
            await expect(holderExits[0]).resolves.toBe(0);
        } finally {
            presentation.abort();
            guestLifetime.abort();
            if (parked) await Promise.allSettled([parked, ...holderExits]);
            await rm(rootPath, { recursive: true, force: true });
        }
    },
);

describe.skipIf(process.platform !== 'linux' || !holderPath || !helperPath)('directory-only daemon SCM placement', () => {
    const status = { method: RPC_METHODS.SCM_STATUS_SNAPSHOT, operation: {} };
    const commit = { method: RPC_METHODS.SCM_COMMIT_CREATE, operation: { message: 'panel change', scope: { kind: 'all-pending' } } };
    const comparison = { method: RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, operation: { source: { kind: 'workingTree' } } };
    const diff = { method: RPC_METHODS.SCM_DIFF_FILE, operation: { path: 'notes.txt', area: 'pending' } };
    const push = { method: RPC_METHODS.SCM_REMOTE_PUSH, operation: { remote: 'origin', branch: 'main' } };
    it.each([
        ...[true, false].flatMap(placed => [status, commit, push].map(request => ({ placed, caller: 'none', ...request }))),
        // SEC1116H §4b: Manage on a member's folder whose placed Session shares the root.
        ...[status, commit].map(request => ({ placed: true, caller: 'manage', ...request })),
        // SEC1116I item 1: the member's own read of their placed root; another member stays in their own child.
        { placed: true, caller: 'member', ...status },
        { placed: true, caller: 'other-member', ...status },
        // SEC2: comparison capture must share the placed-root owner decision.
        { placed: true, caller: 'member', ...comparison },
        { placed: true, caller: 'other-member', ...comparison },
        ...[diff, commit].map(request => ({ placed: true as const, caller: 'none' as const, disjointRoots: true, ...request })),
    ] as const)('keeps $method hooks at their workspace authority (placed=$placed, caller=$caller, disjoint=$disjointRoots)', async (fixture) => {
        const { placed, caller, method, operation } = fixture;
        const disjointRoots = 'disjointRoots' in fixture;
        const directory = await mkdtemp(join(tmpdir(), 'scm-directory-'));
        const root = join(directory, 'workspace-sync');
        const addressedRoot = disjointRoots ? join(directory, 'controller') : root;
        const destination = join(directory, 'destination.git');
        const lifetime = new AbortController();
        const controllerIndex = join(addressedRoot, '.git/index');
        const controllerLock = `${controllerIndex}.lock`;
        let controllerIndexBefore: Buffer | undefined;
        let agent: SessionHolderChild | undefined;
        let containerId: string | undefined;
        try {
            await mkdir(root);
            if (disjointRoots) {
                await mkdir(addressedRoot);
                await writeFile(join(addressedRoot, 'notes.txt'), 'controller-only\n');
                const controllerGit = (...args: string[]) => execFileSync('git', args, { cwd: addressedRoot, stdio: 'pipe' });
                controllerGit('init', '-q', '-b', 'main');
                controllerGit('add', 'notes.txt');
                controllerIndexBefore = await readFile(controllerIndex);
                await writeFile(controllerLock, 'controller Git owns this lock\n');
            }
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
            if (disjointRoots && method === RPC_METHODS.SCM_COMMIT_CREATE) {
                const hook = join(root, '.git/hooks/commit-msg');
                await writeFile(hook, '#!/bin/sh\ntest "$GIT_EDITOR" = : && test -f "$GIT_INDEX_FILE" || exit 1\nprintf "\\nplaced hook\\n" >> "$1"\n');
                await chmod(hook, 0o755);
            }
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
                    primarySocketPath, target: { ...target, lifetime: lifetime.signal, helperPath: helperPath! }, workspace: { hostRoot: addressedRoot, targetRoot } });
            }
            const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
            if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT && placed) {
                const source = await admission.selectWorkspaceSource(undefined, { cwd: root });
                expect(source).toMatchObject({ kind: 'target', id: expect.stringContaining(':directory-rpc-session') });
                await mkdir(join(root, 'nested'));
                const alias = join(directory, 'alias');
                await symlink(root, alias);
                for (const cwd of [join(root, 'nested'), join(root, 'not-created'), join(alias, 'nested')]) {
                    expect((await admission.selectWorkspaceSource(undefined, { cwd })).kind).toBe('target');
                }
                expect((await admission.selectWorkspaceSource(undefined, { cwd: `${root}-sibling` })).kind).toBe('local');
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
            registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, addressedRoot,
                { registry, ...(disjointRoots ? { machineId: 'machine' } : {}), selectWorkspaceSource: admission.selectWorkspaceSource,
                    actionExecutor: createActionExecutor({ scmActionExecute: input => executeScmActionOperation({
                        ...input, actionContext: input.context, workingDirectory: addressedRoot, accessPolicy: { kind: 'osUser' }, registry,
                    }) }),
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
            const statusResponse = disjointRoots ? await handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT)!({ cwd: addressedRoot }) : null;
            if (disjointRoots) expect(statusResponse, JSON.stringify(statusResponse)).toMatchObject({
                success: true,
                snapshot: { repo: { rootPath: addressedRoot, worktrees: expect.arrayContaining([
                    expect.objectContaining({ path: addressedRoot, isCurrent: true, isMain: true }),
                ]) } },
            });
            const request = {
                cwd: statusResponse?.snapshot?.repo.rootPath ?? addressedRoot, ...operation,
            };
            const addressedRequest = disjointRoots
                ? createTargetedActionRpcRequestV1({ ...request, outcomeVersion: 1 }, { kind: 'machine', machineId: 'machine',
                    project: { machineId: 'machine', directory: addressedRoot } })
                : request;
            if (disjointRoots && method === RPC_METHODS.SCM_COMMIT_CREATE) {
                const targetLock = join(root, '.git/index.lock');
                const previousHead = git('rev-parse', 'HEAD').toString().trim();
                await writeFile(targetLock, 'terminal Git owns this lock\n');
                const refused = await handlers.get(method)!(addressedRequest);
                expect(refused, JSON.stringify(refused)).toMatchObject({
                    success: false, errorCode: 'INDEX_LOCKED',
                    publication: { state: 'not_published', expectedHeadOid: previousHead },
                });
                expect(git('rev-parse', 'HEAD').toString().trim()).toBe(previousHead);
                await expect(readFile(targetLock, 'utf8')).resolves.toBe('terminal Git owns this lock\n');
                await rm(targetLock);
            }
            const response = await handlers.get(method)!(addressedRequest,
                caller !== 'none' ? { signal: new AbortController().signal, localActionContext: { authority: 'present_user', runtimeAccountId:
                    caller === 'member' ? requester.accountId : 'other-member-account' } } : undefined);
            if (caller === 'other-member') {
                // Another person's placed root is never reached through its holder; their own child decides.
                expect(memberLaunches).toEqual([method]);
                if (method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
                    expect(ScmComparisonCaptureOutputSchema.parse(response)).toMatchObject({
                        success: false,
                        errorCode: 'DIFF_UNAVAILABLE',
                        effectAttempted: false,
                        failureCause: { phase: 'scm.requester.native_preparation', errorCode: 'agent_isolation_unavailable' },
                    });
                } else {
                    expect(response).toMatchObject({ success: false, actionErrorCode: 'agent_isolation_unavailable' });
                }
                await expect(readFile(join(root, '.git/executions'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                return;
            }
            expect(memberLaunches).toEqual([]);
            if (disjointRoots) {
                expect(response, JSON.stringify(response)).toMatchObject({ success: true });
                expect(statusResponse.snapshot.repo.rootPath).toBe(addressedRoot);
                if (method === RPC_METHODS.SCM_DIFF_FILE) {
                    expect(response.diff).toContain('+changed');
                    expect(response.diff).not.toContain('controller-only');
                } else {
                    expect(response.publication).toMatchObject({ state: 'published', indexReconciliation: 'reconciled' });
                    expect(git('show', 'HEAD:notes.txt').toString()).toBe('changed\n');
                    expect(git('log', '-1', '--format=%B').toString().trim()).toBe('panel change\n\nplaced hook');
                    expect(git('-c', 'core.fsmonitor=false', 'status', '--porcelain').toString()).toBe('');
                }
                await expect(readFile(join(addressedRoot, 'notes.txt'), 'utf8')).resolves.toBe('controller-only\n');
                await expect(readFile(controllerIndex)).resolves.toEqual(controllerIndexBefore);
                await expect(readFile(controllerLock, 'utf8')).resolves.toBe('controller Git owns this lock\n');
            }
            // A target may refuse a capability, but must never retry it on the host.
            if (method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
                expect(response, JSON.stringify(response)).toMatchObject({ comparison: { inventory: {
                    files: [expect.objectContaining({ path: 'notes.txt' })],
                } } });
            } else expect(response, JSON.stringify(response)).toMatchObject({ success: placed ? expect.any(Boolean) : true });
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
