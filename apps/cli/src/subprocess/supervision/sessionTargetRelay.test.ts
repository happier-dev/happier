import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createStablePluginExecService, installManagedProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { createTerminalRuntimeProcessService } from '@/agent/runtime/session/terminal/launchProcess';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { registerBashHandler } from '@/rpc/handlers/bash';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { resolveProcessCustodySupportExecutable } from './processCustody';

import { SESSION_HOLDER_ADOPT_ENV_KEY, resolveAgentSessionHolderLaunch, type SessionHolderChild } from './sessionHolder';
import { SESSION_TARGET_PLACEMENT_ENV_KEY, connectSessionTarget, serveSessionTargetRelay, type SessionTargetOperations } from './sessionTargetRelay';

/**
 * A Session placed in a target: the daemon holds the target's provider
 * operations (here this host's shell stands in for `docker exec`/`coder ssh`)
 * and relays them to the runner, which holds no custody. The runner's one
 * launch decision reads the placement from its Session environment and starts
 * the Agent's holder in the target through the relay.
 */
const holderExecutable = resolveSessionHolderExecutablePath();
const AGENT_SOURCE = String.raw`
import { createInterface } from 'node:readline';
process.stdout.write(JSON.stringify({ cwd: process.cwd(), home: process.env.HAPPIER_TEST_AGENT_HOME ?? null, leaked: process.env.HAPPIER_TEST_HOST_ONLY ?? null }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  for (let seq = 0; seq < request.count; seq += 1) process.stdout.write(JSON.stringify({ seq }) + '\n');
});
`;

function shellOperations(channels: ChildProcess[]): SessionTargetOperations {
    return {
        exec: (command, signal) => new Promise((resolve, reject) => {
            const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], signal });
            let stdout = '';
            child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            child.once('error', reject);
            child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
        }),
        openChannel: (argv, signal) => {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
            channels.push(child);
            signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
            const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
            child.once('close', () => channel.destroy());
            return channel;
        },
    };
}

describe.skipIf(process.platform === 'win32' || !holderExecutable)('Session target relay (daemon custody, runner launch)', () => {
    let directory: string;
    beforeAll(async () => {
        // Provider sockets must fit Unix SUN_LEN even when the executor's TMPDIR is deep.
        directory = await mkdtemp('/tmp/target-relay-');
        await writeFile(join(directory, 'agent.mjs'), AGENT_SOURCE);
    });
    afterAll(async () => {
        delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        delete sessionProcessEnvironment()[SESSION_HOLDER_ADOPT_ENV_KEY];
        await rm(directory, { recursive: true, force: true });
    });

    it.each([true, false])('places a managed service through Exec; mapped executable available: %s', async (available) => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, `managed-${available}.sock`) });
        const targetRoot = join(directory, `managed-workspace-${available}`);
        await mkdir(targetRoot);
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:service', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: available ? { [process.execPath]: process.execPath } : {},
                env: { HAPPIER_TEST_AGENT_HOME: '/target/service-home' }, workspace: { hostRoot: directory, targetRoot } } });
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory });
        const request = { executable: { kind: 'systemTool', id: 'fixture.node' } as const,
            cwd: { root: 'workspace', relativePath: '' } as const,
            args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HAPPIER_TEST_AGENT_HOME??null}))'] };
        const custody = installManagedProcessCustodyForHost(exec, request, null);
        let handle: Awaited<ReturnType<typeof exec.spawn>> | undefined;
        try {
            handle = await exec.spawn(request);
            if (!available) {
                await expect(handle.wait()).resolves.toMatchObject({ termination: { observed: {
                    kind: 'failed', diagnostic: { details: { errorCode: 'agent_cli_target_unavailable' } },
                } } });
                expect(channels).toHaveLength(0);
            } else {
                let output = '';
                const subscription = handle.onOutput(chunk => { output += Buffer.from(chunk.data).toString(); });
                try {
                    await expect.poll(() => output).not.toBe('');
                    expect(JSON.parse(output)).toEqual({ cwd: targetRoot, home: '/target/service-home' });
                    expect(channels.length).toBeGreaterThan(0);
                } finally { subscription.dispose(); }
            }
        } finally {
            custody.dispose();
            await handle?.dispose();
            await handle?.wait().catch(() => undefined);
            session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('refuses host managed custody for a target instead of promising a host job handshake', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'managed-host-custody.sock') });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:host-custody', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, env: {},
                workspace: { hostRoot: directory, targetRoot: directory } } });
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory });
        const request = { executable: { kind: 'systemTool', id: 'fixture.node' } as const,
            args: ['-e', 'process.stdout.write("target ran without required host job custody")'] };
        // Windows service custody requires its local helper handshake. It cannot own a target process.
        const custody = installManagedProcessCustodyForHost(exec, request, {
            executablePath: '/unavailable/host-custody', jobName: 'fixture-target-job',
            handshakePath: join(directory, 'host-job.handshake'),
        });
        let handle: Awaited<ReturnType<typeof exec.spawn>> | undefined;
        try {
            await expect((async () => { handle = await exec.spawn(request); })())
                .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
            expect(channels).toHaveLength(0);
        } finally {
            custody.dispose(); await handle?.dispose(); session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('places a terminal Agent through the same Session process owner', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'terminal-relay.sock') });
        const targetRoot = join(directory, 'terminal-workspace');
        await mkdir(targetRoot);
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:terminal', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, env: { HAPPIER_TEST_AGENT_HOME: '/target/terminal-home' },
                workspace: { hostRoot: directory, targetRoot } } });
        try {
            const terminal = createTerminalRuntimeProcessService({ verifyExecutableGrant: () => true });
            const handle = await terminal.launch({ executable: { path: process.execPath,
                hostGrant: { kind: 'agent-cli', grantId: 'fixture' } }, cwd: directory,
                args: ['-e', 'process.stderr.write(JSON.stringify({cwd:process.cwd(),home:process.env.HAPPIER_TEST_AGENT_HOME??null}))'] });
            expect(await handle.waitForTermination()).toMatchObject({ type: 'exited', code: 0 });
            expect(JSON.parse(handle.readBufferedStderr())).toEqual({ cwd: targetRoot, home: '/target/terminal-home' });
        } finally { session.abort(); delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY]; }
    });

    it('runs pre-launch command and ACP readiness probes in the Session target', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'readiness-relay.sock') });
        const targetRoot = join(directory, 'readiness-workspace');
        await mkdir(targetRoot);
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:readiness', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, env: { HAPPIER_TEST_AGENT_HOME: '/target/readiness-home' },
                workspace: { hostRoot: directory, targetRoot } } });
        try {
            const command = await runCliCommandBestEffort({ resolvedPath: process.execPath, cwd: directory, timeoutMs: null,
                args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HAPPIER_TEST_AGENT_HOME??null}))'] });
            expect(command.ok).toBe(true);
            expect(JSON.parse(command.stdout)).toEqual({ cwd: targetRoot, home: '/target/readiness-home' });
            const probe = await probeAcpAgentCapabilities({ command: process.execPath, cwd: directory, env: {}, timeoutMs: null,
                transport: { agentName: 'placement-readiness', getInitTimeout: () => 0, getToolPatterns: () => [], filterStdoutLine: line => line },
                args: ['-e', `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
                    const request=JSON.parse(line); if(request.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,
                    result:{protocolVersion:request.params.protocolVersion,agentCapabilities:{loadSession:process.cwd()===${JSON.stringify(targetRoot)}},authMethods:[]}})+'\\n');
                })`] });
            expect(probe).toMatchObject({ ok: true, agentCapabilities: { loadSession: true } });
        } finally { session.abort(); delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY]; }
    });

    it('places Session Bash RPC argv and shell commands in the target workspace', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'bash-relay.sock') });
        const targetRoot = join(directory, 'bash-workspace');
        await mkdir(targetRoot);
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:bash', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            primarySocketPath: join(directory, 'bash-primary.sock'),
            launch: { executables: { [process.execPath]: process.execPath }, env: {}, workspace: { hostRoot: directory, targetRoot } } });
        const primary = spawnSupervisedPluginProcess({ command: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'], cwd: directory,
            sessionHolder: resolveAgentSessionHolderLaunch({ role: 'primary' }) });
        await new Promise<void>((resolve, reject) => { primary.child.once('spawn', resolve); primary.child.once('error', reject); });
        const context: RpcHandlerContext = { signal: session.signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
        let run: (request: { argv?: string[]; command?: string; cwd?: string; timeout: number }) => Promise<unknown> = async () => { throw new Error('Bash not registered'); };
        registerBashHandler({ registerHandler(_method, handler) { run = request => handler(request as Parameters<typeof handler>[0], context); } },
            directory, { resolveHostHomeServerIdentityId: async () => 'home' });
        try {
            expect(await run({ argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'], timeout: 0 }))
                .toMatchObject({ success: true, stdout: targetRoot });
            expect(await run({ command: 'pwd', timeout: 0 })).toMatchObject({ success: true, stdout: targetRoot + '\n' });
            expect(await run({ command: 'pwd', cwd: targetRoot, timeout: 0 })).toMatchObject({ success: true, stdout: targetRoot + '\n' });
            await primary.dispose();
            expect(await run({ argv: [process.execPath, '-e', 'process.stdout.write("host fallback")'], timeout: 0 }))
                .toMatchObject({ success: false, errorCode: 'agent_cli_target_unavailable', stdout: '' });
        } finally {
            await primary.dispose(); session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('starts the Agent in the target through the relay; the Session end closes the relay and every channel', async () => {
        const channels: ChildProcess[] = [];
        const session = new AbortController();
        // The runner is this test process: the relay admits only its kernel-proven pid.
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal, readTrustedCallerPid: () => process.pid,
            socketPath: join(directory, 'relay.sock') });
        const targetRoot = join(directory, 'target-workspace');
        await mkdir(join(targetRoot, 'sub'), { recursive: true });
        const helperPath = resolveProcessCustodySupportExecutable();
        if (!helperPath) throw new Error('The publicly prepared custody helper is required');
        const lockPath = join(directory, '.live');
        const probeLive = () => new Promise<number | null>((resolve, reject) => {
            const probe = spawn(helperPath, ['file-lock', '-n', '-x', lockPath, '--', 'true'], { stdio: 'ignore' });
            probe.once('error', reject); probe.once('close', resolve);
        });
        // Target-native launch facts from the daemon's launch step: the Agent's executable in the target,
        // its environment (credential home delivered into the target), and the workspace root there.
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:row-1', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, env: { HAPPIER_TEST_AGENT_HOME: '/target/agent-home' },
                workspace: { hostRoot: directory, targetRoot }, lockPath, lockExecutable: helperPath } });

        const launch = resolveAgentSessionHolderLaunch({ role: 'primary' });
        expect(launch).toMatchObject({ kind: 'spawn', executablePath: holderExecutable, target: { id: 'managed:row-1' } });
        // An executable the launch step did not place in the target is refused, never run from this Machine's path.
        const unplaced = spawnSupervisedPluginProcess({ command: '/usr/bin/env', args: ['true'], cwd: directory,
            sessionHolder: resolveAgentSessionHolderLaunch({ role: 'auxiliary' }), spawnOptions: { detached: true } });
        await expect(new Promise((_resolve, reject) => { unplaced.child.once('error', reject); }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });

        const supervised = spawnSupervisedPluginProcess({ command: process.execPath, args: [join(directory, 'agent.mjs')], cwd: join(directory, 'sub'),
            env: { ...process.env, HAPPIER_TEST_HOST_ONLY: 'host-secret' }, sessionHolder: launch, spawnOptions: { detached: true } });
        const child = supervised.child as unknown as SessionHolderChild;
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
        expect(child.pid).toBeUndefined();
        await supervised.handle.write(new TextEncoder().encode(JSON.stringify({ count: 30 }) + '\n'));
        await expect.poll(() => output.trim().split('\n').filter(Boolean).length, { timeout: 10_000 }).toBe(31);
        expect(JSON.parse(output.split('\n')[0]!)).toEqual({ cwd: join(targetRoot, 'sub'), home: '/target/agent-home', leaked: null });
        expect(channels.length).toBeGreaterThanOrEqual(1);
        expect(await probeLive()).not.toBe(0);

        await supervised.dispose();
        await supervised.handle.waitForExit();
        expect(await probeLive()).toBe(0);
        session.abort();
        await expect.poll(() => existsSync(socketPath)).toBe(false);
        await expect.poll(() => channels.every(channel => channel.exitCode !== null || channel.signalCode !== null)).toBe(true);
    }, 60_000);

    it('a respawned runner adopts the crashed runner\'s target-held Agent through its own relay', async () => {
        const firstChannels: ChildProcess[] = [];
        const crashed = new AbortController();
        const first = await serveSessionTargetRelay({ operations: shellOperations(firstChannels), lifetime: crashed.signal, readTrustedCallerPid: () => process.pid,
            socketPath: join(directory, 'relay-crash-1.sock') });
        const primarySocketPath = join(directory, 'adopt-primary.sock');
        const placement = (relaySocketPath: string) => JSON.stringify({ id: 'managed:row-1', holderPath: holderExecutable, socketDirectory: directory,
            relaySocketPath, primarySocketPath, launch: { executables: { [process.execPath]: process.execPath }, env: {}, workspace: { hostRoot: directory, targetRoot: directory } } });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = placement(first.socketPath);
        const started = spawnSupervisedPluginProcess({ command: process.execPath, args: [join(directory, 'agent.mjs')], cwd: directory,
            sessionHolder: resolveAgentSessionHolderLaunch({ role: 'primary' }), spawnOptions: { detached: true } });
        const original = started.child as unknown as SessionHolderChild;
        let before = '';
        original.stdout.on('data', (chunk: Buffer) => { before += chunk.toString('utf8'); });
        await new Promise<void>((resolve, reject) => { original.once('spawn', () => resolve()); original.once('error', reject); });
        const holderPid = original.holderPid!;
        const agentPid = original.remoteAgentPid!;
        await expect.poll(() => before.length).toBeGreaterThan(0);
        // The runner crashes: its placement's authority ends with it (every channel killed); the Agent stays in its holder.
        crashed.abort();
        await expect.poll(() => firstChannels.every(channel => channel.exitCode !== null || channel.signalCode !== null)).toBe(true);

        // The respawn: a new placement (relay) and the daemon's hand-off of the spared Agent.
        const secondChannels: ChildProcess[] = [];
        const respawned = new AbortController();
        const second = await serveSessionTargetRelay({ operations: shellOperations(secondChannels), lifetime: respawned.signal, readTrustedCallerPid: () => process.pid,
            socketPath: join(directory, 'relay-crash-2.sock') });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = placement(second.socketPath);
        sessionProcessEnvironment()[SESSION_HOLDER_ADOPT_ENV_KEY] = JSON.stringify({ socketPath: primarySocketPath, holderPid, agentPid });
        const launch = resolveAgentSessionHolderLaunch({ role: 'primary' });
        expect(launch).toMatchObject({ kind: 'adopt', socketPath: primarySocketPath, target: { id: 'managed:row-1' } });
        const adopted = spawnSupervisedPluginProcess({ command: process.execPath, args: [join(directory, 'agent.mjs')], cwd: directory,
            sessionHolder: launch, spawnOptions: { detached: true } });
        const child = adopted.child as unknown as SessionHolderChild;
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
        expect({ holderPid: child.holderPid, agentPid: child.remoteAgentPid, localPid: child.pid }).toEqual({ holderPid, agentPid, localPid: undefined });
        await adopted.handle.write(new TextEncoder().encode(JSON.stringify({ count: 5 }) + '\n'));
        await expect.poll(() => output.split('\n').filter(line => line.startsWith('{"seq"')).length, { timeout: 10_000 }).toBe(5);
        expect(secondChannels.length).toBeGreaterThanOrEqual(1);

        await adopted.dispose();
        await adopted.handle.waitForExit();
        respawned.abort();
    }, 60_000);

    it('a runner that outlives its daemon reaches its target Agent again once the restarted daemon serves the relay', async () => {
        const relaySocketPath = join(directory, 'relay-restart.sock');
        const firstChannels: ChildProcess[] = [];
        const oldDaemon = new AbortController();
        await serveSessionTargetRelay({ operations: shellOperations(firstChannels), lifetime: oldDaemon.signal, readTrustedCallerPid: () => process.pid, socketPath: relaySocketPath });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({ id: 'managed:row-1', holderPath: holderExecutable, socketDirectory: directory,
            relaySocketPath, launch: { executables: { [process.execPath]: process.execPath }, env: {}, workspace: { hostRoot: directory, targetRoot: directory } } });
        const supervised = spawnSupervisedPluginProcess({ command: process.execPath, args: [join(directory, 'agent.mjs')], cwd: directory,
            sessionHolder: resolveAgentSessionHolderLaunch({ role: 'primary' }), spawnOptions: { detached: true } });
        const child = supervised.child as unknown as SessionHolderChild;
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
        const seqLines = () => output.split('\n').filter(line => line.startsWith('{"seq"')).length;
        await supervised.handle.write(new TextEncoder().encode(JSON.stringify({ count: 3 }) + '\n'));
        await expect.poll(seqLines, { timeout: 10_000 }).toBe(3);

        // The daemon restarts: its relay (and every channel through it) ends while the runner and the target Agent live on.
        let disconnects = 0;
        child.on('holderDisconnected', () => { disconnects += 1; });
        oldDaemon.abort();
        await expect.poll(() => existsSync(relaySocketPath)).toBe(false);
        await expect.poll(() => disconnects).toBeGreaterThanOrEqual(1);
        // The runner's one reattach at the drop met no relay.
        await new Promise(resolve => setTimeout(resolve, 300));

        // The restarted daemon serves the Session's relay again at the same address; the runner's next use reattaches.
        const restartedDaemon = new AbortController();
        const secondChannels: ChildProcess[] = [];
        await serveSessionTargetRelay({ operations: shellOperations(secondChannels), lifetime: restartedDaemon.signal, readTrustedCallerPid: () => process.pid, socketPath: relaySocketPath });
        await supervised.handle.write(new TextEncoder().encode(JSON.stringify({ count: 4 }) + '\n'));
        await expect.poll(seqLines, { timeout: 10_000 }).toBe(7);
        expect(secondChannels.length).toBeGreaterThanOrEqual(1);

        await supervised.dispose();
        await supervised.handle.waitForExit();
        restartedDaemon.abort();
    }, 60_000);

    it('admits only the Session runner: any other local process (or an unknown runner) is refused', async () => {
        const session = new AbortController();
        let runner: number | null = null;
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations([]), lifetime: session.signal,
            readTrustedCallerPid: () => runner, socketPath: join(directory, 'relay-peer.sock') });
        const target = connectSessionTarget({ id: 't', holderPath: '/h', socketDirectory: directory, relaySocketPath: socketPath });
        await expect(target.exec('echo hi')).rejects.toMatchObject({ code: 'session_target_unavailable' });
        runner = process.pid + 100_000;
        await expect(target.exec('echo hi')).rejects.toMatchObject({ code: 'session_target_unavailable' });
        runner = process.pid;
        await expect(target.exec('echo hi')).resolves.toMatchObject({ status: 0, stdout: 'hi\n' });
        session.abort();
    }, 60_000);
});
