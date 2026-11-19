import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createScmBackendRegistry } from '@/scm/registry';
import type { ManagedSessionTargetRequest } from '@/machines/managed/acquire';
import { connectSessionTarget } from '@/subprocess/supervision/sessionTargetRelay';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';

import { createSessionHolderSocketPath } from '@/subprocess/supervision/sessionHolder';
import { resolveSessionTargetWorkspaceTransfer } from '@/daemon/sessions/sessionTargetWorkspaces';

import { deliverSessionTargetLaunch, observeSessionTargetRunnerExit, prepareSessionTargetPlacement, projectSessionTargetLaunchFailure, restoreSessionTargetRelay } from './prepareSessionTargetPlacement';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/**
 * The spawn owner places a Session on a managed target: the target's custody is
 * the managed driver (its own tests); here it is the provider boundary. The
 * placement lives exactly as long as the launch's resources: a failed spawn or
 * the Session's exit ends the authority and removes the relay.
 */
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fakeCustody() {
    const requests: ManagedSessionTargetRequest[] = [];
    return { requests, open: async (request: ManagedSessionTargetRequest) => {
        requests.push(request);
        return { id: 'managed:row-1', lifetime: request.lifetime, holderPath: '/g/.happier/holder/v/happier-session-holder', helperPath: '/g/h', socketDirectory: '/g/run',
            home: '/g', platform: { os: 'linux' as const, arch: 'x64' as const, home: '/g' },
            exec: async (command: string) => ({ status: 0, stdout: `ran:${command}`, stderr: '' }),
            putFile: async () => undefined,
            ensureWorkspaceRuntime: async () => ({ binaryPath: '/g/.happier/happier' }),
            openChannel: () => new PassThrough() };
    } };
}

type SessionTargetAgent = NonNullable<Parameters<typeof deliverSessionTargetLaunch>[0]['agent']>;

/**
 * The Session's Agent as the spawn's leased runtime registry holds it (catalog facts under `contributes`), with only the
 * members the launch step reads; the full registry needs a materialized plugin runtime this owner does not use.
 */
function leasedAgent(id: string, secretEntries: readonly string[], runtimeSpec?: object): SessionTargetAgent {
    const sharing = { authIsolation: { mode: 'materialized_home', secretEntries } };
    const catalog = { contributes: { agentDefinitionsById: new Map(runtimeSpec ? [[id, { runtimeSpec }]] : []), catalogEntriesById: {} },
        acquireAgentCatalogEntry: async (agentId: string) => agentId === id ? { getConnectedServiceStateSharingDescriptor: async () => sharing } : null };
    return { id, catalog: catalog as unknown as SessionTargetAgent['catalog'] };
}

/** The placement's Session-end steps as the placement runs them (latest first). */
function sessionEnd() {
    const steps: Array<() => Promise<void>> = [];
    return { onSessionEnd: (step: () => Promise<void>) => { steps.push(step); },
        end: async () => { for (const step of [...steps].reverse()) await step(); } };
}

describe('Session placement on a managed target at spawn', () => {
    it.each([false, true])('retains only public acquisition refusal evidence before a runner exists (typed %s)', async typed => {
        const failure = { ok: false as const, errorCode: 'provider_unavailable', error: 'The compute provider is temporarily unavailable',
            requestId: 'native-request', effectAttempted: false,
            failureCause: projectActionFailureCauseV1(Object.assign(new Error('unavailable'), { code: 'provider_unavailable', status: 503 }), 'machines.native.acquire') };
        const error = typed ? ManagedMachineControllerError.fromActionFailure(failure, 'machines.managed.acquire')
            : Object.assign(new Error('PRIVATE_NATIVE_OUTPUT'), { code: 'provider_unavailable' });
        const result = await prepareSessionTargetPlacement({ request: { managedId: 'managed' }, sessionKey: 'refused', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => null, runnerExit: Promise.resolve(),
            launchResourceScope: createProviderLaunchResourceScope({ onCleanupError: () => undefined }),
            openManagedSessionTarget: async () => { throw error; } });
        expect(result).toMatchObject({ ok: false, result: { errorDetail: { kind: 'launch_error', code: failure.errorCode,
            message: typed ? failure.error : failure.errorCode,
            ...(typed ? { failureCause: { actionCause: failure.failureCause, requestId: 'native-request' } } : {}),
        } } });
        expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_OUTPUT');
    });

    it.each(['copy_once', 'sync'] as const)('retains the exact %s native workspace identity even when kept reuse has no baseline in memory', async kind => {
        const target = await fakeCustody().open({} as ManagedSessionTargetRequest);
        const sourceWorkspace = { serverId: 'home', machineId: 'original', workspaceId: 'source', rootPath: 'C:\\Users\\person\\project' };
        const targetWorkspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'native-workspace',
            managedId: 'row-1', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/guest/kept' };
        const contentPolicyDigest = computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'all_files',
            extraIncludePatterns: [], extraIgnorePatterns: [] });
        let retained: unknown;
        const launch = await deliverSessionTargetLaunch({ target, sessionKey: 'kept', runnerEnvironment: {},
            materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null, agent: null,
            workspace: { hostRoot: sourceWorkspace.rootPath, targetRoot: '/requested' }, onSessionEnd() {},
            projectFiles: { activeServerDir: '/unused', projectFilesSourceWorkspace: sourceWorkspace,
                ...(kind === 'sync' ? { selection: { kind, mode: 'keep_synced' as const } } : {}),
                prepareSource: async () => ({ targetRootPath: targetWorkspace.rootPath, targetWorkspace, contentPolicyDigest }),
                prepareSync: async () => ({ relationshipId: 'existing-sync', targetWorkspace, contentPolicyDigest }),
                onWorkspaceSeed: (baseline, address, digest?: string) => { retained = { baseline, address, contentPolicyDigest: digest }; } } });
        expect(launch.workspace).toEqual({ hostRoot: sourceWorkspace.rootPath, targetRoot: targetWorkspace.rootPath });
        expect(retained).toEqual({ baseline: undefined, address: targetWorkspace, contentPolicyDigest });
    });

    it.each(['copy_once', 'sync'] as const)('delivers the reviewed content policy to the native %s Project child', async kind => {
        const target = await fakeCustody().open({} as ManagedSessionTargetRequest);
        const sourceWorkspace = { serverId: 'home', machineId: 'original', workspaceId: 'source', rootPath: '/original/project' };
        const fields = { v: 1 as const, selection: 'git_worktree' as const,
            extraIncludePatterns: ['.env.example'], extraIgnorePatterns: ['private/**'] };
        const contentPolicy = { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) };
        // Reviewed Project SOURCE/TARGET calls are the remote transport boundary.
        const refused = Object.assign(new Error('Observed reviewed native Project request'), { code: 'observed_policy' });
        const inspect = async (request: { contentPolicy?: unknown }) => {
            expect(request.contentPolicy).toEqual(contentPolicy);
            throw refused;
        };
        await expect(deliverSessionTargetLaunch({ target, sessionKey: 'policy', runnerEnvironment: {},
            materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null, agent: null,
            workspace: { hostRoot: sourceWorkspace.rootPath, targetRoot: sourceWorkspace.rootPath }, onSessionEnd() {},
            projectFiles: { activeServerDir: '/unused', projectFilesSourceWorkspace: sourceWorkspace,
                selection: kind === 'sync' ? { kind, mode: 'keep_synced', contentPolicy } : { kind, contentPolicy },
                prepareSource: inspect, prepareSync: inspect } })).rejects.toBe(refused);
    });

    it('refuses an admitted remote source without its transport instead of reading that path on the controller', async () => {
        const target = await fakeCustody().open({} as ManagedSessionTargetRequest);
        const sourceWorkspace = { serverId: 'home', machineId: 'original-machine', workspaceId: 'original-workspace',
            rootPath: '/original-machine/project-does-not-exist' };
        await expect(deliverSessionTargetLaunch({ target, sessionKey: 'remote-source', runnerEnvironment: {},
            materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null, agent: null,
            workspace: { hostRoot: sourceWorkspace.rootPath, targetRoot: sourceWorkspace.rootPath }, onSessionEnd: () => undefined,
            projectFiles: { activeServerDir: '/unused', projectFilesSourceWorkspace: sourceWorkspace,
                projectFilesSource: { target: { serverId: 'home', machineId: 'original-machine' }, directory: sourceWorkspace.rootPath } } }))
            .rejects.toMatchObject({ code: 'workspace_source_operation_unavailable' });
    });

    it('delivers the chosen project before launching and maps the Session to its materialized guest root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'stp-files-')); directories.push(root);
        const hostRoot = join(root, 'host');
        const home = join(root, 'guest');
        await mkdir(hostRoot); await mkdir(home);
        await writeFile(join(hostRoot, 'uncommitted.txt'), 'host sentinel');
        const execFile = promisify(execFileCallback);
        const target = { ...(await fakeCustody().open({} as ManagedSessionTargetRequest)), home,
            exec: async (command: string, signal: AbortSignal) => {
                try { const result = await execFile('sh', ['-c', command], { signal }); return { status: 0, ...result }; }
                catch (error) { const result = error as { code?: number; stdout?: string; stderr?: string };
                    return { status: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }; }
            },
            putFile: async (path: string, bytes: Uint8Array) => { await writeFile(path, bytes); },
        };
        const launch = await deliverSessionTargetLaunch({ target, sessionKey: 'project', runnerEnvironment: {},
            materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null, agent: null,
            workspace: { hostRoot, targetRoot: hostRoot }, onSessionEnd: () => undefined,
            projectFiles: { activeServerDir: root, registry: createScmBackendRegistry([]) } });
        expect(launch.workspace?.targetRoot).toMatch(new RegExp(`^${home}/.happier/workspaces/`));
        expect(await readFile(join(launch.workspace!.targetRoot, 'uncommitted.txt'), 'utf8')).toBe('host sentinel');
    });

    it('keeps the target work on sync reconnect and starts transport only after initial materialization', async () => {
        const root = await mkdtemp(join(tmpdir(), 'stp-sync-')); directories.push(root);
        const hostRoot = join(root, 'host'); const home = join(root, 'guest');
        await mkdir(hostRoot); await mkdir(home);
        await writeFile(join(hostRoot, 'work.txt'), 'initial source');
        const execFile = promisify(execFileCallback);
        const target = { ...(await fakeCustody().open({} as ManagedSessionTargetRequest)), home,
            exec: async (command: string, signal: AbortSignal) => {
                try { return { status: 0, ...await execFile('sh', ['-c', command], { signal }) }; }
                catch (error) { const result = error as { code?: number; stdout?: string; stderr?: string };
                    return { status: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }; }
            }, putFile: async (path: string, bytes: Uint8Array) => { await writeFile(path, bytes); } };
        const start = () => deliverSessionTargetLaunch({ target, sessionKey: 'sync-project', runnerEnvironment: {},
            materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null, agent: null,
            workspace: { hostRoot, targetRoot: hostRoot }, onSessionEnd: () => undefined,
            projectFiles: { selection: { kind: 'sync', mode: 'keep_both_in_sync' }, activeServerDir: root,
                registry: createScmBackendRegistry([]),
                // The admitted endpoint transport is the boundary; real finite export runs above it.
                prepareSync: async (input: Readonly<{ sourceRootPath: string; targetRootPath: string }>) => {
                    expect(input.sourceRootPath).toBe(hostRoot);
                    expect(await readFile(join(input.targetRootPath, 'work.txt'), 'utf8')).toBe(expectedGuest);
                    return { relationshipId: 'transport-fixture' };
                } } });
        let expectedGuest = 'initial source';
        const launched = await start();
        await writeFile(join(launched.workspace!.targetRoot, 'work.txt'), 'existing sandbox edit');
        await writeFile(join(hostRoot, 'work.txt'), 'new host edit');
        expectedGuest = 'existing sandbox edit';
        await start();
        expect(await readFile(join(launched.workspace!.targetRoot, 'work.txt'), 'utf8')).toBe('existing sandbox edit');
    });

    it('opens the target under the requester, relays it to the runner, and ends it with the launch resources', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const custody = fakeCustody();
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        const prepared = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open, launchResourceScope: scope, socketPath: join(directory, 'relay.sock') });
        expect(prepared).toMatchObject({ ok: true, placement: { id: 'managed:row-1', holderPath: '/g/.happier/holder/v/happier-session-holder',
            socketDirectory: '/g/run', relaySocketPath: join(directory, 'relay.sock') } });
        expect(custody.requests[0]).toMatchObject({ managedId: 'row-1', sessionId: 'spawn-1', requesterAccountId: 'owner' });
        if (!prepared.ok) throw new Error('unreachable');
        await expect(connectSessionTarget(prepared.placement).exec('true')).resolves.toMatchObject({ stdout: 'ran:true' });

        // The Session exits: its transferred launch resources retire, ending the placement.
        const onExit = scope.transfer();
        await onExit?.();
        await expect.poll(() => custody.requests[0]!.lifetime.aborted).toBe(true);
        await expect.poll(() => existsSync(join(directory, 'relay.sock'))).toBe(false);
    });

    it('a Stop retires the launch resources first; the target stays reachable until the runner has stopped its Agents and exited', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const custody = fakeCustody();
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        let runnerExited!: () => void;
        const runnerExit = new Promise<void>(resolve => { runnerExited = resolve; });
        const prepared = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit, openManagedSessionTarget: custody.open, launchResourceScope: scope,
            socketPath: join(directory, 'relay.sock') });
        if (!prepared.ok) throw new Error('unreachable');
        const endSteps: string[] = [];
        prepared.onSessionEnd(async () => { endSteps.push('remove-session-directory'); });

        // Stop: upstream authority retirement runs the transferred launch resources before the runner is signalled.
        await scope.transfer()?.();
        // The runner stops its target Agent through its holder: the relay still answers.
        await expect(connectSessionTarget(prepared.placement).exec('kill-agent')).resolves.toMatchObject({ stdout: 'ran:kill-agent' });
        expect(custody.requests[0]!.lifetime.aborted).toBe(false);
        expect(endSteps).toHaveLength(0);

        runnerExited();
        await expect.poll(() => custody.requests[0]!.lifetime.aborted).toBe(true);
        expect(endSteps).toEqual(['remove-session-directory']);
        await expect.poll(() => existsSync(join(directory, 'relay.sock'))).toBe(false);
    });

    it('a Session in the session host has no runner process: its target lives until the host ended that Session', async () => {
        let observed!: () => void;
        const hostedSession = { end: async () => true, observed: new Promise<void>(resolve => { observed = resolve; }) };
        let exited = false;
        void observeSessionTargetRunnerExit({ hostedSession }).then(() => { exited = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(exited).toBe(false);
        observed();
        await expect.poll(() => exited).toBe(true);
        // A runner process: its exit; already exited or no process: now.
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
        let childExited = false;
        void observeSessionTargetRunnerExit({ childProcess: child }).then(() => { childExited = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(childExited).toBe(false);
        await expect.poll(() => childExited, { timeout: 5_000 }).toBe(true);
        await expect(observeSessionTargetRunnerExit({})).resolves.toBeUndefined();
    });

    it('names the Session\'s guest directory with a plain key derived from any spawn key (Action nonces carry `:`)', async () => {
        const custody = fakeCustody();
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        const prepared = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'session.spawn_new.creation:9f/aa', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open, launchResourceScope: scope, socketPath: join(directory, 'k.sock') });
        if (!prepared.ok) throw new Error('unreachable');
        expect(prepared.sessionKey).toMatch(/^[A-Za-z0-9._-]+$/u);
        expect(custody.requests[0]!.sessionId).toBe(prepared.sessionKey);
        await scope.retire();
    });

    it('refuses without a target custody owner and ends the authority when the spawn fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'stp-')); directories.push(directory);
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        await expect(prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), launchResourceScope: scope, socketPath: join(directory, 'r.sock') })).resolves.toMatchObject({ ok: false });

        const custody = fakeCustody();
        const failing = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-2', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open, launchResourceScope: failing, socketPath: join(directory, 'f.sock') });
        await failing.retire();
        expect(custody.requests[0]!.lifetime.aborted).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a restarted daemon serves a reattached runner\'s relay again at its holder-directory address, under its own authority', async () => {
        const custody = fakeCustody();
        const socketPath = createSessionHolderSocketPath();
        const request = { request: { managedId: 'row-1' }, sessionKey: 'reattach-cs1', requesterAccountId: 'owner', holderVersion: 'v',
            openManagedSessionTarget: custody.open, readTrustedCallerPid: () => process.pid };
        // An address outside this Machine's holder directory is never served (the runner reported it).
        await expect(restoreSessionTargetRelay({ ...request, socketPath: join(tmpdir(), 'elsewhere.sock') })).resolves.toBeNull();
        expect(custody.requests).toHaveLength(0);

        const sourceWorkspace = { serverId: 'home', workspaceId: 'source', machineId: 'original', rootPath: 'C:\\Users\\person\\project' };
        const targetWorkspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'actual-native-workspace',
            managedId: 'row-1', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/guest/project' };
        const baseline = { entries: [] };
        const release = await restoreSessionTargetRelay({ ...request, socketPath,
            projectFiles: { sessionId: 'reattached-project-files', primarySocketPath: '/guest/primary.sock',
                origin: { sourceWorkspace, targetWorkspace }, readBaseline: async () => baseline } });
        expect(release).toBeTypeOf('function');
        expect(resolveSessionTargetWorkspaceTransfer('reattached-project-files')).toMatchObject({
            workspace: { hostRoot: sourceWorkspace.rootPath, targetRoot: targetWorkspace.rootPath }, baseline });
        const reply = await connectSessionTarget({ id: 'managed:row-1', holderPath: '/h', socketDirectory: '/g/run', relaySocketPath: socketPath }).exec('true');
        expect(reply.stdout).toBe('ran:true');
        release!();
        expect(resolveSessionTargetWorkspaceTransfer('reattached-project-files')).toBeNull();
        expect(custody.requests[0]!.lifetime.aborted).toBe(true);
        await expect.poll(() => existsSync(socketPath)).toBe(false);
    });
});

describe('Session target launch step (credentials + Agent CLI into the target)', () => {
    const macho = (arch: 'x64' | 'arm64') => {
        const header = Buffer.alloc(64);
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
        return header;
    };
    async function localGuest() {
        const guest = await mkdtemp(join(tmpdir(), 'stl-guest-')); directories.push(guest);
        const { spawn } = await import('node:child_process');
        const { Duplex } = await import('node:stream');
        const { writeFile: writeFileAsync } = await import('node:fs/promises');
        const { resolveProcessCustodySupportExecutable } = await import('@/subprocess/supervision/processCustody');
        const helperPath = resolveProcessCustodySupportExecutable();
        if (!helperPath) throw new Error('The publicly prepared custody helper is required');
        const channels: string[][] = [];
        // A fixture guest at the provider boundary: like the real Session authority, nothing runs once its signal ended,
        // and a file put does not create parent directories (devcontainer/Coder `cat > path`).
        const target = { id: 'managed:row-1', holderPath: `${guest}/h`, helperPath, socketDirectory: `${guest}/run`, home: guest,
            platform: { os: 'linux' as const, arch: process.arch === 'arm64' ? 'arm64' as const : 'x64' as const, home: guest },
            exec: (command: string, signal?: AbortSignal) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
                if (signal?.aborted) { reject(Object.assign(new Error('authority ended'), { code: 'intent_changed' })); return; }
                const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = ''; let stderr = '';
                child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
                child.once('error', reject); child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
            }),
            putFile: async (path: string, bytes: Uint8Array) => { await writeFileAsync(path, bytes); },
            openChannel: (argv: readonly string[]) => {
                channels.push([...argv]);
                const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
                child.once('close', () => channel.destroy());
                return channel;
            } };
        return { guest, target, channels };
    }
    async function agentHome() {
        const host = await mkdtemp(join(tmpdir(), 'stl-host-')); directories.push(host);
        const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        const home = join(host, 'agent-home');
        await mkdirAsync(join(home, 'accounts', 'a1'), { recursive: true });
        await mkdirAsync(join(home, 'plugins', 'p'), { recursive: true });
        await writeFileAsync(join(home, 'auth.json'), 'fixture-credential');
        await writeFileAsync(join(home, 'accounts', 'a1', 'token.json'), 'fixture-account');
        await writeFileAsync(join(home, 'config.toml'), '[mcp_servers.x.env]\nTOKEN = "fixture-mcp-secret"');
        await writeFileAsync(join(home, 'hooks.json'), '{"hooks":[]}');
        await writeFileAsync(join(home, 'plugins', 'p', 'x.js'), '');
        return home;
    }

    it('copies a matching Mach-O Agent CLI into a Darwin target and replaces a corrupted target copy', async () => {
        const { guest, target, channels } = await localGuest();
        const { writeFile, readFile } = await import('node:fs/promises');
        const command = join(guest, 'controller-agent');
        await writeFile(command, macho(target.platform.arch));
        const input = { target: { ...target, platform: { ...target.platform, os: 'darwin' as const } },
            runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agent: null,
            agentCommand: command, workspace: { hostRoot: '/h', targetRoot: '/t' }, onSessionEnd: () => undefined };
        const launch = await deliverSessionTargetLaunch({ ...input, sessionKey: 'darwin-local' });
        const placed = launch.executables[command]!;
        expect(await readFile(placed)).toEqual(macho(target.platform.arch));
        await writeFile(placed, 'corrupted');
        const retry = await deliverSessionTargetLaunch({ ...input, sessionKey: 'darwin-retry' });
        expect(retry.executables[command]).toBe(placed);
        expect(await readFile(placed)).toEqual(macho(target.platform.arch));
        expect(channels).toHaveLength(2);
    });

    it('keeps a Darwin Agent home live across runner exit without an external flock utility', async () => {
        const { guest, target } = await localGuest();
        const { spawn } = await import('node:child_process');
        const ended = sessionEnd();
        const launch = await deliverSessionTargetLaunch({ target: { ...target, platform: { ...target.platform, os: 'darwin' },
            exec: (command, signal) => command.includes('command -v flock')
                ? Promise.resolve({ status: 0, stdout: '', stderr: '' }) : target.exec(command, signal) },
            sessionKey: 'darwin-live', onSessionEnd: ended.onSessionEnd, agent: null,
            runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        const base = join(guest, '.happier', 'sessions', 'darwin-live');
        expect(launch.lockPath).toBe(join(base, '.live'));
        const agent = spawn(launch.lockExecutable!, ['file-lock', '-s', launch.lockPath!, '--', 'sh', '-c', 'printf "ready\\n"; read -r end'], { stdio: ['pipe', 'pipe', 'ignore'] });
        try {
            await new Promise<void>((resolve, reject) => { agent.once('error', reject); agent.stdout.once('data', () => resolve()); });
            await ended.end();
            expect(existsSync(base)).toBe(true);
            agent.stdin.end();
            await new Promise(resolve => agent.once('close', resolve));
            await ended.end();
            expect(existsSync(base)).toBe(false);
        } finally { agent.kill(); }
    });

    it('delivers only the provider-declared credential entries and the Agent CLI; the Session end removes them', async () => {
        const { guest, target, channels } = await localGuest();
        const home = await agentHome();
        const { readFile: readFileAsync, readdir: readdirAsync } = await import('node:fs/promises');
        const custody = { open: async (request: ManagedSessionTargetRequest) => ({ ...target, exec: (command: string) => target.exec(command, request.lifetime) }) };
        const scope = createProviderLaunchResourceScope({ onCleanupError: () => undefined });
        const placed = await prepareSessionTargetPlacement({ request: { managedId: 'row-1' }, sessionKey: 'spawn-1', requesterAccountId: 'owner',
            holderVersion: 'v', readTrustedCallerPid: () => process.pid, runnerExit: Promise.resolve(), openManagedSessionTarget: custody.open as never, launchResourceScope: scope, socketPath: join(guest, 'relay.sock') });
        if (!placed.ok) throw new Error('unreachable');
        const launch = await deliverSessionTargetLaunch({ target: { ...target, exec: (command: string) => target.exec(command, placed.signal) },
            sessionKey: 'spawn-1', onSessionEnd: placed.onSessionEnd, agent: leasedAgent('codex', ['auth.json', 'accounts']),
            runnerEnvironment: { CODEX_HOME: home, HAPPIER_CODEX_PROVIDER_API_KEY: 'selected-provider-secret',
                CONNECTED_AGENT_TOKEN: 'selected-account-secret', UNRELATED_PATH: '/usr/share', HAPPIER_X: '1',
                HAPPIER_TOKEN: 'host-account-secret', AMBIENT_API_KEY: 'unselected-secret' },
            providerEnvironmentKeys: ['CODEX_HOME', 'HAPPIER_CODEX_PROVIDER_API_KEY', 'CONNECTED_AGENT_TOKEN', 'UNSET_PROVIDER_KEY'],
            materializedRoot: home, requestAuthMaterializedRoot: null,
            agentCommand: process.execPath, workspace: { hostRoot: '/host/ws', targetRoot: '/workspaces/ws' } });
        const base = join(guest, '.happier', 'sessions', 'spawn-1');
        expect(launch.env).toEqual({ CODEX_HOME: join(base, 'agent-home') });
        expect(launch.providerEnvironmentKeys).toEqual(['HAPPIER_CODEX_PROVIDER_API_KEY', 'CONNECTED_AGENT_TOKEN', 'UNSET_PROVIDER_KEY']);
        expect(JSON.stringify(launch)).not.toContain('selected-provider-secret');
        expect(JSON.stringify(launch)).not.toContain('host-account-secret');
        expect((await readdirAsync(join(base, 'agent-home'))).sort()).toEqual(['accounts', 'auth.json']);
        await expect(readFileAsync(join(base, 'agent-home', 'accounts', 'a1', 'token.json'), 'utf8')).resolves.toBe('fixture-account');
        const placedCli = launch.executables[process.execPath]!;
        expect(placedCli).toMatch(new RegExp(`^${join(guest, '.happier', 'agent-cli')}/[0-9a-f]{64}/node$`));
        expect((await readFileAsync(placedCli)).equals(await readFileAsync(process.execPath))).toBe(true);
        expect(launch.lockPath).toBe(join(base, '.live'));

        // A second Session reuses the one CLI copy (same digest): no second transfer.
        const second = sessionEnd();
        const again = await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-2', onSessionEnd: second.onSessionEnd, agent: null,
            runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: process.execPath,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        expect(again.executables[process.execPath]).toBe(placedCli);
        expect(channels).toHaveLength(1);

        // The Session exits: its delivered files are removed while the authority is still live, then it ends.
        await scope.transfer()?.();
        await expect.poll(() => placed.signal.aborted).toBe(true);
        await expect(readdirAsync(base)).rejects.toMatchObject({ code: 'ENOENT' });
        await second.end();
        await expect(readdirAsync(join(guest, '.happier', 'sessions', 'spawn-2'))).rejects.toMatchObject({ code: 'ENOENT' });
    }, 60_000);

    it('sweeps leftovers of ended Sessions, never a directory a live Agent holds', async () => {
        const { guest, target } = await localGuest();
        const { mkdir: mkdirAsync, readdir: readdirAsync } = await import('node:fs/promises');
        const { spawn } = await import('node:child_process');
        const sessions = join(guest, '.happier', 'sessions');
        await mkdirAsync(join(sessions, 'crashed-1', 'agent-home'), { recursive: true });
        await mkdirAsync(join(sessions, 'live-1', 'agent-home'), { recursive: true });
        const holder = spawn(target.helperPath, ['file-lock', '-s', join(sessions, 'live-1', '.live'), '--', 'sleep', '30'], { stdio: 'ignore' });
        try {
            await expect.poll(async () => (await readdirAsync(join(sessions, 'live-1'))).includes('.live')).toBe(true);
            await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-3', onSessionEnd: () => undefined,
                agent: null, runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null,
                workspace: { hostRoot: '/h', targetRoot: '/t' } });
            expect((await readdirAsync(sessions)).sort()).toEqual(['live-1', 'spawn-3']);
        } finally { holder.kill('SIGKILL'); }
    }, 60_000);

    it('a runner crash keeps the Session\'s delivered home while its Agent still holds it (adoption); a later placement sweeps it once released', async () => {
        const { guest, target } = await localGuest();
        const home = await agentHome();
        const { readdir: readdirAsync } = await import('node:fs/promises');
        const { spawn } = await import('node:child_process');
        const ended = sessionEnd();
        const launch = await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-8', onSessionEnd: ended.onSessionEnd, agent: leasedAgent('codex', ['auth.json']),
            runnerEnvironment: { CODEX_HOME: home }, materializedRoot: home, requestAuthMaterializedRoot: null, agentCommand: null,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        const base = join(guest, '.happier', 'sessions', 'spawn-8');
        // The Session's Agent runs under the shared `.live` lock (as the target launch starts it) and outlives its runner.
        const agent = spawn(launch.lockExecutable!, ['file-lock', '-s', launch.lockPath!, '--', 'sleep', '30'], { stdio: 'ignore', detached: true });
        try {
            await expect.poll(async () => (await readdirAsync(base)).includes('.live')).toBe(true);
            await ended.end();
            expect((await readdirAsync(join(base, 'agent-home')))).toEqual(['auth.json']);
        } finally { process.kill(-agent.pid!, 'SIGKILL'); }
        await new Promise(resolve => agent.once('close', resolve));
        await deliverSessionTargetLaunch({ target, sessionKey: 'spawn-9', onSessionEnd: () => undefined,
            agent: null, runnerEnvironment: {}, materializedRoot: null, requestAuthMaterializedRoot: null, agentCommand: null,
            workspace: { hostRoot: '/h', targetRoot: '/t' } });
        await expect(readdirAsync(base)).rejects.toMatchObject({ code: 'ENOENT' });
    }, 60_000);

    it.each(['linux', 'darwin'] as const)('installs the Agent CLI through its %s vendor recipe with the delivered login', async os => {
        const { guest, target: nativeTarget, channels } = await localGuest();
        const target = { ...nativeTarget, platform: { ...nativeTarget.platform, os } };
        const home = await agentHome();
        const { readFile: readFileAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        // This Machine's CLI is a launcher script (like Muse's), which no target can be handed.
        const launcher = join(await mkdtemp(join(tmpdir(), 'stl-l-')), 'fake-agent'); directories.push(dirname(launcher));
        await writeFileAsync(launcher, '#!/bin/sh\n');
        // The vendor recipe downloads with the Session's own login: it must see the delivered credential home.
        const recipe = 'test -f "$CODEX_HOME/auth.json" && mkdir -p "$HOME/.local/bin" && printf "#!/bin/sh\\n" > "$HOME/.local/bin/fake-agent" '
            + '&& chmod 700 "$HOME/.local/bin/fake-agent" && echo run >> "$HOME/recipe-runs"';
        const agentRuntime = { id: 'fake', title: 'Fake CLI', binaryName: 'fake-agent', knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreferenceDefault: 'system-first' as const, managedInstall: null, manualInstallKind: 'vendor_recipe' as const,
            manualInstallRecipes: { [os]: [{ cmd: 'sh', args: ['-c', recipe] }] }, acceptsJavaScriptFileOverride: false };
        const base = { target, runnerEnvironment: { CODEX_HOME: home }, materializedRoot: home, agent: leasedAgent('fake', ['auth.json'], agentRuntime),
            requestAuthMaterializedRoot: null, agentCommand: launcher, workspace: { hostRoot: '/h', targetRoot: '/t' } };
        const launch = await deliverSessionTargetLaunch({ ...base, sessionKey: 'spawn-5',
            onSessionEnd: () => undefined });
        expect(launch.executables[launcher]).toBe(join(guest, '.local', 'bin', 'fake-agent'));
        expect(channels.flat().join(' ')).not.toContain('CODEX_HOME=');
        expect(existsSync(join(guest, '.happier', 'sessions', 'spawn-5', 'install.environment'))).toBe(false);

        // Installed once per target: a later Session finds it and runs no recipe.
        const again = await deliverSessionTargetLaunch({ ...base, sessionKey: 'spawn-6',
            onSessionEnd: () => undefined });
        expect(again.executables[launcher]).toBe(join(guest, '.local', 'bin', 'fake-agent'));
        await expect(readFileAsync(join(guest, 'recipe-runs'), 'utf8')).resolves.toBe('run\n');

        // A recipe that cannot complete in the target (missing tool, failed download) is a typed refusal.
        const { guest: other, target: bare } = await localGuest();
        await expect(deliverSessionTargetLaunch({ ...base, target: { ...bare, platform: { ...bare.platform, os } }, sessionKey: 'spawn-7',
            agent: leasedAgent('fake', ['auth.json'], { ...agentRuntime, manualInstallRecipes: { [os]: [{ cmd: 'sh', args: ['-c', 'exit 3'] }] } }),
            onSessionEnd: () => undefined }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
        expect(existsSync(join(other, '.local', 'bin', 'fake-agent'))).toBe(false);
    }, 60_000);

    it.each(['linux', 'darwin'] as const)('stages a %s Agent release through its catalog and verifies all streamed files in the target', async os => {
        const { guest, target, channels } = await localGuest();
        const { mkdir: mkdirAsync, readFile: readFileAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
        // The target runs the other CPU architecture than this Machine (arm64 container on an x64 host, or the reverse).
        const foreign = target.platform.arch === 'x64' ? 'arm64' as const : 'x64' as const;
        const elf = (arch: 'x64' | 'arm64') => { const header = Buffer.alloc(64); header.writeUInt32BE(0x7f454c46, 0); header[4] = 2; header[5] = 1; header.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18); return header; };
        const binary = os === 'darwin' ? macho : elf;
        // This Machine's own CLI: an executable for this Machine's architecture (no target of the other arch can run it).
        const hostCli = join(await mkdtemp(join(tmpdir(), 'stl-h-')), 'fakerel'); directories.push(dirname(hostCli));
        await writeFileAsync(hostCli, binary(target.platform.arch));
        const tools = await mkdtemp(join(tmpdir(), 'stl-tools-')); directories.push(tools);
        const runtimeSpec = { id: 'fakerel', title: 'Fake release CLI', binaryName: 'fakerel', knownUserBinDirSuffixes: null,
            sourcePreferenceDefault: 'system-first' as const, manualInstallKind: null, manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
            managedInstall: { kind: 'github_release_binary' as const, githubRepo: 'example/fakerel', releaseTag: 'v1', binaryName: 'fakerel',
                assetNameByPlatform: { darwin: { arm64: 'fakerel-aarch64-apple-darwin.tar.gz', x64: 'fakerel-x86_64-apple-darwin.tar.gz' }, win32: { arm64: 'w-a', x64: 'w-x' },
                    linux: { arm64: 'fakerel-aarch64-unknown-linux-musl.tar.gz', x64: 'fakerel-x86_64-unknown-linux-musl.tar.gz' } },
                archiveEntriesByPlatform: { win32: [], ...Object.fromEntries(['linux', 'darwin'].map(platform => [platform, [
                    { archivePath: 'bin/fakerel', destinationPath: 'bin/fakerel' },
                    { archivePath: 'resources/helper', destinationPath: 'resources/helper' }]])) } } };
        // Only GitHub (release listing, asset download) is the boundary; selection, staging, promotion are the installer's own.
        const downloads: string[] = [];
        const agentCliInstall = { env: { ...process.env, HAPPIER_MANAGED_TOOLS_ROOT: tools },
            deps: {
                fetchGitHubReleaseByTag: async () => ({ assets: ['aarch64', 'x86_64'].map(arch => ({ name: `fakerel-${arch}-${os === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}.tar.gz`,
                    browser_download_url: `https://example.test/${arch}`, digest: `sha256:${'c'.repeat(64)}` })) }),
                downloadGitHubReleaseAsset: async (params: { url: string; destinationPath: string }) => { downloads.push(params.url); await writeFileAsync(params.destinationPath, 'archive'); },
                extractGitHubReleaseAsset: async (params: { outputDir?: string; archiveEntries?: ReadonlyArray<{ destinationPath: string }> }) => {
                    const arch = downloads.at(-1)!.endsWith('aarch64') ? 'arm64' : 'x64';
                    for (const entry of params.archiveEntries ?? []) {
                        const path = join(params.outputDir!, ...entry.destinationPath.split('/'));
                        await mkdirAsync(dirname(path), { recursive: true });
                        await writeFileAsync(path, entry.destinationPath === 'bin/fakerel' ? binary(arch) : 'helper-bytes', { mode: 0o755 });
                    }
                } } };
        const base = { target: { ...target, platform: { ...target.platform, os, arch: foreign } }, runnerEnvironment: {}, materializedRoot: null,
            agent: leasedAgent('fakerel', [], runtimeSpec), requestAuthMaterializedRoot: null, agentCommand: hostCli,
            workspace: { hostRoot: '/h', targetRoot: '/t' }, onSessionEnd: () => undefined, agentCliInstall };
        const launch = await deliverSessionTargetLaunch({ ...base, sessionKey: 'spawn-20' });
        const placedCli = launch.executables[hostCli]!;
        expect(placedCli).toMatch(new RegExp(`^${join(guest, '.happier', 'agent-cli')}/[0-9a-f]{64}/bin/fakerel$`));
        // The target-architecture release, not this Machine's: one download, staged apart from this Machine's managed CLI.
        expect(downloads).toEqual([`https://example.test/${foreign === 'arm64' ? 'aarch64' : 'x86_64'}`]);
        expect((await readFileAsync(placedCli)).equals(binary(foreign))).toBe(true);
        await expect(readFileAsync(join(dirname(dirname(placedCli)), 'resources', 'helper'), 'utf8')).resolves.toBe('helper-bytes');
        // Under its pinned release: a catalog pin change stages the new release instead of reusing this one.
        expect(existsSync(join(tools, 'targets', `${os}-${foreign}`, 'providers', 'fakerel', 'v1'))).toBe(true);
        expect(existsSync(join(tools, 'providers', 'fakerel'))).toBe(false);
        const transfers = channels.length;
        expect(transfers).toBe(2);

        // A later Session reuses both the staged release (no download) and the target's copy (no transfer).
        const again = await deliverSessionTargetLaunch({ ...base, sessionKey: 'spawn-21' });
        expect(again.executables[hostCli]).toBe(placedCli);
        expect(downloads).toHaveLength(1);
        expect(channels).toHaveLength(transfers);
    }, 60_000);

    it('reads the Agent\'s declared auth files and install recipe from the leased catalog; a nested auth path (Muse `muse/auth.json`) crosses alone', async () => {
        const { guest, target } = await localGuest();
        const commands: string[] = [];
        const { mkdir: mkdirAsync, readdir: readdirAsync, writeFile: writeFileAsync, readFile: readFileAsync } = await import('node:fs/promises');
        // The Session's materialized native home (Muse: XDG_CONFIG_HOME) with the auth file next to config that must not cross.
        const home = await mkdtemp(join(tmpdir(), 'stl-muse-')); directories.push(home);
        await mkdirAsync(join(home, 'muse'), { recursive: true });
        await writeFileAsync(join(home, 'muse', 'auth.json'), 'fixture-login');
        await writeFileAsync(join(home, 'muse', 'settings.json'), '{}');
        await writeFileAsync(join(home, 'muse', 'trust.json'), '{}');
        const launcher = join(await mkdtemp(join(tmpdir(), 'stl-l-')), 'fixture-muse'); directories.push(dirname(launcher));
        await writeFileAsync(launcher, '#!/bin/sh\n');
        // A fixture-only binary name: the fixture guest is this host, whose own PATH may hold a real `muse`.
        // Muse's installer downloads with the login: it only succeeds when the declared auth file reached the target.
        const recipe = 'test -n "$SELECTED_INSTALL_TOKEN" && test -f "$XDG_CONFIG_HOME/muse/auth.json" && mkdir -p "$HOME/.local/bin" && printf "#!/bin/sh\\n" > "$HOME/.local/bin/fixture-muse" '
            + '&& chmod 700 "$HOME/.local/bin/fixture-muse" && echo run >> "$HOME/recipe-runs"';
        const runtimeSpec = { id: 'muse', title: 'Muse CLI', binaryName: 'fixture-muse', knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreferenceDefault: 'system-first' as const, managedInstall: null, manualInstallKind: 'vendor_recipe' as const,
            manualInstallRecipes: { linux: [{ cmd: 'sh', args: ['-c', recipe] }] }, acceptsJavaScriptFileOverride: false };
        const launch = await deliverSessionTargetLaunch({ target: { ...target, exec: (command, signal) => {
            commands.push(command); return target.exec(command, signal);
        } }, sessionKey: 'spawn-10', agent: leasedAgent('muse', ['muse/auth.json'], runtimeSpec),
            onSessionEnd: () => undefined,
            runnerEnvironment: { XDG_CONFIG_HOME: home, SELECTED_INSTALL_TOKEN: 'fixture-install-secret' },
            providerEnvironmentKeys: ['XDG_CONFIG_HOME', 'SELECTED_INSTALL_TOKEN'], materializedRoot: home, requestAuthMaterializedRoot: null,
            agentCommand: launcher, workspace: { hostRoot: '/h', targetRoot: '/t' } });
        const agentHome = join(guest, '.happier', 'sessions', 'spawn-10', 'agent-home');
        expect(launch.env).toEqual({ XDG_CONFIG_HOME: agentHome });
        expect((await readdirAsync(agentHome, { recursive: true })).sort()).toEqual(['muse', join('muse', 'auth.json')]);
        await expect(readFileAsync(join(agentHome, 'muse', 'auth.json'), 'utf8')).resolves.toBe('fixture-login');
        expect(launch.executables[launcher]).toBe(join(guest, '.local', 'bin', 'fixture-muse'));
        await expect(readFileAsync(join(guest, 'recipe-runs'), 'utf8')).resolves.toBe('run\n');
        expect(JSON.stringify(commands)).not.toContain('fixture-install-secret');
        expect(existsSync(join(guest, '.happier', 'sessions', 'spawn-10', 'install.environment'))).toBe(false);
    }, 60_000);

    it('refuses what a target cannot use: a loopback credential, an undeclared Agent home, a script or foreign-architecture CLI', async () => {
        const { target } = await localGuest();
        const base = { target, sessionKey: 'spawn-4', runnerEnvironment: {}, materializedRoot: null, agent: null, onSessionEnd: () => undefined,
            workspace: { hostRoot: '/h', targetRoot: '/t' } };
        // The two names of the workspace must not overlap: `/workspace/a/x` would be both a Session path and a target path.
        for (const workspace of [{ hostRoot: '/workspace/a', targetRoot: '/workspace' }, { hostRoot: '/srv', targetRoot: '/srv/ws' }]) {
            await expect(deliverSessionTargetLaunch({ ...base, workspace, requestAuthMaterializedRoot: null, agentCommand: process.execPath }))
                .rejects.toMatchObject({ code: 'workspace_root_unsafe' });
        }
        await expect(deliverSessionTargetLaunch({ ...base, requestAuthMaterializedRoot: '/host/request-auth', agentCommand: process.execPath }))
            .rejects.toMatchObject({ code: 'connected_service_target_unsupported' });
        await expect(deliverSessionTargetLaunch({ ...base, materializedRoot: await agentHome(), requestAuthMaterializedRoot: null, agentCommand: null }))
            .rejects.toMatchObject({ code: 'connected_service_target_unsupported' });
        const script = join(await mkdtemp(join(tmpdir(), 'stl-s-')), 'agent.sh'); directories.push(dirname(script));
        const { writeFile: writeFileAsync } = await import('node:fs/promises');
        await writeFileAsync(script, '#!/bin/sh\n');
        const scriptFailure = await deliverSessionTargetLaunch({ ...base, requestAuthMaterializedRoot: null, agentCommand: script })
            .then(() => { throw new Error('Expected target refusal'); }, error => error);
        expect(scriptFailure).toMatchObject({ code: 'agent_cli_target_unavailable' });
        expect(projectSessionTargetLaunchFailure(scriptFailure)).toMatchObject({ errorDetail: {
            code: 'agent_cli_target_unavailable', message: expect.stringContaining('target:'),
        } });
        await expect(deliverSessionTargetLaunch({ ...base, requestAuthMaterializedRoot: null, agentCommand: process.execPath,
            target: { ...target, platform: { ...target.platform, arch: target.platform.arch === 'x64' ? 'arm64' : 'x64' } } }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
    });
});
