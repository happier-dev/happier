import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { ensureManagedGuestSessionHolder } from '@happier-dev/cli-common/machines/managed';

import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';

import { currentSessionHolderScope, registerSessionMcpRelayAcceptor, SessionHolderChild, type SessionHolderTarget } from './sessionHolder';
import { readSessionTargetHolderArtifacts } from './sessionHolderTargetArtifacts';

/**
 * A Session's Agent held in a target (placement "target"): the holder runs
 * where the target runs it, this process keeps the runner and reaches the holder
 * only through the target's two provider operations, a finite `exec` and a live
 * byte channel. The target here is this host's shell; the channel is a real
 * `holder attach` child process, which is what `docker exec -i` / `coder ssh`
 * run. Killing that process is a dropped provider channel.
 */

const holderExecutable = process.env.HAPPIER_SESSION_HOLDER_TEST_EXECUTABLE ?? resolveSessionHolderExecutablePath();
const UPDATE_COUNT = 60;

const AGENT_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const helper = spawn('sleep', ['600'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ method: 'ready', helperPid: helper.pid }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method !== 'prompt') return;
  let seq = 0;
  const timer = setInterval(() => {
    process.stdout.write(JSON.stringify({ method: 'update', params: { seq, pad: 'x'.repeat(2048) } }) + '\n');
    if (++seq === request.count) { clearInterval(timer); process.stdout.write(JSON.stringify({ result: { updates: seq } }) + '\n'); }
  }, 25);
});
`;

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function localTarget(directory: string, executable: string) {
    const channels: ChildProcess[] = [];
    const target: SessionHolderTarget = {
        id: 'local-test-target', holderPath: executable, socketDirectory: directory,
        exec: command => new Promise((resolve, reject) => {
            const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
            child.once('error', reject);
            child.once('close', status => {
                if ((status !== 0 && command.includes('echo promoted')) || (!stdout.trim() && command.includes('mkfifo'))) {
                    reject(new Error(`Fixture guest command failed (status ${status}): ${stderr}`));
                } else resolve({ status: status ?? 1, stdout, stderr });
            });
        }),
        openChannel: argv => {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
            channels.push(child);
            const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
            child.once('close', () => channel.destroy());
            return channel;
        },
    };
    return { target, channels };
}

describe.skipIf(process.platform === 'win32' || !holderExecutable)('Session holder in a target, reached through provider operations', () => {
    let directory: string;
    let agent: string;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'holder-target-'));
        agent = join(directory, 'agent.mjs');
        await writeFile(agent, AGENT_SOURCE);
    });
    afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

    it('a dropped channel mid-turn reattaches with no gap or duplicate; Stop ends the Agent group through the holder', async () => {
        const { target, channels } = localTarget(directory, holderExecutable!);
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath, args: [agent], cwd: directory,
            sessionHolder: { kind: 'spawn', executablePath: holderExecutable!, socketPath: join(directory, 'h.sock'), role: 'primary', target },
            spawnOptions: { detached: true },
        });
        const child = supervised.child as unknown as SessionHolderChild;
        const seqs: number[] = [];
        let helperPid = 0;
        let disconnects = 0;
        let exited = false;
        let result: unknown = null;
        child.on('holderDisconnected', () => { disconnects += 1; });
        child.on('exit', () => { exited = true; });
        let rest = '';
        child.stdout.on('data', (chunk: Buffer) => {
            rest += chunk.toString('utf8');
            let end: number;
            while ((end = rest.indexOf('\n')) >= 0) {
                const message = JSON.parse(rest.slice(0, end));
                rest = rest.slice(end + 1);
                if (message.method === 'ready') helperPid = message.helperPid;
                else if (message.method === 'update') seqs.push(message.params.seq);
                else if (message.result) result = message.result;
            }
        });
        await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
        // The Agent's pid is the target's: nothing on this Machine may signal it by pid.
        expect(child.pid).toBeUndefined();
        expect(child.remoteAgentPid).toEqual(expect.any(Number));
        await supervised.handle.write(new TextEncoder().encode(JSON.stringify({ method: 'prompt', count: UPDATE_COUNT }) + '\n'));
        await expect.poll(() => seqs.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(20);
        // The provider channel dies (exec client killed): the Agent's state is unknown, not ended.
        channels[0]!.kill('SIGKILL');
        await expect.poll(() => result, { timeout: 15_000 }).toEqual({ updates: UPDATE_COUNT });
        expect(disconnects).toBe(1);
        expect(channels).toHaveLength(2);
        expect(exited).toBe(false);
        expect(seqs).toEqual(Array.from({ length: UPDATE_COUNT }, (_, index) => index));
        expect(isAlive(child.remoteAgentPid!)).toBe(true);

        await supervised.dispose();
        const termination = await supervised.handle.waitForExit();
        expect(termination.requestedBy.kind).not.toBe('none');
        await expect.poll(() => [isAlive(child.remoteAgentPid!), isAlive(helperPid), isAlive(child.holderPid!)], { timeout: 10_000 })
            .toEqual([false, false, false]);
    }, 60_000);

    it.skipIf(process.platform !== 'linux')('admits a real Agent-tree MCP relay and refuses a same-user peer outside that tree', async () => {
        const provider = localTarget(directory, holderExecutable!);
        // The real target bootstrap selects and verifies the published holder/helper;
        // the provider boundary here is the local shell in a private guest HOME.
        const placed = await ensureManagedGuestSessionHolder({ version: 'mcp-test', resolveArtifacts: readSessionTargetHolderArtifacts,
            io: { exec: ({ command }) => provider.target.exec(command), putFile: ({ path, bytes }) => writeFile(path, bytes) } });
        const mcpAgent = join(directory, 'mcp-agent.mjs');
        await writeFile(mcpAgent, `import { spawn } from 'node:child_process';
const env = { ...process.env }; delete env.HAPPIER_SESSION_MCP_CONTEXT_FILE; delete env.HAPPIER_SESSION_MCP_BEARER;
const relay = spawn(process.argv[2], ['mcp-relay'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
relay.stdin.write('fixture-request\\n');
relay.stdout.on('data', bytes => { process.stdout.write(bytes); relay.stdin.end(); });
relay.stderr.pipe(process.stderr);
process.stdin.resume();\n`);
        let admitted = 0;
        let request = '';
        const unregister = registerSessionMcpRelayAcceptor(currentSessionHolderScope(), relay => {
            admitted += 1;
            relay.stdout.on('data', (bytes: Buffer) => {
                request += bytes.toString();
                if (request === 'fixture-request\n') { relay.stdin.write('fixture-response\n'); relay.stdin.end(); }
            });
        });
        const socketPath = join(placed.socketDirectory, 'mcp.sock');
        const supervised = spawnSupervisedPluginProcess({ command: process.execPath, args: [mcpAgent, placed.holderPath], cwd: directory,
            sessionHolder: { kind: 'spawn', executablePath: placed.holderPath, socketPath, role: 'primary', target: { ...provider.target, holderPath: placed.holderPath } },
            spawnOptions: { detached: true } });
        const child = supervised.child as unknown as SessionHolderChild;
        let response = ''; let diagnostics = '';
        child.stdout.on('data', (bytes: Buffer) => { response += bytes.toString(); });
        child.stderr.on('data', (bytes: Buffer) => { diagnostics += bytes.toString(); });
        try {
            await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
            await expect.poll(() => ({ response, diagnostics, admitted, request }), { timeout: 10_000 })
                .toEqual({ response: 'fixture-response\n', diagnostics: '', admitted: 1, request: 'fixture-request\n' });
            let foreignResponse = '';
            await new Promise<void>((resolve, reject) => {
                const foreign = createConnection(`${socketPath}.mcp`);
                foreign.on('data', bytes => { foreignResponse += bytes.toString(); });
                foreign.once('connect', () => foreign.write('GET /mcp-relay HTTP/1.1\r\nUpgrade: happier-mcp-relay\r\n\r\n'));
                foreign.once('error', error => { if (!['ECONNRESET', 'EPIPE'].includes((error as NodeJS.ErrnoException).code ?? '')) reject(error); });
                foreign.once('close', () => resolve());
            });
            expect(foreignResponse).toBe('');
            expect(admitted).toBe(1);
        } finally { unregister(); await supervised.dispose(); await supervised.handle.waitForExit(); }
    }, 60_000);
});
