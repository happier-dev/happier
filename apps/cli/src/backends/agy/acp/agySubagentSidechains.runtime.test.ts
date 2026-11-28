import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { agent as agyCatalogEntry } from '../index';
import { createAgyAcpBackend } from './backend';

afterEach(() => vi.unstubAllEnvs());

const SESSION_ID = 'main-conversation';
const SUBAGENT_ID = '84c22f3a-6377-480c-a1e2-3891dbeceaa0';
const SUBAGENT_CALL_ID = `${SUBAGENT_ID}:call_7076348451807557601`;
const INVOKE_CALL_ID = 'call_15838892019824293794';

/**
 * A synthetic `agy acp` replaying the shape agy 1.5.18 streams when its main agent launches a subagent
 * (captured live): `invoke_subagent` completes at once without naming the subagent, agy records the
 * subagent under the parent conversation, and the subagent's own tool calls (ids prefixed with its
 * conversation id, no `_meta` link, permission request included) interleave with the main reply.
 */
async function writeSubagentAgyFixture(dir: string): Promise<string> {
  const script = writeAcpTestAgentScript({ dir, fileName: 'agy', source: `#!${process.execPath}
    const fs = require('node:fs');
    const path = require('node:path');
    const argv = process.argv.slice(2);
    const profile = argv[argv.indexOf('--gemini-dir') + 1];
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
    const update = (body) => send({ method: 'session/update', params: { sessionId: ${JSON.stringify(SESSION_ID)}, update: body } });
    const chunk = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const invokeInput = { Prompt: 'Run echo alpha and report back.', Role: 'Alpha Runner', TypeName: 'self' };
    const commandInput = { CommandLine: 'echo alpha', WaitMsBeforeAsync: 5000, toolSummary: 'Run echo alpha' };
    const subagentCall = { toolCallId: ${JSON.stringify(SUBAGENT_CALL_ID)}, name: 'run_command', args: commandInput,
      kind: 'execute', title: 'echo alpha', rawInput: commandInput };
    let promptId = null;
    let permissionRequestId = 900;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function playTurn() {
      update({ sessionUpdate: 'tool_call', toolCallId: ${JSON.stringify(INVOKE_CALL_ID)}, name: 'invoke_subagent', args: invokeInput,
        status: 'in_progress', kind: 'other', title: 'Run invoke_subagent', rawInput: invokeInput });
      const record = path.join(profile, 'antigravity-cli', 'brain', ${JSON.stringify(SESSION_ID)}, '.system_generated', 'subagents');
      fs.mkdirSync(record, { recursive: true });
      fs.writeFileSync(path.join(record, ${JSON.stringify(`${SUBAGENT_ID}.json`)}), JSON.stringify({
        conversationId: ${JSON.stringify(SUBAGENT_ID)}, subagentDescriptor: { typeName: 'self', role: 'Alpha Runner' },
        state: 'SUBAGENT_STATE_ALIVE', spawnStepIndex: 4 }));
      update({ sessionUpdate: 'tool_call_update', toolCallId: ${JSON.stringify(INVOKE_CALL_ID)}, name: 'invoke_subagent', args: invokeInput,
        status: 'completed', kind: 'other', title: 'Run invoke_subagent', rawInput: invokeInput });
      await wait(30);
      chunk('I asked a subagent to run \`ec');
      await wait(30);
      update({ sessionUpdate: 'tool_call', ...subagentCall, status: 'pending' });
      send({ id: permissionRequestId, method: 'session/request_permission', params: { sessionId: ${JSON.stringify(SESSION_ID)},
        toolCall: { sessionUpdate: 'tool_call', ...subagentCall, status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } });
    }
    async function finishTurn() {
      update({ sessionUpdate: 'tool_call_update', ...subagentCall, status: 'completed',
        rawOutput: { output: 'alpha', exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text: 'alpha' } }] });
      await wait(30);
      chunk('ho alpha\` and it printed alpha.');
      await wait(30);
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    }
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === undefined && message.id === permissionRequestId) { void finishTurn(); return; }
      if (message.method === 'initialize') {
        send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' },
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
      } else if (message.method === 'session/new') {
        send({ id: message.id, result: { sessionId: ${JSON.stringify(SESSION_ID)} } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        void playTurn();
      } else if (message.id !== undefined) {
        send({ id: message.id, result: {} });
      }
    });
  ` });
  await chmod(script, 0o755);
  return script;
}

type Sent = Readonly<{ body: ACPMessageData; committed: boolean; localId?: string }>;

describe.skipIf(process.platform === 'win32')('Antigravity subagent activity', () => {
  it('keeps the main reply in one message and threads the subagent tool call under its invoke_subagent card', async () => {
    await withTempDir('agy-subagent-', async (dir) => {
      vi.stubEnv('GEMINI_HOME', '');
      const agy = await writeSubagentAgyFixture(dir);
      const env = { HAPPIER_AGY_PATH: agy, GEMINI_HOME: join(dir, 'profile') };
      const permissionPrompts: string[] = [];
      const permissionHandler = {
        handleToolCall: async (toolCallId: string) => {
          permissionPrompts.push(toolCallId);
          return { decision: 'approved' as const };
        },
      };
      const backend = await createAgyAcpBackend({ cwd: dir, env, permissionHandler });
      const sent: Sent[] = [];
      const runtime = createTestAcpRuntime({
        provider: 'agy',
        directory: dir,
        processEnv: { ...process.env, ...env },
        session: createBasicSessionClientWithOverrides({
          sendAgentMessage: (_provider, body) => { sent.push({ body, committed: false }); },
          sendAgentMessageCommitted: async (_provider, body, opts) => { sent.push({ body, committed: true, localId: opts.localId }); },
        }),
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: permissionHandler as never,
        onThinkingChange: () => {},
        ensureBackend: async () => backend as never,
        hooks: await agyCatalogEntry.getAcpRuntimeTurnHooks(),
      });
      try {
        await runtime.startOrLoad({});
        runtime.beginTurn();
        await runtime.sendPrompt('Launch a subagent');
        await runtime.flushTurn();
      } finally {
        await backend.dispose();
      }

      const mainReplies = sent.filter(({ body }) => body.type === 'message' && !('sidechainId' in body && body.sidechainId));
      expect(new Set(mainReplies.map(({ localId }) => localId)).size).toBe(1);
      expect(mainReplies.at(-1)?.body).toMatchObject({ message: 'I asked a subagent to run `echo alpha` and it printed alpha.' });

      const subagentCall = sent.find(({ body }) => body.type === 'tool-call' && body.callId === SUBAGENT_CALL_ID)?.body;
      expect(subagentCall).toMatchObject({ sidechainId: INVOKE_CALL_ID });
      expect(sent.find(({ body }) => body.type === 'tool-result' && body.callId === SUBAGENT_CALL_ID)?.body)
        .toMatchObject({ sidechainId: INVOKE_CALL_ID });
      // The launch card is the sub-agent card the UI threads the sidechain under.
      const launchCall = sent.find(({ body }) => body.type === 'tool-call' && body.callId === INVOKE_CALL_ID)?.body;
      expect(launchCall).toMatchObject({ name: 'SubAgent' });
      expect(launchCall).not.toHaveProperty('sidechainId');

      expect(permissionPrompts).toEqual([SUBAGENT_CALL_ID]);
      expect(sent.find(({ body }) => body.type === 'permission-request')?.body)
        .toMatchObject({ permissionId: SUBAGENT_CALL_ID, sidechainId: INVOKE_CALL_ID });
    });
  });
});
