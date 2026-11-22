import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import type { AgentMessage } from '@/agent/core';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { FakePermissionSession } from '@/testkit/backends/permissionHandler';
import { withTempDir } from '@/testkit/fs/tempDir';
import { isPidAlive } from '@/testkit/process/spawn';

import { createAgyBackgroundContinuationSource } from './agyBackgroundContinuationSource';

const SESSION_ID = 'agy-session';
const TEST_TIMING = { generationSettleMs: 50, stallMs: 10_000 } as const;
const IDLE_AFTER_TURN = { type: 'status', status: 'idle', turnFinished: true } as const;

/** Replays the update order `agy acp` produced for a backgrounded `run_command` in a captured session. */
function agyAgent(directory: string): string {
  return writeAcpTestAgentScript({
    dir: directory, fileName: 'agy-background.mjs',
    source: `
      let buffer = '';
      let closes = 0;
      let loads = 0;
      let permissionCount = 0;
      let killedByClose = [];
      const running = new Set();
      const pendingPermissions = new Map();
      const COMMANDS = { call_build: 'npm run build', call_verify: 'cat build.log', call_tests: 'npm test' };
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
      const notify = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '${SESSION_ID}', update } });
      const tool = (sessionUpdate, toolCallId, status, extra = {}) => notify({
        sessionUpdate, toolCallId, name: 'run_command', kind: 'execute', title: COMMANDS[toolCallId], status,
        rawInput: { CommandLine: COMMANDS[toolCallId], WaitMsBeforeAsync: 2000 }, ...extra,
      });
      const settle = (toolCallId, output) => {
        running.delete(toolCallId);
        tool('tool_call_update', toolCallId, 'completed', {
          rawOutput: { output, exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text: output } }],
        });
      };
      const say = text => notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      const usage = () => notify({ sessionUpdate: 'usage_update', used: 100, size: 1000 });
      const runCommand = (toolCallId, onAllowed, onRefused) => {
        tool('tool_call', toolCallId, 'in_progress');
        tool('tool_call_update', toolCallId, 'pending');
        const id = 'permission-' + permissionCount++;
        pendingPermissions.set(id, result => {
          if (result?.outcome?.outcome !== 'selected' || result.outcome.optionId !== 'allow') {
            tool('tool_call_update', toolCallId, 'failed');
            onRefused(result);
            return;
          }
          tool('tool_call_update', toolCallId, 'in_progress');
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
            if (text === 'check the build') {
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
            const followUp = message.params.chain ? 'call_tests' : 'call_verify';
            settle('call_build', 'build ok');
            if (message.params.plan) notify({ sessionUpdate: 'plan', entries: [{ content: 'Verify the build', status: 'in_progress', priority: 'medium' }] });
            usage();
            runCommand(followUp, () => {
              if (followUp === 'call_verify') settle('call_verify', 'verified');
              say(followUp === 'call_verify' ? 'The build is verified.' : 'Tests are running.');
              usage();
              ok(message.id, { resumed: true });
            }, permission => ok(message.id, { resumed: false, permission }));
          } else if (message.method === 'test/finish-tests') {
            settle('call_tests', 'tests passed');
            usage();
            say('All tests passed.');
            usage();
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
}) => Promise<void>): Promise<void> {
  await withTempDir('agy-background-continuation-', async (directory) => {
    const permissionSession = new FakePermissionSession();
    const permissionHandler = new ProviderEnforcedPermissionHandler(permissionSession.asApiSessionClient(), { logPrefix: '[fixture]' });
    const events: AgentMessage[] = [];
    const backend = createAcpBackend({
      agentName: 'agy-fixture', cwd: directory, command: process.execPath, args: [agyAgent(directory)],
      permissionHandler, getPermissionMode: () => 'default',
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
  it('runs the conversation Agy resumes after a background command settles as its own turn', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', {});
      await expect.poll(() => pendingPermissionIds(permissionSession)).toHaveLength(1);
      await delay(TEST_TIMING.generationSettleMs * 3);
      expect(finishedTurns(events)).toEqual([]);
      await approvePendingPermission(permissionSession);

      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => events.at(-1)).toEqual(IDLE_AFTER_TURN);
      expect(events[0]).toEqual({ type: 'status', status: 'running' });
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', callId: 'agy-continuation-1:call_build' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', callId: 'call_verify' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'model-output', textDelta: 'The build is verified.' }));
      expect(finishedTurns(events)).toHaveLength(1);
    });
  });

  it('follows background commands that a resumed conversation starts', async () => {
    await fixture(async ({ backend, events, permissionSession }) => {
      await promptBuild(backend, permissionSession);
      events.length = 0;

      const resumed = backend.requestExtension('test/finish-build', { chain: true });
      await approvePendingPermission(permissionSession);
      expect(await resumed).toEqual({ resumed: true });
      await expect.poll(() => finishedTurns(events)).toHaveLength(1);

      await backend.requestExtension('test/finish-tests', {});

      await expect.poll(() => finishedTurns(events)).toHaveLength(2);
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', callId: 'agy-continuation-2:call_tests' }));
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

      expect(await backend.requestExtension('test/finish-build', {})).toEqual({
        resumed: false, permission: { outcome: { outcome: 'cancelled' } },
      });
      expect(events.filter((event) => event.type === 'status')).toEqual([]);
    });
  });

  it('retires the native connection when resumed work cannot be published', async () => {
    await fixture(async ({ backend, events, permissionSession, agentPid }) => {
      await promptBuild(backend, permissionSession);
      backend.setPlanStatePublisher(async () => { throw new Error('Plan store unavailable'); });
      events.length = 0;

      void backend.requestExtension('test/finish-build', { plan: true }).catch(() => undefined);

      await expect.poll(() => events).toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
      await expect.poll(() => isPidAlive(agentPid)).toBe(false);
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
