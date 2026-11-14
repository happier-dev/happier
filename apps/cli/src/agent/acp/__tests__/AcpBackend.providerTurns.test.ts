import { readFile, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AcpBackend } from '../AcpBackend';
import { createAcpBackend } from '../createAcpBackend';
import type { AcpProviderTurnSource, AcpProviderTurnSourceHost } from '../backend/turn/providerTurns';
import { createAcpTestTransportHandler, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDeferred } from '@/testkit/async/deferred';
import { isPidAlive } from '@/testkit/process/spawn';
import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import type { AgentMessage } from '@/agent/core';
import type { PermissionMode } from '@/api/types';

function agent(directory: string): string {
    return writeAcpTestAgentScript({
        dir: directory, fileName: 'provider-turns.mjs',
        source: `
            let buffer = '';
            let turn = 0;
            let closes = 0;
            let loads = 0;
            let holdClose = false;
            let holdLoad = false;
            let loadingRequest = null;
            let closingRequest = null;
            const awaiting = new Map();
            const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
            const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
            const notify = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'owned', update } });
            process.stdin.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\\n'); buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const message = JSON.parse(line);
                    if (!message.method && awaiting.has(message.id)) {
                        ok(awaiting.get(message.id), message.result ?? { error: message.error });
                        awaiting.delete(message.id); continue;
                    }
                    if (message.method === 'initialize') ok(message.id, {
                        protocolVersion: 1, authMethods: [],
                        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, fork: {} } },
                    });
                    else if (message.method === 'session/new' || message.method === 'session/fork') ok(message.id, { sessionId: 'owned' });
                    else if (message.method === 'session/load') { loads++; if (holdLoad) loadingRequest = message.id; else ok(message.id, {}); }
                    else if (message.method === 'session/close') {
                        closes++;
                        if (holdClose) closingRequest = message.id;
                        else ok(message.id, {});
                    } else if (message.method === 'test/hold-close') { holdClose = true; ok(message.id, {}); }
                    else if (message.method === 'test/release-close') {
                        if (closingRequest !== null) ok(closingRequest, {});
                        closingRequest = null; holdClose = false; ok(message.id, {});
                    }
                    else if (message.method === 'test/hold-load') { holdLoad = true; ok(message.id, {}); }
                    else if (message.method === 'test/release-load') {
                        if (loadingRequest !== null) ok(loadingRequest, {});
                        loadingRequest = null; holdLoad = false; ok(message.id, {});
                    }
                    else if (message.method === 'session/prompt') {
                        const id = turn++ + ':background';
                        notify({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'fixture' } });
                        notify({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: 'started' });
                        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREGROUND' } });
                        ok(message.id, { stopReason: 'end_turn' });
                    } else if (message.method === 'test/late') {
                        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE_FOREGROUND' } });
                        ok(message.id, {});
                    } else if (message.method === 'test/permission') {
                        awaiting.set('permission', message.id);
                        send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: {
                            sessionId: message.params.sessionId ?? 'owned',
                            toolCall: { toolCallId: message.params.toolCallId, title: 'Bash', kind: 'execute', rawInput: { command: 'fixture' } },
                            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
                        } });
                    } else if (message.method === 'test/write' || message.method === 'test/read') {
                        const write = message.method === 'test/write';
                        awaiting.set('filesystem', message.id);
                        send({ jsonrpc: '2.0', id: 'filesystem', method: write ? 'fs/write_text_file' : 'fs/read_text_file', params: {
                            sessionId: message.params.sessionId ?? 'owned', path: message.params.path,
                            ...(write ? { content: 'fixture' } : {}),
                        } });
                    } else if (message.method === 'test/environment') ok(message.id, {
                        retained: process.env.HAPPIER_TEST_OBSERVER_RETAINED,
                        removed: process.env.HAPPIER_TEST_OBSERVER_REMOVED,
                        overridden: process.env.HAPPIER_TEST_OBSERVER_OVERRIDDEN,
                    });
                    else if (message.method === 'test/status') ok(message.id, { pid: process.pid, closes, loads });
                    else if (message.id !== undefined) ok(message.id, {});
                }
            });
        `,
    });
}

async function fixture(run: (input: {
    backend: AcpBackend;
    host(): AcpProviderTurnSourceHost;
    events: AgentMessage[];
    permissionSession: FakePermissionSession;
    permissionHandler: ProviderEnforcedPermissionHandler;
    setPermissionMode(mode: PermissionMode): void;
    setCatchUp(handler: AcpProviderTurnSource['catchUp']): void;
    setDispose(handler: AcpProviderTurnSource['dispose']): void;
    directory: string;
}) => Promise<void>, initTimeoutMs?: number): Promise<void> {
    await withTempDir('acp-provider-turn-', async directory => {
        const permissionSession = new FakePermissionSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(permissionSession.asApiSessionClient(), { logPrefix: '[fixture]' });
        vi.spyOn(permissionHandler, 'handleToolCall');
        let mode: PermissionMode = 'default';
        let currentHost: AcpProviderTurnSourceHost | undefined;
        let catchUp: AcpProviderTurnSource['catchUp'] = async () => {};
        let dispose: AcpProviderTurnSource['dispose'] = () => {};
        const events: AgentMessage[] = [];
        const backend = createAcpBackend({
            agentName: 'fixture', cwd: directory, command: process.execPath, args: [agent(directory)],
            permissionHandler, getPermissionMode: () => mode,
            ...(initTimeoutMs === undefined ? {} : { transportHandler: createAcpTestTransportHandler({ initTimeoutMs }) }),
            providerTurnSource: async host => {
                currentHost = host;
                return { catchUp: input => catchUp(input), dispose: () => dispose() };
            },
        });
        backend.onMessage(event => { events.push(event); });
        let pid: number | undefined;
        try {
            await backend.startSession();
            pid = (await backend.requestExtension<{ pid: number }>('test/status', {})).pid;
            await run({
                backend, events, permissionSession, permissionHandler, directory,
                host() { if (!currentHost) throw new Error('Provider turn source was not opened'); return currentHost; },
                setPermissionMode(value) { mode = value; permissionHandler.setPermissionMode(value); },
                setCatchUp(value) { catchUp = value; },
                setDispose(value) { dispose = value; },
            });
        } finally {
            try { await backend.dispose(); }
            finally { if (pid && isPidAlive(pid)) process.kill(pid, 'SIGKILL'); }
        }
    });
}

async function approve(session: FakePermissionSession): Promise<void> {
    await expect.poll(() => Object.keys(session.snapshot().requests ?? {})).not.toHaveLength(0);
    const id = Object.keys(session.snapshot().requests ?? {})[0]!;
    await session.rpcHandlerManager.dispatchPermission({ id, approved: true, decision: 'approved' });
}

describe('ACP provider continuation ownership', () => {
    it('preserves independent usage report identities across continuations and repeated step updates', async () => {
        await fixture(async ({ backend, host, events }) => {
            for (let turn = 0; turn < 2; turn += 1) {
                await backend.sendPrompt('owned', 'start background');
                await backend.waitForResponseComplete();
                expect(host().registerContinuation({ id: `task-${turn}`, parentToolCallId: `${turn}:background` })).toBe(true);
                const sink = host().beginContinuation({ id: `task-${turn}`, turnId: `native-${turn}` });
                expect(sink).not.toBeNull();
                for (const [step, output] of [[0, 2], [1, 3], [0, 2], [1, 4]] as const) {
                    await sink!.update({ sessionUpdate: 'usage_update', key: `step-${turn}-${step}`, inputTokens: 10, outputTokens: output });
                }
                await sink!.finish({ kind: 'completed', stopReason: 'end_turn' });
            }
            const usage = events.filter((event): event is Extract<AgentMessage, { type: 'token-count' }> => event.type === 'token-count');
            expect(usage.map(event => event.key)).toEqual([
                'step-0-0', 'step-0-1', 'step-0-0', 'step-0-1',
                'step-1-0', 'step-1-1', 'step-1-0', 'step-1-1',
            ]);
            expect(usage.map(event => event.tokens)).toEqual([12, 13, 12, 14, 12, 13, 12, 14].map(total => expect.objectContaining({ total })));
        });
    });

    it('observes the same effective environment as the spawned ACP process', async () => {
        await withTempDir('acp-observer-env-', async directory => {
            vi.stubEnv('HAPPIER_TEST_OBSERVER_RETAINED', 'inherited');
            vi.stubEnv('HAPPIER_TEST_OBSERVER_REMOVED', 'unset-in-child');
            vi.stubEnv('HAPPIER_TEST_OBSERVER_OVERRIDDEN', 'inherited-override');
            let observerEnv: NodeJS.ProcessEnv | undefined;
            const backend = createAcpBackend({
                agentName: 'fixture', cwd: directory, command: process.execPath, args: [agent(directory)],
                unsetEnv: ['happier_test_observer_removed'],
                env: { HAPPIER_TEST_OBSERVER_OVERRIDDEN: 'explicit' },
                prepareProcessLaunch: async () => ({ env: { HAPPIER_TEST_OBSERVER_OVERRIDDEN: 'prepared' } }),
                providerTurnSource: async host => {
                    observerEnv = host.env;
                    return { catchUp: async () => {}, dispose() {} };
                },
            });
            try {
                await backend.startSession();
                const nativeEnv = await backend.requestExtension('test/environment', {});
                expect(observerEnv).toBeDefined();
                expect({
                    retained: observerEnv?.HAPPIER_TEST_OBSERVER_RETAINED,
                    removed: observerEnv?.HAPPIER_TEST_OBSERVER_REMOVED,
                    overridden: observerEnv?.HAPPIER_TEST_OBSERVER_OVERRIDDEN,
                }).toEqual(nativeEnv);
                expect(nativeEnv).toEqual({ retained: 'inherited', overridden: 'prepared' });
            } finally {
                await backend.dispose();
                vi.unstubAllEnvs();
            }
        });
    });

    it('retains originating policy after a later foreground and uses canonical updates and plan settlement', async () => {
        await fixture(async ({ backend, host, events, permissionSession, permissionHandler, setPermissionMode, directory }) => {
            await backend.sendPrompt('owned', 'first');
            await backend.waitForResponseComplete();
            expect(host().registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
            setPermissionMode('yolo');
            await backend.sendPrompt('owned', 'second');
            await backend.waitForResponseComplete();
            events.length = 0;
            const sink = host().beginContinuation({ id: 'task', turnId: 'native-2' });
            expect(sink).not.toBeNull();
            await backend.requestExtension('test/late', {});
            expect(events.some(event => event.type === 'model-output' && event.textDelta === 'LATE_FOREGROUND')).toBe(false);
            const permission = backend.requestExtension('test/permission', { toolCallId: '2:execute' });
            await approve(permissionSession);
            expect(await permission).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
            const write = backend.requestExtension('test/write', { path: join(directory, 'created.txt') });
            await write;
            expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
                expect.any(String), 'writeTextFile', expect.objectContaining({ path: join(directory, 'created.txt') }),
                { permissionMode: 'default' },
            );
            expect(await readFile(join(directory, 'created.txt'), 'utf8')).toBe('fixture');

            const planGate = createDeferred();
            const planRequested = createDeferred();
            backend.setPlanStatePublisher(async () => { planRequested.resolve(); await planGate.promise; });
            const plan = sink!.update({ sessionUpdate: 'plan', entries: [{ content: 'Verify', status: 'in_progress', priority: 'medium' }] });
            await planRequested.promise;
            const output = sink!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CONTINUATION' } });
            const terminal = sink!.finish({ kind: 'completed', stopReason: 'end_turn' });
            expect(events.some(event => event.type === 'status' && event.turnFinished)).toBe(false);
            planGate.resolve();
            await Promise.all([plan, output, terminal]);
            expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'CONTINUATION' }));
            expect(events.at(-1)).toEqual({ type: 'status', status: 'idle', turnFinished: true });
        });
    });

    it('rejects unknown, reused, released and stale sources and concurrent foreground admission', async () => {
        await fixture(async ({ backend, host }) => {
            const original = host();
            expect(await backend.requestExtension('test/permission', {
                sessionId: 'foreign', toolCallId: 'foreign-tool',
            })).toEqual({ outcome: { outcome: 'cancelled' } });
            expect(original.registerContinuation({ id: 'forged', parentToolCallId: 'missing' })).toBe(false);
            expect(original.beginContinuation({ id: 'missing', turnId: 'native-x' })).toBeNull();
            await backend.sendPrompt('owned', 'first');
            await backend.waitForResponseComplete();
            expect(original.registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
            expect(original.registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(false);
            const sink = original.beginContinuation({ id: 'task', turnId: 'native-1' });
            expect(sink).not.toBeNull();
            expect(original.beginContinuation({ id: 'task', turnId: 'native-2' })).toBeNull();
            await expect(backend.sendPrompt('owned', 'overlap')).rejects.toThrow();
            await sink!.finish({ kind: 'completed', stopReason: 'end_turn' });
            original.releaseToolCalls(['0:background']);
            expect(original.registerContinuation({ id: 'released', parentToolCallId: '0:background' })).toBe(false);
            await backend.dispose();
            expect(original.beginContinuation({ id: 'task', turnId: 'native-3' })).toBeNull();
            await sink!.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } });
        });
    });

    it('withdraws permissions when the native source cannot prove their owner', async () => {
        await fixture(async ({ backend, host, permissionHandler, setCatchUp, setPermissionMode }) => {
            const observations: Array<Parameters<AcpProviderTurnSource['catchUp']>[0]> = [];
            setCatchUp(async input => {
                observations.push(input);
                if (input?.permissionToolCallId) throw new Error('The requested native turn is stale');
            });
            await backend.sendPrompt('owned', 'first');
            await backend.waitForResponseComplete();
            expect(observations.some(input => input?.foregroundActive)).toBe(true);
            host().registerContinuation({ id: 'task', parentToolCallId: '0:background' });
            const sink = host().beginContinuation({ id: 'task', turnId: 'native-1' });
            setPermissionMode('yolo');
            expect(await backend.requestExtension('test/permission', { toolCallId: 'stale:execute' }))
                .toEqual({ outcome: { outcome: 'cancelled' } });
            expect(observations.at(-1)).toMatchObject({ permissionToolCallId: 'stale:execute', foregroundActive: false });
            expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
            await sink!.finish({ kind: 'completed', stopReason: 'end_turn' });
        });
    });


    it.each([
        ['read', 'idle'], ['write', 'idle'], ['read', 'foreign'], ['write', 'foreign'],
    ] as const)('rejects %s filesystem requests with %s turn ownership', async (operation, ownership) => {
        await fixture(async ({ backend, host, permissionHandler, setPermissionMode, directory }) => {
            await backend.sendPrompt('owned', 'first');
            await backend.waitForResponseComplete();
            host().registerContinuation({ id: 'task', parentToolCallId: '0:background' });
            if (ownership === 'foreign') {
                expect(host().beginContinuation({ id: 'task', turnId: 'native-1' })).not.toBeNull();
            }
            setPermissionMode('yolo');
            const path = join(directory, 'protected.txt');
            await writeFile(path, 'ORIGINAL');
            expect(await backend.requestExtension('test/' + operation, {
                path, sessionId: ownership === 'foreign' ? 'foreign' : 'owned',
            })).toHaveProperty('error');
            expect(await readFile(path, 'utf8')).toBe('ORIGINAL');
            expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
        });
    });

    it.each(['prompt', 'cancel', 'write'] as const)('keeps %s admission behind an in-flight provider cancellation', async (operation) => {
        await fixture(async ({ backend, host, events, permissionHandler, setPermissionMode, directory }) => {
            await backend.sendPrompt('owned', 'first');
            await backend.waitForResponseComplete();
            host().registerContinuation({ id: 'task', parentToolCallId: '0:background' });
            await backend.requestExtension('test/hold-close', {});
            const cancellation = backend.cancel('owned');
            let concurrentCancel: Promise<void> | undefined;
            try {
                await expect.poll(async () => (await backend.requestExtension<{ closes: number }>('test/status', {})).closes).toBe(1);
                if (operation === 'prompt') {
                    events.length = 0;
                    await expect(backend.sendPrompt('owned', 'too soon')).rejects.toMatchObject({
                        name: 'AcpPromptSubmissionPhaseError', phase: 'rejected_before_effect',
                    });
                    expect(events.some(event => event.type === 'model-output')).toBe(false);
                } else if (operation === 'write') {
                    setPermissionMode('yolo');
                    const path = join(directory, 'late-write.txt');
                    expect(await backend.requestExtension('test/write', { path })).toHaveProperty('error');
                    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
                } else {
                    let settled = false;
                    concurrentCancel = backend.cancel('owned').then(() => { settled = true; });
                    await backend.requestExtension('test/status', {});
                    expect(settled).toBe(false);
                }
            } finally {
                await backend.requestExtension('test/release-close', {});
                await cancellation;
                await concurrentCancel;
            }
            expect(await backend.requestExtension('test/status', {})).toMatchObject({ closes: 1, loads: 1 });
            await backend.sendPrompt('owned', 'after cancellation');
            await backend.waitForResponseComplete();
        });
    });

    it.each(['active', 'waiting'] as const)('closes and reloads the same ACP process when cancelling an %s provider task', async (state) => {
        await fixture(async ({ backend, host, events }) => {
            await backend.sendPrompt('owned', 'first');
            await backend.waitForResponseComplete();
            const original = host();
            original.registerContinuation({ id: 'task', parentToolCallId: '0:background' });
            const sink = state === 'active' ? original.beginContinuation({ id: 'task', turnId: 'native-1' }) : null;
            const before = await backend.requestExtension<{ pid: number }>('test/status', {});
            await backend.cancel('owned');
            expect(await backend.requestExtension('test/status', {})).toEqual({ pid: before.pid, closes: 1, loads: 1 });
            events.length = 0;
            expect(original.beginContinuation({ id: 'task', turnId: 'native-stale' })).toBeNull();
            await sink?.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } });
            await backend.sendPrompt('owned', 'after cancel');
            await backend.waitForResponseComplete();
            expect(events.some(event => event.type === 'model-output' && event.textDelta === 'stale')).toBe(false);
            expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'FOREGROUND' }));
        });
    });
});


it('does not let a cancelled filesystem write cross the mkdir boundary', async () => {
    await fixture(async ({ backend, host, directory, setPermissionMode, permissionHandler }) => {
        setPermissionMode('yolo');
        const path = join(directory, 'protected.txt');
        await writeFile(path, 'ORIGINAL');
        await backend.sendPrompt('owned', 'parent');
        await backend.waitForResponseComplete();
        expect(host().registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
        expect(host().beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
        const reached = createDeferred();
        const gate = createDeferred();
        let held = false;
        const mkdir = fs.mkdir.bind(fs);
        const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
            if (!held && String(args[0]) === directory) { held = true; reached.resolve(); await gate.promise; }
            return mkdir(...args);
        });
        try {
            const writing = backend.requestExtension('test/write', { path });
            await reached.promise;
            await backend.cancel('owned');
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
            expect(host().registerContinuation({ id: 'successor', parentToolCallId: '1:background' })).toBe(true);
            expect(host().beginContinuation({ id: 'successor', turnId: '3' })).not.toBeNull();
            const permissionCount = vi.mocked(permissionHandler.handleToolCall).mock.calls.length;
            gate.resolve();
            expect(await writing).toHaveProperty('error');
            expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(permissionCount);
            expect(await readFile(path, 'utf8')).toBe('ORIGINAL');
        } finally { gate.resolve(); spy.mockRestore(); }
    });
});

it('does not let a filesystem request borrow a new source after its old journal catch-up', async () => {
    await fixture(async ({ backend, host, directory, setPermissionMode, permissionHandler, setCatchUp }) => {
        setPermissionMode('yolo');
        const path = join(directory, 'protected.txt');
        await writeFile(path, 'ORIGINAL');
        await backend.sendPrompt('owned', 'parent');
        await backend.waitForResponseComplete();
        expect(host().registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
        expect(host().beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
        const reached = createDeferred();
        const gate = createDeferred();
        let held = false;
        setCatchUp(async () => {
            if (held) return;
            held = true;
            reached.resolve();
            await gate.promise;
        });
        try {
            const writing = backend.requestExtension('test/write', { path });
            await reached.promise;
            await backend.cancel('owned');
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
            expect(host().registerContinuation({ id: 'successor', parentToolCallId: '1:background' })).toBe(true);
            expect(host().beginContinuation({ id: 'successor', turnId: '3' })).not.toBeNull();
            gate.resolve();
            expect(await writing).toHaveProperty('error');
            expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
            expect(await readFile(path, 'utf8')).toBe('ORIGINAL');
        } finally { gate.resolve(); }
    });
});


it('withdraws an old filesystem read that settles after cancellation', async () => {
    await fixture(async ({ backend, host, directory }) => {
        const path = join(directory, 'protected.txt');
        await writeFile(path, 'ORIGINAL');
        await backend.sendPrompt('owned', 'parent');
        await backend.waitForResponseComplete();
        expect(host().registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
        expect(host().beginContinuation({ id: 'task', turnId: '1' })).not.toBeNull();
        const reached = createDeferred();
        const gate = createDeferred();
        const read = fs.readFile.bind(fs);
        let held = false;
        const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
            const result = await read(...args);
            if (!held && String(args[0]) === path) { held = true; reached.resolve(); await gate.promise; }
            return result;
        });
        try {
            const reading = backend.requestExtension('test/read', { path });
            await reached.promise;
            await backend.cancel('owned');
            gate.resolve();
            expect(await reading).toHaveProperty('error');
        } finally { gate.resolve(); spy.mockRestore(); }
    });
});


it('closes native work before waiting for a held provider plan publication', async () => {
    await fixture(async ({ backend, host, setDispose }) => {
        await backend.sendPrompt('owned', 'parent');
        await backend.waitForResponseComplete();
        expect(host().registerContinuation({ id: 'task', parentToolCallId: '0:background' })).toBe(true);
        const sink = host().beginContinuation({ id: 'task', turnId: 'native-1' });
        const reached = createDeferred();
        const gate = createDeferred();
        backend.setPlanStatePublisher(async () => { reached.resolve(); await gate.promise; });
        const publication = sink!.update({ sessionUpdate: 'plan', entries: [{ content: 'Work', status: 'in_progress', priority: 'medium' }] });
        await reached.promise;
        setDispose(() => publication);
        const cancellation = backend.cancel('owned');
        try {
            await expect.poll(async () => (await backend.requestExtension<{ closes: number }>('test/status', {})).closes).toBe(1);
        } finally {
            gate.resolve();
            await cancellation;
            await publication;
        }
        await backend.sendPrompt('owned', 'successor');
        await backend.waitForResponseComplete();
    });
});

it('restarts an unresponsive native close within the graceful teardown bound', async () => {
    await fixture(async ({ backend }) => {
        const before = await backend.requestExtension<{ pid: number }>('test/status', {});
        await backend.requestExtension('test/hold-close', {});
        const cancellation = backend.cancel('owned');
        let cancelled = false;
        void cancellation.then(() => { cancelled = true; });
        try {
            await expect.poll(() => cancelled, { timeout: 5_000 }).toBe(true);
            expect(isPidAlive(before.pid)).toBe(false);
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
            expect((await backend.requestExtension<{ pid: number }>('test/status', {})).pid).not.toBe(before.pid);
        } finally {
            if (!cancelled) await backend.requestExtension('test/release-close', {});
            await cancellation;
        }
    });
}, 10_000);

it.each(['cancel', 'dispose', 'source failure'] as const)('tears down native work when source disposal throws during %s', async operation => {
    await fixture(async ({ backend, host, setDispose }) => {
        const before = await backend.requestExtension<{ pid: number }>('test/status', {});
        setDispose(() => { throw new Error('Observer cleanup failed'); });
        if (operation === 'cancel') {
            await backend.cancel('owned');
            expect(await backend.requestExtension('test/status', {})).toMatchObject({ closes: 1, loads: 1 });
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
        } else if (operation === 'dispose') {
            await backend.dispose();
            expect(isPidAlive(before.pid)).toBe(false);
        } else {
            host().fail(new Error('Journal unavailable'));
            await expect.poll(() => isPidAlive(before.pid)).toBe(false);
            await backend.loadSession('owned');
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
        }
    });
});

it.each(['start', 'load', 'fork'] as const)('cleans up a failed %s journal initialization and allows retry', async operation => {
    await withTempDir('provider-init-failure-', async directory => {
        let first = true;
        let failedPid = 0;
        const backend = createAcpBackend({
            agentName: 'fixture', cwd: directory, command: process.execPath, args: [agent(directory)],
            providerTurnSource: async () => {
                if (first) {
                    first = false;
                    failedPid = (await backend.requestExtension<{ pid: number }>('test/status', {})).pid;
                    throw new Error('Journal unavailable');
                }
                return { catchUp: async () => {}, dispose() {} };
            },
        });
        const start = () => operation === 'start' ? backend.startSession()
            : operation === 'load' ? backend.loadSession('owned') : backend.forkSession({ sessionId: 'owned' });
        try {
            await expect(start()).rejects.toThrow('Journal unavailable');
            expect(failedPid).toBeGreaterThan(0);
            expect(isPidAlive(failedPid)).toBe(false);
            await start();
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
        } finally { await backend.dispose(); }
    });
});


it('bounds a stalled cancellation reload with the existing session startup deadline', async () => {
    await fixture(async ({ backend }) => {
        const before = await backend.requestExtension<{ pid: number }>('test/status', {});
        await backend.requestExtension('test/hold-load', {});
        let settled = false;
        const cancellation = backend.cancel('owned').then(() => null, error => error as Error)
            .finally(() => { settled = true; });
        try {
            await expect.poll(() => settled, { timeout: 2_000 }).toBe(true);
            expect(await cancellation).toBeInstanceOf(Error);
            expect(isPidAlive(before.pid)).toBe(false);
            await backend.loadSession('owned');
            await backend.sendPrompt('owned', 'successor');
            await backend.waitForResponseComplete();
        } finally {
            if (!settled) await backend.requestExtension('test/release-load', {});
            await cancellation;
        }
    }, 500);
});
