import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { captureAgentNativeLaunchAuthorityForHost, createStablePluginExecService, installManagedProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { createTerminalRuntimeProcessService } from '@/agent/runtime/session/terminal/launchProcess';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { registerBashHandler } from '@/rpc/handlers/bash';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { resolveProcessCustodySupportExecutable } from './processCustody';
import { createClaudeNativeSdkQueryContext } from '../../../../../packages/plugins/claude/src/agent/sdk/nativeExec';
import { queryWithContext } from '../../../../../packages/plugins/claude/src/agent/sdk/query';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { resolveHappierMcpServerConfig } from '@/agent/runtime/createHappierMcpBridge';
import { buildPiRpcLaunch } from '../../../../../packages/plugins/pi/src/agent/runtime/rpc/args';

import { SESSION_HOLDER_ADOPT_ENV_KEY, resolveAgentSessionHolderLaunch, type SessionHolderChild } from './sessionHolder';
import { SESSION_TARGET_PLACEMENT_ENV_KEY, assertSessionTargetWorkspaceUnambiguous, connectSessionTarget,
    prepareTargetAgentLaunch, serveSessionTargetRelay, toSessionTargetPath, type SessionTargetOperations } from './sessionTargetRelay';

/**
 * A Session placed in a target: the daemon holds the target's provider
 * operations (here this host's shell stands in for `docker exec`/`coder ssh`)
 * and relays them to the runner, which holds no custody. The runner's one
 * launch decision reads the placement from its Session environment and starts
 * the Agent's holder in the target through the relay.
 */
const holderExecutable = resolveSessionHolderExecutablePath();

describe('Session target mapping across original Machine path styles', () => {
    it.each([
        { hostRoot: 'C:\\Users\\alice\\project\\', hostPath: 'c:/USERS/alice/project/src\\feature', expected: '/workspace/project/src/feature' },
        { hostRoot: '/Users/alice/project/', hostPath: '/Users/alice/project/src\\feature', expected: '/workspace/project/src/feature' },
        { hostRoot: '\\\\server\\share\\project', hostPath: '//SERVER/share/project/src/feature', expected: '/workspace/project/src/feature' },
    ])('maps the original source without the controller OS parser: $hostRoot', ({ hostRoot, hostPath, expected }) => {
        const workspace = { hostRoot, targetRoot: '/workspace/project' };
        assertSessionTargetWorkspaceUnambiguous(workspace);
        expect(toSessionTargetPath(workspace, hostPath)).toBe(expected);
        expect(prepareTargetAgentLaunch({ workspace, executables: { agent: '/guest/agent' }, env: {} },
            { command: 'agent', args: [], cwd: expected }).cwd).toBe(expected);
    });

    it.each(['C:\\Users\\alice2\\project', 'C:\\Users\\alice\\project\\..\\outside'])('refuses a path outside the original root: %s', path => {
        expect(() => toSessionTargetPath({ hostRoot: 'C:\\Users\\alice\\project', targetRoot: '/workspace/project' }, path))
            .toThrow(expect.objectContaining({ code: 'workspace_root_unsafe' }));
    });
});
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

    it('publishes Claude SDK generated files before the placed Agent reads its remapped argv', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        let hostSources: readonly string[] = [];
        const operations = shellOperations(channels);
        const { socketPath } = await serveSessionTargetRelay({ operations: { ...operations,
            exec: async (command, signal) => {
                // Separate host/guest filesystems at the real Agent spawn boundary:
                // only target-published copies can remain readable by the Agent.
                if (command.includes('nohup')) await Promise.all(hostSources.map(path => rm(path, { force: true })));
                return operations.exec(command, signal);
            } }, lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'required-files.sock') });
        const targetRoot = join(directory, 'required-workspace');
        const runtimeHome = join(directory, 'required-session');
        await mkdir(targetRoot);
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:required-files', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, runtimeHome,
                env: { HAPPIER_TEST_AGENT_HOME: '/target/required-home' }, workspace: { hostRoot: directory, targetRoot } } });
        // Model/process boundary: the real native SDK launch reaches this target Agent, which reads its actual argv files.
        const agent = String.raw`
const { readFileSync, statSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', () => {
  const args = process.argv.slice(1);
  const files = ['--mcp-config', '--append-system-prompt-file'].map(flag => {
    const path = args[args.indexOf(flag) + 1];
    return { flag, path, contents: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 };
  });
  const text = JSON.stringify({ files, cwd: process.cwd(), home: process.env.HAPPIER_TEST_AGENT_HOME,
    leaked: process.env.HAPPIER_TEST_HOST_ONLY ?? null });
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
  process.exit(0);
});`;
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory,
            environment: { HAPPIER_TEST_HOST_ONLY: 'must-stay-on-host' },
            systemTools: { resolve: async () => ({ executablePath: process.execPath,
                launch: { executablePath: process.execPath, args: ['-e', agent, '--'] } }) } });
        // Observe the public process input while retaining the entire real Exec implementation.
        const observedExec: ExecService = { ...exec, clients: { ...exec.clients, spawn: (spec, options) => {
            hostSources = spec.launch.requiredFiles ?? [];
            return exec.clients.spawn(spec, options);
        } } };
        const mcpServers = { happier: resolveHappierMcpServerConfig({
            localContext: { v: 1, socketPath: '/host/private-mcp.sock', bearerToken: 'b'.repeat(43) },
            contextFilePath: '/host/private-context.json' }) };
        expect(mcpServers.happier).toMatchObject({ command: holderExecutable, args: ['mcp-relay'] });
        expect(Object.keys(mcpServers.happier.env ?? {})).toEqual(['HAPPIER_SESSION_MCP_REGISTRATION_ID']);
        const instructions = 'Private startup text for a placed Agent.';
        const running = queryWithContext(createClaudeNativeSdkQueryContext(observedExec), { prompt: (async function* () {
            yield { type: 'user' as const, message: { role: 'user' as const, content: 'fixture' } };
        })(), options: { extraArgs: ['--mcp-config', JSON.stringify({ mcpServers })],
            appendSystemPrompt: instructions, appendSystemPromptFile: true } });
        try {
            const first = await running[Symbol.asyncIterator]().next();
            expect(first.done).toBe(false);
            expect(first.value).toMatchObject({ type: 'assistant' });
            const message = first.value as { message: { content: { text: string }[] } };
            const report = JSON.parse(message.message.content[0]!.text);
            expect(report).toMatchObject({ cwd: targetRoot, home: '/target/required-home', leaked: null });
            expect(report.files.map((file: { contents: string }) => file.contents))
                .toEqual([JSON.stringify({ mcpServers }), instructions]);
            for (const file of report.files) {
                expect(file.path.startsWith(`${runtimeHome}/`)).toBe(true);
                expect(file.mode).toBe(0o600);
            }
        } finally {
            await running.dispose(); session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('refuses a missing placed launch file before starting an Agent', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'missing-required.sock') });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:missing-required', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, env: {}, runtimeHome: join(directory, 'missing-session') } });
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory });
        const source = join(directory, 'missing-config.json');
        let handle: Awaited<ReturnType<typeof exec.spawn>> | undefined;
        try {
            handle = await exec.spawn({ executable: { kind: 'systemTool', id: 'fixture.node' },
                args: ['-e', 'process.exit(0)', source], requiredFiles: [source] });
            await expect(handle.wait()).resolves.toMatchObject({ termination: { observed: {
                kind: 'failed', diagnostic: { details: { errorCode: 'agent_launch_required_file_unavailable' } },
            } } });
            expect(channels).toHaveLength(0);
        } finally {
            await handle?.dispose(); session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('refuses a declared backslash traversal before writing files in the target', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const { socketPath } = await serveSessionTargetRelay({ operations: shellOperations(channels), lifetime: session.signal,
            readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'traversal-required.sock') });
        const source = join(directory, String.raw`..\..\..\home\guest\.bashrc`);
        await writeFile(source, 'must not be published');
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:traversal-required', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, runtimeHome: join(directory, 'traversal-session') } });
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory });
        let handle: Awaited<ReturnType<typeof exec.spawn>> | undefined;
        try {
            handle = await exec.spawn({ executable: { kind: 'systemTool', id: 'fixture.node' },
                args: ['-e', 'process.exit(0)', source], requiredFiles: [source] });
            await expect(handle.wait()).resolves.toMatchObject({ termination: { observed: {
                kind: 'failed', diagnostic: { details: { errorCode: 'agent_launch_required_file_unavailable' } },
            } } });
            expect(channels).toHaveLength(0);
        } finally {
            await handle?.dispose(); session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('delivers Pi model files through the admitted target environment root', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const sourceHome = join(directory, 'pi-host-home');
        const runtimeHome = join(directory, 'pi-target-session');
        const targetHome = join(runtimeHome, 'agent-home');
        await mkdir(sourceHome);
        const selection = buildPiRpcLaunch({ providerModelId: 'fixture-model', env: { PI_CODING_AGENT_DIR: sourceHome } });
        expect(selection.requiredFiles).toHaveLength(1);
        const source = selection.requiredFiles[0]!;
        await writeFile(source, 'private model fixture');
        const operations = shellOperations(channels);
        const { socketPath } = await serveSessionTargetRelay({ operations: { ...operations,
            exec: async (command, signal) => {
                if (command.includes('nohup')) await rm(source, { force: true });
                return operations.exec(command, signal);
            } }, lifetime: session.signal, readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'pi-required.sock') });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:pi-required', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, runtimeHome,
                env: { PI_CODING_AGENT_DIR: targetHome } } });
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory });
        let handle: Awaited<ReturnType<typeof exec.spawn>> | undefined;
        try {
            const filename = source.slice(sourceHome.length + 1);
            handle = await exec.spawn({ executable: { kind: 'systemTool', id: 'fixture.node' },
                args: ['-e', 'process.stdout.write(require("node:fs").readFileSync(require("node:path").join(process.env.PI_CODING_AGENT_DIR,process.argv[1]),"utf8"))',
                    filename, '--', ...selection.args], requiredFiles: selection.requiredFiles,
                env: { PI_CODING_AGENT_DIR: sourceHome, HAPPIER_TEST_HOST_ONLY: 'must-stay-on-host' } });
            await expect(handle.wait()).resolves.toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
            expect(Buffer.from((await handle.wait()).stdout).toString()).toBe('private model fixture');
        } finally {
            await handle?.dispose(); session.abort();
            delete sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY];
        }
    });

    it('refuses truncated target file delivery even when the carrier closes normally', async () => {
        const session = new AbortController();
        const channels: ChildProcess[] = [];
        const operations = shellOperations(channels);
        let agentStarted = false;
        const { socketPath } = await serveSessionTargetRelay({ operations: {
            exec: (command, signal) => {
                if (command.includes('nohup')) agentStarted = true;
                return operations.exec(command, signal);
            },
            // Genuine carrier/process fault: consume only one byte, then close successfully.
            openChannel: (argv, signal) => operations.openChannel(argv.map(part => part.replace('cat > ', 'head -c 1 > ')), signal),
        }, lifetime: session.signal, readTrustedCallerPid: () => process.pid, socketPath: join(directory, 'truncated-required.sock') });
        sessionProcessEnvironment()[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({
            id: 'managed:truncated-required', holderPath: holderExecutable, socketDirectory: directory, relaySocketPath: socketPath,
            launch: { executables: { [process.execPath]: process.execPath }, env: {}, runtimeHome: join(directory, 'truncated-session') } });
        const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => directory });
        const source = join(directory, 'binary-config.bin');
        await writeFile(source, Buffer.from([0, 255, 128, 13, 10]));
        let handle: Awaited<ReturnType<typeof exec.spawn>> | undefined;
        try {
            handle = await exec.spawn({ executable: { kind: 'systemTool', id: 'fixture.node' },
                args: ['-e', 'process.exit(0)', source], requiredFiles: [source] });
            await expect(handle.wait()).resolves.toMatchObject({ termination: { observed: {
                kind: 'failed', diagnostic: { details: { errorCode: 'agent_launch_required_file_unavailable' } },
            } } });
            expect(agentStarted).toBe(false);
        } finally {
            await handle?.dispose(); session.abort();
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
            const exec = createStablePluginExecService({ signal: session.signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => { throw new Error('Executable already resolved'); },
                resolvePath: async () => directory, prepareAgentNativeLaunch: async () => undefined });
            const terminal = createTerminalRuntimeProcessService({ verifyExecutableGrant: () => true,
                readNativeLaunchAuthority: () => captureAgentNativeLaunchAuthorityForHost(exec, 'terminal') });
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
