import { describe, expect, it } from 'vitest';

import { readFileEventually, writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { AcpBackend, buildInitializeRequest, type AcpPermissionHandler } from '../AcpBackend';
import { withTempDir } from '@/testkit/fs/tempDir';

type Decision = Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> & {
  answers?: Readonly<Record<string, readonly string[]>>;
};

// Recorded from `agy acp` 1.5.18 (`ask_question` tool) with `clientCapabilities.elicitation.form`.
const AGY_ELICITATION = {
  mode: 'form',
  message: 'The agent has a question.',
  toolCallId: 'call_1',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        type: 'string',
        title: 'Which color do you prefer?',
        oneOf: [
          { const: '1', title: '(Recommended) Red' },
          { const: '2', title: 'Green' },
          { const: '3', title: 'Blue' },
        ],
      },
      q1_other: {
        type: 'string',
        title: 'Other',
        description: 'Optional free-form answer to: Which color do you prefer?',
      },
    },
  },
};

function writeElicitingAgent(dir: string, resultFile: string): string {
  return writeAcpTestAgentScript({
    dir,
    fileName: 'eliciting-agent.cjs',
    source: `
      const fs = require('node:fs');
      let buf = '';
      let initCapabilities = null;
      let promptId = null;
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === 'elicit-1' && !msg.method) {
            fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ initCapabilities, response: msg }));
            send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
            continue;
          }
          if (msg.method === 'initialize') {
            initCapabilities = msg.params.clientCapabilities;
            send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [] } });
          } else if (msg.method === 'session/new') {
            send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'test-session' } });
          } else if (msg.method === 'session/prompt') {
            promptId = msg.id;
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update: {
              sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Run ask_question', kind: 'other', status: 'pending',
            } } });
            send({ jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create', params: {
              sessionId: 'test-session', ...${JSON.stringify(AGY_ELICITATION)},
            } });
          } else if (msg.id !== undefined && msg.method) {
            send({ jsonrpc: '2.0', id: msg.id, result: {} });
          }
        }
      });
    `,
  });
}

describe('AcpBackend form elicitation', () => {
  it('advertises form elicitation only when enabled', () => {
    const base = { clientName: 'test', clientVersion: '1.0.0' };
    expect(buildInitializeRequest(base).clientCapabilities).not.toHaveProperty('elicitation');
    expect(buildInitializeRequest({ ...base, formElicitation: true }).clientCapabilities)
      .toMatchObject({ elicitation: { form: {} } });
  });

  it('asks the session question owner and answers the agent with schema values', async () => {
    await withTempDir('happier-acp-elicitation-', async (dir) => {
      const resultFile = `${dir}/result.json`;
      const calls: Array<{ id: string; toolName: string; input: unknown }> = [];
      // agy refuses a steer while its question is open, so steering waits for the answer.
      const steerableWhileQuestionOpen: boolean[] = [];
      let backend: AcpBackend | null = null;
      const permissionHandler: AcpPermissionHandler = {
        async handleToolCall(id, toolName, input): Promise<Decision> {
          calls.push({ id, toolName, input });
          steerableWhileQuestionOpen.push(backend?.isInFlightSteerWindowOpen() ?? true);
          return { decision: 'approved', answers: { q1: ['Green'] } };
        },
      };
      backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeElicitingAgent(dir, resultFile)],
        permissionHandler,
        formElicitation: true,
      });
      try {
        const { sessionId } = await backend.startSession();
        await backend.sendPrompt(sessionId, 'ask me');
        const result = JSON.parse(await readFileEventually(resultFile, { timeoutMs: 5_000 }));
        expect(steerableWhileQuestionOpen).toEqual([false]);
        expect(result.initCapabilities).toMatchObject({ elicitation: { form: {} } });
        expect(result.response.result).toEqual({ action: 'accept', content: { q1: '2' } });
        expect(calls).toEqual([{
          id: 'call_1',
          toolName: 'AskUserQuestion',
          input: {
            questions: [expect.objectContaining({
              id: 'q1',
              question: 'Which color do you prefer?',
              multiSelect: false,
              options: [
                expect.objectContaining({ label: '(Recommended) Red' }),
                expect.objectContaining({ label: 'Green' }),
                expect.objectContaining({ label: 'Blue' }),
              ],
              freeform: expect.objectContaining({ placeholder: 'Other' }),
            })],
          },
        }]);
      } finally {
        await backend.dispose();
      }
    });
  });
});
