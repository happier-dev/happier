import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { createJsonRpcProcessClient } from '@/plugins/runtime/exec/jsonRpc';
import { createJsonStreamProcessClient } from '@/plugins/runtime/exec/jsonStream';
import { adaptStablePluginExecLegacyProcessHandle } from '@/plugins/runtime/invocation/services/exec';
import { createAcpNdJsonStream } from '@/agent/acp/createAcpNdJsonStream';

import { createSessionHolderSocketPath, SessionHolderChild } from './sessionHolder';
import { createSessionHolderAdoption, JSON_RPC_FRAME_CODEC, JSON_RPC_INITIALIZE_HANDSHAKE, JSON_STREAM_ADOPT_HANDSHAKES, JSON_STREAM_CONTROL_HANDSHAKE } from './sessionHolderAdoption';

/**
 * Runner crash mid-request with the real holder executable and a real Agent
 * process. Runner 1 is the production supervisor + host JSON-RPC client; it
 * "crashes" by dropping its holder connection without acknowledging the
 * pending output. Runner 2 adopts the same Agent through the launch decision's
 * adopt form. Only the Agent is a fixture.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const prebuiltHolder = process.env.HAPPIER_SESSION_HOLDER_TEST_EXECUTABLE;
const cargoAvailable = Boolean(prebuiltHolder) || spawnSync('cargo', ['--version']).status === 0;

// Answers `slow` after a delay and everything else at once; counts handshakes.
const AGENT_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.env.T_LOG;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ method: request.method, id: request.id ?? null }) + '\n');
  if (request.id === undefined) return;
  const answer = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize') return answer({ server: 'fixture', pid: process.pid });
  if (request.method === 'session/new') return answer({ sessionId: 'agent-session-1' });
  if (request.method === 'slow') return setTimeout(() => answer({ answeredFor: 'slow' }), 400);
  // Still pending when the old 'slow' answer arrives: a reused id would take that answer.
  if (request.method === 'later') return setTimeout(() => answer({ answeredFor: 'later' }), 800);
  answer({ answeredFor: request.method });
});
`;

// Codex app-server shape: the turn's answer is immediate; its progress and
// completion are notifications, which the holder replays to the adopter.
const APP_SERVER_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.T_LOG, JSON.stringify({ method: request.method }) + '\n');
  if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'fixture' } });
  if (request.method !== 'turn/start') return;
  send({ id: request.id, result: { turn: { id: 'turn-1' } } });
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    send({ method: 'item/agentMessage/delta', params: { turnId: 'turn-1', n } });
    if (n === 40) { clearInterval(timer); send({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } }); }
  }, 20);
});
`;

// Claude stream-json shape: control initialize, then a user message streams
// assistant records and one result record.
const STREAM_JSON_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = record => process.stdout.write(JSON.stringify(record) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const record = JSON.parse(line);
  appendFileSync(process.env.T_LOG, JSON.stringify({ type: record.type, subtype: record.request?.subtype ?? null }) + '\n');
  if (record.type === 'control_request') return send({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: { commands: [] } } });
  if (record.type !== 'user') return;
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    send({ type: 'assistant', n });
    if (n === 40) { clearInterval(timer); send({ type: 'result', subtype: 'success' }); }
  }, 20);
});
`;

// Pi RPC shape: `{type, id}` commands answered by `{type: 'response', id}`; a
// prompt is acknowledged at once and its turn streams as untagged records.
const COMMAND_RESPONSE_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = record => process.stdout.write(JSON.stringify(record) + '\n');
let streaming = false;
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  appendFileSync(process.env.T_LOG, JSON.stringify({ type: command.type, id: command.id }) + '\n');
  const respond = data => send({ type: 'response', id: command.id, command: command.type, success: true, data });
  if (command.type === 'get_state') return respond({ sessionId: 'pi-session-1', isStreaming: streaming });
  if (command.type !== 'prompt') return respond(null);
  respond(null);
  streaming = true;
  send({ type: 'agent_start' });
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    send({ type: 'message_update', n });
    if (n === 40) { clearInterval(timer); streaming = false; send({ type: 'agent_end' }); }
  }, 20);
});
`;

const describeHolder = cargoAvailable ? describe : describe.skip;

describeHolder('per-Session holder adopt contract', () => {
    let directory: string;
    let holderExecutable: string;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'happier-holder-adopt-'));
        await writeFile(join(directory, 'agent.mjs'), AGENT_SOURCE);
        await writeFile(join(directory, 'app-server.mjs'), APP_SERVER_SOURCE);
        await writeFile(join(directory, 'stream-json.mjs'), STREAM_JSON_SOURCE);
        await writeFile(join(directory, 'command-response.mjs'), COMMAND_RESPONSE_SOURCE);
        if (prebuiltHolder) {
            holderExecutable = prebuiltHolder;
            return;
        }
        const target = join(directory, 'target');
        const built = spawnSync('cargo', ['build', '-p', 'happier-session-holder', '--target-dir', target],
            { cwd: join(repoRoot, 'packages/iroh-native/rust'), stdio: 'inherit' });
        if (built.status !== 0) throw new Error('holder build failed');
        holderExecutable = join(target, 'debug', process.platform === 'win32' ? 'happier-session-holder.exe' : 'happier-session-holder');
    }, 300_000);

    afterAll(async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    // A failed assertion must not leave a held Agent behind: end every holder
    // and Agent this test started (exact PIDs only).
    const started = new Set<number>();
    const own = (child: { pid?: number; holderPid?: number }) => {
        if (child.pid) started.add(child.pid);
        if (child.holderPid) started.add(child.holderPid);
    };
    afterEach(() => {
        for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
        started.clear();
    });

    const readLog = async (log: string) => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string; id: number | null });

    it('adopts the held Agent: no second handshake, the held request completes, and a new request with the same local id gets its own answer', async () => {
        const log = join(directory, 'jsonrpc.log');
        const socketPath = createSessionHolderSocketPath();
        const launch = { command: process.execPath, args: [join(directory, 'agent.mjs')], env: { ...process.env, T_LOG: log } };

        // Runner 1: initialize, then a request the Agent answers only after the crash.
        const first = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true,
            sessionHolder: { kind: 'spawn', executablePath: holderExecutable, socketPath, role: 'primary' } });
        const firstClient = createJsonRpcProcessClient({ stdout: first.child.stdout,
            write: async data => first.handle.write(typeof data === 'string' ? new Uint8Array(Buffer.from(data)) : data),
            sessionHolderAdoption: deliver => createSessionHolderAdoption({ child: first.child, handshake: JSON_RPC_INITIALIZE_HANDSHAKE, deliver }) });
        const initialized = await firstClient.client.request<unknown, { pid: number }>('initialize', {});
        const agentPid = first.child.pid;
        own(first.child as SessionHolderChild);
        expect(initialized.pid).toBe(agentPid);
        void firstClient.client.request('slow', {}).catch(() => undefined); // local id 2, never answered here
        await new Promise(resolve => setTimeout(resolve, 100));
        // Crash: the runner's holder connection drops; the Agent keeps running.
        (first.child as SessionHolderChild).detach();
        firstClient.dispose();

        // Runner 2 adopts through the launch decision's adopt form.
        const second = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true,
            sessionHolder: { kind: 'adopt', socketPath, role: 'primary' } });
        const secondClient = createJsonRpcProcessClient({ stdout: second.child.stdout,
            write: async data => second.handle.write(typeof data === 'string' ? new Uint8Array(Buffer.from(data)) : data),
            sessionHolderAdoption: deliver => createSessionHolderAdoption({ child: second.child, handshake: JSON_RPC_INITIALIZE_HANDSHAKE, deliver }) });
        const adoption = secondClient.sessionHolderAdoption!;
        expect(await adoption.adopted).toBe(true);
        expect(second.child.pid).toBe(agentPid);
        // The handshake is answered from the stored result.
        expect(await secondClient.client.request('initialize', {})).toEqual(initialized);
        const held = adoption.heldRequests();
        expect(held.map(request => request.method)).toEqual(['slow']);
        // Local id 2 again, while the Agent's answer to the old id 2 is still coming.
        const fresh = await secondClient.client.request('later', {});
        expect(fresh).toEqual({ answeredFor: 'later' });
        expect(await held[0]!.response).toEqual({ result: { answeredFor: 'slow' } });

        const methods = await readLog(log);
        expect(methods.filter(entry => entry.method === 'initialize')).toHaveLength(1);
        const wireIds = methods.filter(entry => entry.id !== null).map(entry => entry.id);
        expect(new Set(wireIds).size).toBe(wireIds.length);

        await second.dispose('caller');
        secondClient.dispose();
    }, 30_000);

    it('applies the same contract below the ACP SDK stream: the held prompt completes and the same SDK id resolves its own caller', async () => {
        const log = join(directory, 'acp.log');
        const socketPath = createSessionHolderSocketPath();
        const launch = { command: process.execPath, args: [join(directory, 'agent.mjs')], env: { ...process.env, T_LOG: log } };
        const handshake = { codec: JSON_RPC_FRAME_CODEC, requests: { initialize: 'initialize' }, readyAfter: [] };
        const openStream = (child: SessionHolderChild, write: (data: Uint8Array) => Promise<void>) => createAcpNdJsonStream(
            new WritableStream<Uint8Array>({ write: chunk => write(chunk) }),
            new ReadableStream<Uint8Array>({ start(controller) {
                child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            } }),
            { sessionHolderAdoption: deliver => createSessionHolderAdoption({ child, handshake, deliver }) });

        const first = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true,
            sessionHolder: { kind: 'spawn', executablePath: holderExecutable, socketPath, role: 'primary' } });
        const firstStream = openStream(first.child as SessionHolderChild, data => first.handle.write(data));
        const firstWriter = firstStream.writable.getWriter();
        const firstReader = firstStream.readable.getReader();
        // The SDK numbers from 0: initialize = 0, the prompt = 1.
        await firstWriter.write({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
        expect((await firstReader.read()).value).toMatchObject({ id: 0, result: { server: 'fixture' } });
        own(first.child as SessionHolderChild);
        await firstWriter.write({ jsonrpc: '2.0', id: 1, method: 'slow', params: {} });
        await new Promise(resolve => setTimeout(resolve, 100));
        (first.child as SessionHolderChild).detach();

        const second = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true,
            sessionHolder: { kind: 'adopt', socketPath, role: 'primary' } });
        const secondStream = openStream(second.child as SessionHolderChild, data => second.handle.write(data));
        const adoption = secondStream.sessionHolderAdoption!;
        expect(await adoption.adopted).toBe(true);
        const writer = secondStream.writable.getWriter();
        const reader = secondStream.readable.getReader();
        await writer.write({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
        expect((await reader.read()).value).toMatchObject({ id: 0, result: { server: 'fixture' } });
        adoption.release();
        const held = adoption.heldRequests();
        expect(held.map(request => request.method)).toEqual(['slow']);
        // The new SDK connection reuses id 1 for a different request.
        await writer.write({ jsonrpc: '2.0', id: 1, method: 'later', params: {} });
        expect((await reader.read()).value).toMatchObject({ id: 1, result: { answeredFor: 'later' } });
        expect(await held[0]!.response).toEqual({ result: { answeredFor: 'slow' } });
        expect((await readLog(log)).filter(entry => entry.method === 'initialize')).toHaveLength(1);

        await second.dispose('caller');
    }, 30_000);

    it('Codex app-server shape: the replayed turn progress and completion reach the adopting client once, with no gap', async () => {
        const log = join(directory, 'app-server.log');
        const socketPath = createSessionHolderSocketPath();
        const launch = { command: process.execPath, args: [join(directory, 'app-server.mjs')], env: { ...process.env, T_LOG: log } };
        const open = (holder: Parameters<typeof spawnSupervisedPluginProcess>[0]['sessionHolder']) => {
            const supervised = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true, sessionHolder: holder });
            const client = createJsonRpcProcessClient({ stdout: supervised.child.stdout,
                write: async data => supervised.handle.write(typeof data === 'string' ? new Uint8Array(Buffer.from(data)) : data),
                sessionHolderAdoption: deliver => createSessionHolderAdoption({ child: supervised.child, handshake: JSON_RPC_INITIALIZE_HANDSHAKE, deliver }) });
            const seen: number[] = [];
            let completed = 0;
            client.subscribeNotification(({ method, params }) => {
                if (method === 'item/agentMessage/delta') seen.push((params as { n: number }).n);
                if (method === 'turn/completed') completed += 1;
            });
            return { supervised, client, seen, completions: () => completed };
        };
        const first = open({ kind: 'spawn', executablePath: holderExecutable, socketPath, role: 'primary' });
        await first.client.client.request('initialize', {});
        await first.client.client.notify('initialized');
        await first.client.client.request('turn/start', {});
        own(first.supervised.child as SessionHolderChild);
        while (first.seen.length < 10) await new Promise(resolve => setTimeout(resolve, 10));
        const agentPid = first.supervised.child.pid;
        (first.supervised.child as SessionHolderChild).detach();
        first.client.dispose();

        const second = open({ kind: 'adopt', socketPath, role: 'primary' });
        await second.client.client.request('initialize', {});
        await second.client.client.notify('initialized');
        expect(second.supervised.child.pid).toBe(agentPid);
        const deadline = Date.now() + 10_000;
        while (second.completions() === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        expect(second.completions()).toBe(1);
        // Runner 1 saw a prefix; the adopter continues from what was not acknowledged.
        const union = [...new Set([...first.seen, ...second.seen])].sort((a, b) => a - b);
        expect(union).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
        expect(second.seen).toEqual([...second.seen].sort((a, b) => a - b));
        expect(new Set(second.seen).size).toBe(second.seen.length);
        const methods = (await readFile(log, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { method: string }).method);
        expect(methods).toEqual(['initialize', 'initialized', 'turn/start']);
        await second.supervised.dispose('caller');
    }, 30_000);

    it('Claude stream-json shape: the control initialize is answered locally and the replayed result reaches the adopter once', async () => {
        const log = join(directory, 'stream-json.log');
        const socketPath = createSessionHolderSocketPath();
        const launch = { command: process.execPath, args: [join(directory, 'stream-json.mjs')], env: { ...process.env, T_LOG: log } };
        const open = (holder: Parameters<typeof spawnSupervisedPluginProcess>[0]['sessionHolder']) => {
            const supervised = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true, sessionHolder: holder });
            const stream = createJsonStreamProcessClient({ process: adaptStablePluginExecLegacyProcessHandle(supervised),
                stdout: supervised.child.stdout, write: async data => supervised.handle.write(new Uint8Array(Buffer.from(data))),
                sessionHolderAdoption: deliver => createSessionHolderAdoption({ child: supervised.child, handshake: JSON_STREAM_CONTROL_HANDSHAKE, deliver }) });
            const records: Record<string, unknown>[] = [];
            stream.client.subscribe(record => { records.push(record as Record<string, unknown>); });
            return { supervised, stream, records };
        };
        const control = { type: 'control_request', request_id: 'claude-sdk-control-1', request: { subtype: 'initialize', hooks: {} } };
        const answered = (records: Record<string, unknown>[]) => records.some(record => record.type === 'control_response');
        const first = open({ kind: 'spawn', executablePath: holderExecutable, socketPath, role: 'primary' });
        await first.stream.client.writeRecord(control);
        while (!answered(first.records)) await new Promise(resolve => setTimeout(resolve, 10));
        own(first.supervised.child as SessionHolderChild);
        await first.stream.client.writeRecord({ type: 'user', message: { role: 'user', content: 'hi' } });
        while (first.records.filter(record => record.type === 'assistant').length < 10) await new Promise(resolve => setTimeout(resolve, 10));
        const agentPid = first.supervised.child.pid;
        (first.supervised.child as SessionHolderChild).detach();
        first.stream.dispose();

        const second = open({ kind: 'adopt', socketPath, role: 'primary' });
        // Attach is asynchronous; wait for it explicitly rather than on any write timing.
        if (second.supervised.child.pid === undefined) await new Promise(resolve => second.supervised.child.once('spawn', resolve));
        expect(second.supervised.child.pid).toBe(agentPid);
        await second.stream.client.writeRecord(control);
        const deadline = Date.now() + 10_000;
        while (!second.records.some(record => record.type === 'result') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        expect(answered(second.records)).toBe(true);
        expect(second.records.filter(record => record.type === 'result')).toHaveLength(1);
        const numbers = (records: Record<string, unknown>[]) => records.filter(record => record.type === 'assistant').map(record => record.n as number);
        const union = [...new Set([...numbers(first.records), ...numbers(second.records)])].sort((a, b) => a - b);
        expect(union).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
        expect(new Set(numbers(second.records)).size).toBe(numbers(second.records).length);
        const sent = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string });
        expect(sent.map(record => record.type)).toEqual(['control_request', 'user']);
        await second.supervised.dispose('caller');
    }, 30_000);

    it('Pi command/response shape: the turn finishes on the adopter once the session read answered, with no gap, no duplicate and no prompt re-sent', async () => {
        const log = join(directory, 'command-response.log');
        const socketPath = createSessionHolderSocketPath();
        const launch = { command: process.execPath, args: [join(directory, 'command-response.mjs')], env: { ...process.env, T_LOG: log } };
        const open = (holder: Parameters<typeof spawnSupervisedPluginProcess>[0]['sessionHolder']) => {
            const supervised = spawnSupervisedPluginProcess({ ...launch, pipeStdout: true, sessionHolder: holder });
            const stream = createJsonStreamProcessClient({ process: adaptStablePluginExecLegacyProcessHandle(supervised),
                stdout: supervised.child.stdout, write: async data => supervised.handle.write(new Uint8Array(Buffer.from(data))),
                sessionHolderAdoption: deliver => createSessionHolderAdoption({ child: supervised.child,
                    handshake: JSON_STREAM_ADOPT_HANDSHAKES.commandResponse, deliver }) });
            const records: Record<string, unknown>[] = [];
            stream.client.subscribe(record => { records.push(record as Record<string, unknown>); });
            return { supervised, stream, records };
        };
        const answeredFor = (records: Record<string, unknown>[], id: string) => records.some(record => record.type === 'response' && record.id === id);
        const updates = (records: Record<string, unknown>[]) => records.filter(record => record.type === 'message_update').map(record => record.n as number);

        const first = open({ kind: 'spawn', executablePath: holderExecutable, socketPath, role: 'primary' });
        await first.stream.client.writeRecord({ type: 'get_state', id: 'state-1' });
        while (!answeredFor(first.records, 'state-1')) await new Promise(resolve => setTimeout(resolve, 10));
        own(first.supervised.child as SessionHolderChild);
        await first.stream.client.writeRecord({ type: 'prompt', id: 'prompt-1', message: 'hi' });
        while (updates(first.records).length < 10) await new Promise(resolve => setTimeout(resolve, 10));
        const agentPid = first.supervised.child.pid;
        (first.supervised.child as SessionHolderChild).detach();
        first.stream.dispose();

        const second = open({ kind: 'adopt', socketPath, role: 'primary' });
        if (second.supervised.child.pid === undefined) await new Promise(resolve => second.supervised.child.once('spawn', resolve));
        expect(second.supervised.child.pid).toBe(agentPid);
        // A fresh runtime reuses its local ids: the adopt contract keeps them apart on the wire.
        await second.stream.client.writeRecord({ type: 'get_state', id: 'state-1' });
        const deadline = Date.now() + 10_000;
        while (!second.records.some(record => record.type === 'agent_end') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        // The session read is answered first, under the adopter's own id; the held turn follows.
        expect(second.records[0]).toMatchObject({ type: 'response', id: 'state-1', data: { sessionId: 'pi-session-1' } });
        expect(second.records.filter(record => record.type === 'agent_end')).toHaveLength(1);
        expect(second.records.some(record => record.type === 'agent_start')).toBe(false);
        const union = [...new Set([...updates(first.records), ...updates(second.records)])].sort((a, b) => a - b);
        expect(union).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
        expect(updates(second.records)).toEqual([...updates(second.records)].sort((a, b) => a - b));
        expect(new Set(updates(second.records)).size).toBe(updates(second.records).length);
        const sent = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; id: string });
        expect(sent.map(record => record.type)).toEqual(['get_state', 'prompt', 'get_state']);
        expect(new Set(sent.map(record => record.id)).size).toBe(sent.length);
        await second.supervised.dispose('caller');
    }, 30_000);
});
