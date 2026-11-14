import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientSpec } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { createJsonStreamProcessClient } from '@/plugins/runtime/exec/jsonStream';
import { adaptStablePluginExecLegacyProcessHandle } from '@/plugins/runtime/invocation/services/exec';

import { createSessionHolderSocketPath, SessionHolderChild } from './sessionHolder';
import { createSessionHolderAdoption, JSON_STREAM_ADOPT_HANDSHAKES } from './sessionHolderAdoption';
import { createClaudeAgentSdkTurnOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSdkQueryContext } from '../../../../../packages/plugins/claude/src/agent/sdk/nativeExec';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import {
    createEventsFixture,
    createPluginContextFixture,
    createTerminalHostFixture,
} from '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

/**
 * A runner crash mid-turn with the real holder, the real Claude SDK runtime
 * (`remote/sdk/session.ts`, its query and native exec adapter) and the host
 * JSON-stream client with the adopt contract. Only the Claude CLI is a
 * fixture, and the exec service is reduced to the protocol-client spawn the
 * Claude adapter calls (the holder launch the host decides is chosen here).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const prebuiltHolder = process.env.HAPPIER_SESSION_HOLDER_TEST_EXECUTABLE;
const cargoAvailable = Boolean(prebuiltHolder) || spawnSync('cargo', ['--version']).status === 0;

// Claude Code stream-json: control requests answered, a user message is echoed
// (its receipt), then 40 text deltas and one result for that prompt.
const CLAUDE_CLI_SOURCE = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = entry => appendFileSync(process.env.T_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
const send = record => process.stdout.write(JSON.stringify(record) + '\n');
log({ type: 'started' });
createInterface({ input: process.stdin }).on('line', line => {
  const record = JSON.parse(line);
  log({ type: record.type, subtype: record.request?.subtype ?? null });
  if (record.type === 'control_request') {
    return send({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: {} } });
  }
  if (record.type !== 'user') return;
  send({ ...record, isReplay: true, parent_tool_use_id: null, session_id: 'native-held-1' });
  send({ type: 'system', subtype: 'init', session_id: 'native-held-1' });
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    send({ type: 'stream_event', session_id: 'native-held-1', parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[' + n + ']' } } });
    if (n === 40) {
      clearInterval(timer);
      send({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'native-held-1',
        user_message_uuids: [record.uuid] });
    }
  }, 20);
});
`;

type Runner = Readonly<{
    deltas: number[];
    events: { kind: string; turnId?: string; startedBy?: string }[];
    crash(): void;
    launches: () => number;
}>;

const describeHolder = cargoAvailable ? describe : describe.skip;

describeHolder('Claude SDK runtime adopts a held Agent after a runner crash', () => {
    let directory: string;
    let holderExecutable: string;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'happier-holder-claude-'));
        await writeFile(join(directory, 'claude.mjs'), CLAUDE_CLI_SOURCE);
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

    // Never leave a held Agent behind: end every holder and Agent started here (exact PIDs).
    const started = new Set<number>();
    afterEach(() => {
        for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
        started.clear();
    });

    /** One runner: the Claude runtime over an exec whose Agent launches use `holder`. */
    function openRunner(input: Readonly<{ log: string; socketPath: string; holder: 'spawn' | 'adopt'; adoptsHeldAgent: boolean }>) {
        let crashed = false;
        let launches = 0;
        const specs: PluginProtocolClientSpec[] = [];
        const children: SessionHolderChild[] = [];
        const disposers: (() => void)[] = [];
        const exec = {
            systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', toolId: 'claude-cli' } }) },
            clients: {
                async spawn(spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>) {
                    launches += 1;
                    specs.push(spec);
                    const supervised = spawnSupervisedPluginProcess({
                        command: process.execPath, args: [join(directory, 'claude.mjs')],
                        env: { ...process.env, T_LOG: input.log }, pipeStdout: true,
                        sessionHolder: input.holder === 'spawn' && launches === 1
                            ? { kind: 'spawn', executablePath: holderExecutable, socketPath: input.socketPath, role: 'primary' }
                            : { kind: 'adopt', socketPath: input.socketPath, role: 'primary' },
                    });
                    const child = supervised.child as SessionHolderChild;
                    children.push(child);
                    // Mirrors the host's spawnJsonStreamClient: the declared shape selects the handshake.
                    const handshake = spec.adoptsHeldAgentTurns ? JSON_STREAM_ADOPT_HANDSHAKES[spec.adoptsHeldAgentTurns] : null;
                    const protocol = createJsonStreamProcessClient({
                        process: adaptStablePluginExecLegacyProcessHandle(supervised),
                        stdout: supervised.child.stdout,
                        write: async data => supervised.handle.write(new Uint8Array(Buffer.from(data))),
                        maxFrameBytes: spec.maxFrameBytes,
                        ...(handshake ? { sessionHolderAdoption: (deliver: (record: Record<string, unknown>) => void) =>
                            createSessionHolderAdoption({ child: supervised.child, handshake, deliver }) } : {}),
                    });
                    disposers.push(() => protocol.dispose());
                    const subscription = (listener: (value: unknown) => void | Promise<void>) => {
                        const off = protocol.client.subscribe(record => (crashed ? undefined : listener(record)));
                        return { dispose: off, [Symbol.dispose]: off };
                    };
                    // A crashed runner can no longer end anything.
                    const dispose = async () => { if (!crashed) { protocol.dispose(); await supervised.dispose('caller'); } };
                    return {
                        client: {
                            ...(handshake ? { heldAgentTurn: protocol.sessionHolderAdoption?.heldTurn ?? Promise.resolve('none') } : {}),
                            async write(value: unknown) {
                                const outcome = await protocol.client.writeRecord(value as never);
                                if (outcome.kind !== 'written') throw outcome.error;
                            },
                            subscribe: subscription,
                            [Symbol.dispose]() {},
                        },
                        process: { ...supervised.handle, dispose },
                        wait: () => supervised.handle.wait(),
                        dispose,
                        [Symbol.dispose]() {},
                    };
                },
            },
        } as unknown as ExecService;
        const fixture = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
            { exec: createClaudeNativeSdkQueryContext(exec) });
        const ctx = { ...fixture, agentRuntime: { ...fixture.agentRuntime,
            ...(input.adoptsHeldAgent ? { adoptsHeldAgent: true } : {}) } };
        const operations = createClaudeAgentSdkTurnOperations({ ctx, directory, launchEnv: {}, happierSessionId: 'held-session',
            permissionMode: 'default', publishTranscriptMessages: true });
        const context = { session: { services: {
            activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
        } } } as unknown as AgentSessionRuntimeContext;
        const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
            { kind: 'create', sessionId: 'held-session', cwd: directory }, context);
        const events: Runner['events'] = [];
        const deltas: number[] = [];
        runtime.watch((event: AgentSessionRuntimeEvent) => {
            events.push(event as Runner['events'][number]);
            if (event.kind === 'message-delta') {
                for (const match of event.text.matchAll(/\[(\d+)\]/gu)) deltas.push(Number(match[1]));
            }
        });
        const runner: Runner & Readonly<{ operations: typeof operations; specs: PluginProtocolClientSpec[]; children: SessionHolderChild[] }> = {
            operations, specs, children, deltas, events, launches: () => launches,
            crash() {
                crashed = true;
                for (const child of children) child.detach();
                for (const dispose of disposers) dispose();
            },
        };
        return runner;
    }

    const until = async (condition: () => boolean, ms = 15_000) => {
        const deadline = Date.now() + ms;
        while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    };

    it('the respawned runtime surfaces the rest of the crashed turn once, without a second launch, handshake or prompt', async () => {
        const log = join(directory, 'claude.log');
        const socketPath = createSessionHolderSocketPath();

        const first = openRunner({ log, socketPath, holder: 'spawn', adoptsHeldAgent: false });
        first.operations.beginProviderTurn('host-turn-1');
        await expect(first.operations.sendProviderTurnPrompt('hello')).resolves.toEqual({ kind: 'accepted' });
        const held = first.children[0]!;
        if (held.pid) started.add(held.pid);
        if (held.holderPid) started.add(held.holderPid);
        await until(() => first.deltas.length >= 10);
        expect(first.specs[0]).toMatchObject({ kind: 'jsonStream', adoptsHeldAgentTurns: 'streamJsonControl' });
        const agentPid = held.pid;
        first.crash();

        const second = openRunner({ log, socketPath, holder: 'adopt', adoptsHeldAgent: true });
        // A control request at open goes to the adopting query, not to a second Agent launch.
        void second.operations.updateProviderConfiguration({ configOption: { id: 'context_usage_refresh', value: 1 } });
        await until(() => second.events.some(event => event.kind === 'turn-complete' || event.kind === 'turn-failed'));

        expect(second.children[0]?.pid).toBe(agentPid);
        const turns = second.events.filter(event => event.kind.startsWith('turn-'));
        expect(turns.map(event => event.kind)).toEqual(['turn-start', 'turn-complete']);
        expect(turns[0]).toMatchObject({ startedBy: 'provider' });
        expect(turns[1]?.turnId).toBe(turns[0]?.turnId);
        const union = [...new Set([...first.deltas, ...second.deltas])].sort((a, b) => a - b);
        expect(union).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
        expect(new Set(second.deltas).size).toBe(second.deltas.length);
        expect(second.launches()).toBe(1);
        const sent = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; type: string; subtype: string | null });
        expect(new Set(sent.map(entry => entry.pid))).toEqual(new Set([agentPid]));
        expect(sent.filter(entry => entry.type === 'started')).toHaveLength(1);
        expect(sent.filter(entry => entry.subtype === 'initialize')).toHaveLength(1);
        expect(sent.filter(entry => entry.type === 'user')).toHaveLength(1);

        await second.operations.disposeProviderSession();
    }, 60_000);

    it('a prompt sent at once after the respawn waits for the adoption: the held turn is neither lost nor its Agent ended', async () => {
        const log = join(directory, 'claude-prompt.log');
        const socketPath = createSessionHolderSocketPath();
        const first = openRunner({ log, socketPath, holder: 'spawn', adoptsHeldAgent: false });
        first.operations.beginProviderTurn('host-turn-1');
        await expect(first.operations.sendProviderTurnPrompt('hello')).resolves.toEqual({ kind: 'accepted' });
        const held = first.children[0]!;
        if (held.pid) started.add(held.pid);
        if (held.holderPid) started.add(held.holderPid);
        await until(() => first.deltas.length >= 10);
        const agentPid = held.pid;
        first.crash();

        const second = openRunner({ log, socketPath, holder: 'adopt', adoptsHeldAgent: true });
        // Before any replayed output: the adoption decides from the holder's state, not from silence.
        second.operations.beginProviderTurn('host-turn-2');
        const prompt = await second.operations.sendProviderTurnPrompt('next');
        await until(() => second.events.some(event => event.kind === 'turn-complete' || event.kind === 'turn-failed'));

        // The held turn still runs, so the prompt meets it as any prompt meets a running turn.
        expect(prompt).toMatchObject({ kind: 'rejected_before_effect' });
        expect(second.children[0]?.pid).toBe(agentPid);
        const adopted = second.events.filter(event => event.kind.startsWith('turn-') && event.turnId !== 'host-turn-2');
        expect(adopted.map(event => event.kind)).toEqual(['turn-start', 'turn-complete']);
        expect(adopted[0]).toMatchObject({ startedBy: 'provider' });
        const union = [...new Set([...first.deltas, ...second.deltas])].sort((a, b) => a - b);
        expect(union).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
        expect(second.launches()).toBe(1);
        const sent = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; type: string });
        expect(sent.filter(entry => entry.type === 'started')).toHaveLength(1);
        expect(sent.filter(entry => entry.type === 'user')).toHaveLength(1);

        await second.operations.disposeProviderSession();
    }, 60_000);
});
