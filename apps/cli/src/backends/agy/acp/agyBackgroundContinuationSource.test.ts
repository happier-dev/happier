import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import type { AcpProviderTurnSourceHost } from '@/agent/acp/backend/turn/providerTurns';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import type { SessionUpdate } from '@/agent/acp/updates/types';
import type { AgentMessage } from '@/agent/core';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createDeferred } from '@/testkit/async/deferred';
import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { withTempDir } from '@/testkit/fs/tempDir';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';

import { createAgyBackgroundContinuationSource } from './agyBackgroundContinuationSource';

const SESSION_ID = 'agy-session';
const TEST_TIMING = { generationSettleMs: 50, stallMs: 10_000 } as const;
const IDLE_AFTER_TURN = { type: 'status', status: 'idle', turnFinished: true } as const;
const COMPLETED_TURN = { kind: 'completed', stopReason: 'end_turn' } as const;

/** Replays the update order `agy acp` produced for a backgrounded `run_command` in a captured session. */
function agyAgent(directory: string, version?: string): string {
  return writeAcpTestAgentScript({
    dir: directory, fileName: 'agy-background.mjs',
    source: `
      let buffer = '';
      let closes = 0;
      let loads = 0;
      let permissionCount = 0;
      let finishForeground;
      let killedByClose = [];
      const running = new Set();
      const pendingPermissions = new Map();
      const COMMANDS = { call_build: 'npm run build', call_verify: 'cat build.log', call_tests: 'npm test', call_hook: 'echo hook' };
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
      const notify = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '${SESSION_ID}', update } });
      const tool = (sessionUpdate, toolCallId, status, extra = {}) => notify({
        sessionUpdate, toolCallId, name: 'run_command', kind: 'execute', title: COMMANDS[toolCallId], status,
        rawInput: { CommandLine: COMMANDS[toolCallId], WaitMsBeforeAsync: 500, IsDaemon: toolCallId === 'call_build' || toolCallId === 'call_tests' }, ...extra,
      });
      const settle = (toolCallId, output) => {
        running.delete(toolCallId);
        tool('tool_call_update', toolCallId, 'completed', {
          rawOutput: { output, exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text: output } }],
        });
      };
      const say = text => notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      const usage = () => notify({ sessionUpdate: 'usage_update', used: 100, size: 1000 });
      const runCommand = (toolCallId, onAllowed, onRefused, statusOnly = false, kindlessLaunchInput = false) => {
        const patchStatus = status => {
          if (statusOnly) notify({ sessionUpdate: 'tool_call_update', toolCallId, status });
          else tool('tool_call_update', toolCallId, status);
        };
        tool('tool_call', toolCallId, 'in_progress', kindlessLaunchInput ? { rawInput: undefined } : {});
        patchStatus('pending');
        const id = 'permission-' + permissionCount++;
        pendingPermissions.set(id, result => {
          if (result?.outcome?.outcome !== 'selected' || result.outcome.optionId !== 'allow') {
            tool('tool_call_update', toolCallId, 'failed');
            onRefused(result);
            return;
          }
          if (kindlessLaunchInput) tool('tool_call_update', toolCallId, 'in_progress', { kind: undefined });
          else patchStatus('in_progress');
          running.add(toolCallId);
          onAllowed();
        });
        send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
          sessionId: '${SESSION_ID}',
          toolCall: { toolCallId, title: COMMANDS[toolCallId], kind: 'execute', status: 'pending', rawInput: { CommandLine: COMMANDS[toolCallId] } },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
        } });
      };
      process.stdin.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (!message.method && pendingPermissions.has(message.id)) {
            const resolvePermission = pendingPermissions.get(message.id);
            pendingPermissions.delete(message.id);
            resolvePermission(message.result);
            continue;
          }
          if (message.method === 'initialize') ok(message.id, {
            protocolVersion: 1, authMethods: [],
            agentInfo: ${JSON.stringify(version ? { name: 'Antigravity ACP Server', version } : null)} ?? undefined,
            agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
          });
          else if (message.method === 'session/new') ok(message.id, { sessionId: '${SESSION_ID}' });
          else if (message.method === 'session/close') {
            closes++;
            killedByClose = [...running];
            running.clear();
            ok(message.id, {});
          } else if (message.method === 'session/load') {
            loads++;
            for (const toolCallId of killedByClose.splice(0)) tool('tool_call_update', toolCallId, 'failed');
            ok(message.id, {});
          } else if (message.method === 'session/prompt') {
            const text = message.params.prompt.map(block => block.text ?? '').join('');
            const endTurn = () => { usage(); ok(message.id, { stopReason: 'end_turn' }); };
            if (text === 'hold the foreground prompt') {
              finishForeground = endTurn;
              say('The foreground prompt started.');
            } else if (text === 'check the build') {
              settle('call_build', 'build ok');
              say('The build finished.');
              endTurn();
            } else {
              runCommand('call_build', () => {
                if (text === 'build in the foreground') settle('call_build', 'build ok');
                say('Started the build.');
                endTurn();
              }, endTurn);
            }
          } else if (message.method === 'test/finish-build') {
            const { chain, plan, pauseAfterUsage, usageWhileWaitingForPermission, statusOnly, keepRunning, kindlessLaunchInput } = message.params;
            const followUp = chain ? 'call_tests' : 'call_verify';
            const reportPlan = () => notify({ sessionUpdate: 'plan', entries: [{ content: 'Verify the build', status: 'in_progress', priority: 'medium' }] });
            settle('call_build', 'build ok');
            if (plan === 'first') reportPlan();
            usage();
            const runFollowUp = () => {
              if (usageWhileWaitingForPermission) say('Checking the build.');
              runCommand(followUp, () => {
                if (followUp === 'call_verify' && !keepRunning) settle('call_verify', 'verified');
                say(followUp === 'call_verify' ? 'The build is verified.' : 'Tests are running.');
                if (plan === 'last') reportPlan();
                usage();
                ok(message.id, { resumed: true });
              }, permission => ok(message.id, { resumed: false, permission }), statusOnly, kindlessLaunchInput);
              if (usageWhileWaitingForPermission) usage();
            };
            if (pauseAfterUsage) setTimeout(runFollowUp, ${TEST_TIMING.generationSettleMs * 3});
            else runFollowUp();
          } else if (message.method === 'test/finish-verification') {
            settle('call_verify', 'verified');
            say('Verification is complete.');
            usage();
            ok(message.id, {});
          } else if (message.method === 'test/finish-tests') {
            settle('call_tests', 'tests passed');
            usage();
            say('All tests passed.');
            usage();
            ok(message.id, {});
          } else if (message.method === 'test/late-work') {
            usage();
            runCommand('call_hook', () => {
              settle('call_hook', 'hook done');
              say('The deferred hook finished.');
              usage();
              ok(message.id, { resumed: true });
            }, permission => ok(message.id, { resumed: false, permission }));
          } else if (message.method === 'test/repeat-build-status') {
            settle('call_build', 'build ok');
            usage();
            ok(message.id, {});
          } else if (message.method === 'test/finish-foreground') {
            finishForeground();
            ok(message.id, {});
          } else if (message.method === 'test/status') ok(message.id, { pid: process.pid, closes, loads, running: [...running] });
          else if (message.id !== undefined) ok(message.id, {});
        }
      });
    `,
  });
}

async function fixture(run: (input: {
  backend: AcpBackend;
  events: AgentMessage[];
  permissionSession: FakePermissionSession;
  agentPid: number;
}) => Promise<void>, getPermissionMode: () => 'default' | 'yolo' = () => 'default', version?: string): Promise<void> {
  await withTempDir('agy-background-continuation-', async (directory) => {
    const permissionSession = new FakePermissionSession();
    const permissionHandler = new ProviderEnforcedPermissionHandler(permissionSession.asApiSessionClient(), { logPrefix: '[fixture]' });
    const events: AgentMessage[] = [];
    const backend = createAcpBackend({
      agentName: 'agy-fixture', cwd: directory, command: process.execPath, args: [agyAgent(directory, version)],
      permissionHandler, getPermissionMode,
      providerTurnSource: createAgyBackgroundContinuationSource(TEST_TIMING),
    });
    backend.onMessage((event) => { events.push(event); });
    let pid: number | undefined;
    try {
      await backend.startSession();
      pid = (await backend.requestExtension<{ pid: number }>('test/status', {})).pid;
      await run({ backend, events, permissionSession, agentPid: pid });
    } finally {
      try { await backend.dispose(); }
      finally { if (pid && isPidAlive(pid)) process.kill(pid, 'SIGKILL'); }
    }
  });
}

function pendingPermissionIds(session: FakePermissionSession): string[] {
  return Object.keys(session.snapshot().requests ?? {});
}

async function approvePendingPermission(session: FakePermissionSession): Promise<void> {
  await expect.poll(() => pendingPermissionIds(session)).not.toHaveLength(0);
  await session.rpcHandlerManager.dispatchPermission({ id: pendingPermissionIds(session)[0]!, approved: true, decision: 'approved' });
}

async function promptBuild(backend: AcpBackend, session: FakePermissionSession, prompt = 'build in the background'): Promise<void> {
  const sent = backend.sendPrompt(SESSION_ID, prompt);
  await approvePendingPermission(session);
  await sent;
  await backend.waitForResponseComplete();
}

function finishedTurns(events: AgentMessage[]): AgentMessage[] {
  return events.filter((event) => event.type === 'status' && event.turnFinished);
}

describe('createAgyBackgroundContinuationSource', () => {
  it.each([
    { version: '1.5.14', detaches: true },
    { version: '1.5.15', detaches: false },
    { version: undefined, detaches: false },
  ])('honors the negotiated foreground command behavior of Agy $version', async ({ version, detaches }) => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', { keepRunning: true, statusOnly: true, kindlessLaunchInput: true });
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });

      if (detaches) {
        await expect.poll(() => finishedTurns(events)).toEqual([IDLE_AFTER_TURN]);
      } else {
        await delay(TEST_TIMING.generationSettleMs * 3);
        expect(finishedTurns(events)).toEqual([]);
      }
      expect(await backend.requestExtension('test/status', {})).toMatchObject({ running: ['call_verify'] });
      await backend.requestExtension('test/finish-verification', {});
      await expect.poll(() => finishedTurns(events)).toHaveLength(detaches ? 2 : 1);
      expect(events.filter((event) => event.type === 'tool-result' && event.callId === 'call_verify')).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ output: 'verified' }) }),
      ]);
    }, undefined, version);
  });

  it('keeps the continuation open when usage arrives before the first follow-up tool', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', { pauseAfterUsage: true });
      await approvePendingPermission(permissionSession);

      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toEqual([IDLE_AFTER_TURN]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'The build is verified.' }));
    });
  });

  it('preserves a pending follow-up permission across an in-stream usage report', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', { usageWhileWaitingForPermission: true });
      await expect.poll(() => pendingPermissionIds(permissionSession)).toHaveLength(1);
      await delay(TEST_TIMING.generationSettleMs * 3);
      expect(finishedTurns(events)).toEqual([]);
      await approvePendingPermission(permissionSession);

      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toEqual([IDLE_AFTER_TURN]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'The build is verified.' }));
    });
  });

  it('runs the conversation Agy resumes after a background command settles as its own turn', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      expect(events.filter(event => event.type === 'tool-result' && event.callId === 'call_build')).toEqual([]);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', {});
      await expect.poll(() => pendingPermissionIds(permissionSession)).toHaveLength(1);
      await delay(TEST_TIMING.generationSettleMs * 3);
      expect(finishedTurns(events)).toEqual([]);
      await approvePendingPermission(permissionSession);

      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => events.at(-1)).toEqual(IDLE_AFTER_TURN);
      expect(events[0]).toEqual({ type: 'status', status: 'running' });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool-result', callId: 'call_build', result: expect.objectContaining({ output: 'build ok', exit_code: 0 }),
      }));
      expect(events.filter(event => event.type === 'tool-result' && event.callId.endsWith('call_build'))).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', callId: 'call_verify' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'The build is verified.' }));
      expect(finishedTurns(events)).toHaveLength(1);
    });
  });

  it('follows background commands a resumed conversation starts through status-only approval updates', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', { chain: true, statusOnly: true });
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toHaveLength(1);

      await backend.requestExtension('test/finish-tests', {});

      await expect.poll(() => finishedTurns(events)).toHaveLength(2);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool-result', callId: 'call_tests', result: expect.objectContaining({ output: 'tests passed', exit_code: 0 }),
      }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'All tests passed.' }));
      expect(events.at(-1)).toEqual(IDLE_AFTER_TURN);
    });
  });

  it('admits fresh live work after the continuation went idle, with explicit approval', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      const resumed = backend.requestExtension('test/finish-build', {});
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toHaveLength(2);

      const late = backend.requestExtension('test/late-work', {});
      await expect.poll(() => pendingPermissionIds(permissionSession)).toEqual(['call_hook']);
      await approvePendingPermission(permissionSession);
      expect(await late).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toHaveLength(3);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'model-output', textDelta: 'The deferred hook finished.',
      }));
    });
  });

  it('requires explicit approval for unattributed work during a full-access successor prompt', async () => {
    let mode: 'default' | 'yolo' = 'default';
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      const resumed = backend.requestExtension('test/finish-build', {});
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toHaveLength(2);

      mode = 'yolo';
      const successor = backend.sendPrompt(SESSION_ID, 'hold the foreground prompt');
      await expect.poll(() => events).toContainEqual(expect.objectContaining({
        type: 'model-output', textDelta: 'The foreground prompt started.',
      }));
      const late = backend.requestExtension('test/late-work', {});
      try {
        await expect.poll(() => pendingPermissionIds(permissionSession)).toEqual(['call_hook']);
        await approvePendingPermission(permissionSession);
        expect(await late).toEqual({ resumed: true });
      } finally {
        await backend.requestExtension('test/finish-foreground', {});
        await successor;
      }
    }, () => mode);
  });

  it('keeps a finishing continuation open for a background command that settles while its output drains', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      const planReached = createDeferred();
      const planGate = createDeferred();
      backend.setPlanStatePublisher(async () => {
        planReached.resolve();
        await planGate.promise;
      });
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', { chain: true, plan: 'last' });
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });
      await planReached.promise;
      await delay(TEST_TIMING.generationSettleMs * 3);
      await backend.requestExtension('test/finish-tests', {});
      await delay(TEST_TIMING.generationSettleMs * 3);
      planGate.resolve();

      await expect.poll(() => finishedTurns(events)).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', callId: 'call_tests' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'All tests passed.' }));
      expect(events.at(-1)).toEqual(IDLE_AFTER_TURN);
    });
  });

  it('withdraws resumed work that no background command of an admitted turn explains', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession, 'build in the foreground');
      events.length = 0;

      expect(await backend.requestExtension('test/finish-build', {})).toEqual({
        resumed: false, permission: { outcome: { outcome: 'cancelled' } },
      });
      expect(events.filter((event) => event.type === 'status')).toEqual([]);
      expect(pendingPermissionIds(permissionSession)).toEqual([]);
    });
  });

  it('leaves a background command that settles during the next prompt to that prompt', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      await backend.sendPrompt(SESSION_ID, 'check the build');
      await backend.waitForResponseComplete();
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'The build finished.' }));
      events.length = 0;

      await backend.requestExtension('test/repeat-build-status', {});
      expect(pendingPermissionIds(permissionSession)).toEqual([]);
      expect(events.filter((event) => event.type === 'status')).toEqual([]);
    });
  });

  it('retires the native connection when resumed work cannot be published', async () => {
    await fixture(async ({ backend, events, permissionSession, agentPid }) => {
      await promptBuild(backend, permissionSession);
      backend.setPlanStatePublisher(async () => { throw new Error('Plan store unavailable'); });
      events.length = 0;

      void backend.requestExtension('test/finish-build', { plan: 'first' }).catch(() => undefined);

      await expect.poll(() => events).toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
      expect(await waitForProcessExit(agentPid)).toBe(true);
    });
  });

  it('stops a resumed conversation by closing and reloading the native session', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;
      const resumed = backend.requestExtension('test/finish-build', {});
      await expect.poll(() => pendingPermissionIds(permissionSession)).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'status', status: 'running' });

      await backend.cancel(SESSION_ID);

      expect(await resumed).toEqual({ resumed: false, permission: { outcome: { outcome: 'cancelled' } } });
      expect(events.at(-1)).toEqual({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
      expect(await backend.requestExtension('test/status', {})).toEqual(expect.objectContaining({ closes: 1, loads: 1 }));
    });
  });
});

describe('Antigravity continuation transcript', () => {
  it('publishes a mirrored chunk once inside a continuation', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      const resumed = backend.requestExtension('test/finish-build', {});
      await expect.poll(() => pendingPermissionIds(permissionSession)).toHaveLength(1);
      await (backend as unknown as { handleSessionUpdate(notification: unknown): Promise<void> }).handleSessionUpdate({
        sessionId: SESSION_ID,
        updates: [
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mirrored' } },
          { messageChunk: { textDelta: 'mirrored' } },
        ],
      });
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toHaveLength(2);
      expect(events.filter(event => event.type === 'model-output' && event.textDelta === 'mirrored')).toHaveLength(1);
    });
  });

});

describe('createAgyBackgroundContinuationSource while the host refuses admission', () => {
  it('hands claimed updates to the prompt that starts first and keeps following the calls they started', async () => {
    const released: SessionUpdate[] = [];
    const host: AcpProviderTurnSourceHost = {
      sessionId: SESSION_ID,
      cwd: '/',
      env: {},
      signal: new AbortController().signal,
      registerContinuation: vi.fn(() => true),
      beginContinuation: vi.fn(() => null),
      releaseToolCalls: vi.fn(),
      releaseClaimedUpdates: (updates) => { released.push(...updates); },
      fail: vi.fn(),
    };
    const source = await createAgyBackgroundContinuationSource(TEST_TIMING)(host);
    const buildStarted: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'call_build', status: 'in_progress' };
    const buildSettled: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'call_build', status: 'completed' };
    const generationEnded: SessionUpdate = { sessionUpdate: 'usage_update' };
    const testsStarted: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'call_tests', status: 'in_progress' };
    const testsSettled: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'call_tests', status: 'completed' };

    expect(source.claimLiveUpdate?.(buildStarted, { foregroundActive: true })).toBe(false);
    source.onTurnFinished?.(COMPLETED_TURN);
    await source.catchUp({ foregroundActive: false });
    expect(host.registerContinuation).toHaveBeenCalledWith({ id: 'call_build', parentToolCallId: 'call_build', keepToolCallOpen: true });

    for (const update of [buildSettled, generationEnded, testsStarted]) {
      expect(source.claimLiveUpdate?.(update, { foregroundActive: false })).toBe(true);
    }
    expect(host.beginContinuation).toHaveBeenCalledTimes(3);
    expect(released).toEqual([]);

    await source.catchUp({ foregroundActive: true });
    expect(released).toEqual([buildSettled, generationEnded, testsStarted]);

    source.onTurnFinished?.(COMPLETED_TURN);
    await source.catchUp({ foregroundActive: false });
    expect(host.registerContinuation).toHaveBeenLastCalledWith({ id: 'call_tests', parentToolCallId: 'call_tests', keepToolCallOpen: true });
    expect(source.claimLiveUpdate?.(buildSettled, { foregroundActive: false })).toBe(false);
    expect(source.claimLiveUpdate?.(testsSettled, { foregroundActive: false })).toBe(true);
    expect(host.beginContinuation).toHaveBeenCalledTimes(4);
    await source.dispose();
  });

  it('keeps the stall deadline when only session metadata arrives and reports a timeout', async () => {
    vi.useFakeTimers();
    const finish = vi.fn(async () => {});
    const host: AcpProviderTurnSourceHost = {
      sessionId: SESSION_ID, cwd: '/', env: {}, signal: new AbortController().signal,
      registerContinuation: () => true,
      beginContinuation: () => ({ update: async () => {}, finish }),
      releaseToolCalls() {}, releaseClaimedUpdates() {}, fail: vi.fn(),
    };
    const source = await createAgyBackgroundContinuationSource({ generationSettleMs: 20, stallMs: 100 })(host);
    try {
      source.claimLiveUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'call_build', status: 'in_progress' }, { foregroundActive: true });
      source.onTurnFinished?.(COMPLETED_TURN);
      await source.catchUp({ foregroundActive: false });
      source.claimLiveUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: 'call_build', status: 'completed' }, { foregroundActive: false });
      await vi.advanceTimersByTimeAsync(75);
      source.claimLiveUpdate?.({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }, { foregroundActive: false });
      await vi.advanceTimersByTimeAsync(25);
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timed_out' }));
    } finally {
      await source.dispose();
      vi.useRealTimers();
    }
  });
});
