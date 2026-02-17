import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { SessionId } from '@/agent/core/AgentBackend';
import { ExecutionRunManager } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import { ClaudeSdkAgentBackend } from '@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend';

function createFakeClaudeReviewEntrypointSource(): string {
  // Mimics `claude --output-format stream-json --input-format stream-json`.
  // Emits a tool flow + then returns strict JSON review output.
  return `
const readline = require('node:readline');

process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session-1' }) + '\\n');

const rl = readline.createInterface({ input: process.stdin });
let didRespond = false;

rl.on('line', (line) => {
  if (didRespond) return;
  const trimmed = String(line || '').trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (!msg || msg.type !== 'user') return;
  didRespond = true;

  const toolUseId = 'toolu_1';
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: 'README.md' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'OK' }] } }) + '\\n');

  const out = JSON.stringify({
    summary: 'Summary from fake Claude.',
    findings: [
      { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
    ],
  });
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: out }] } }) + '\\n');

  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'DONE_1',
    num_turns: 1,
    total_cost_usd: 0.123,
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    session_id: 'fake-session-1',
  }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;
}

describe('ExecutionRunManager + ClaudeSdkAgentBackend (integration)', () => {
  it('forwards Claude SDK tool-call/tool-result/token-count into the run sidechain', async () => {
    const savedClaudePath = process.env.HAPPIER_CLAUDE_PATH;
    const savedDebug = process.env.DEBUG;

    let dir: string | null = null;
    try {
      delete process.env.DEBUG;
      dir = await mkdtemp(join(tmpdir(), 'happier-claude-exec-run-'));
      const cwd = dir;
      const entry = join(dir, 'fake-claude.cjs');
      await writeFile(entry, createFakeClaudeReviewEntrypointSource(), 'utf8');
      process.env.HAPPIER_CLAUDE_PATH = entry;

      const sent: Array<{ provider: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
      const manager = new ExecutionRunManager({
        parentProvider: 'claude',
        cwd,
        createBackend: (opts) =>
          new ClaudeSdkAgentBackend({
            cwd,
            modelId: 'default',
            permissionPolicy: opts.permissionMode as any,
          }),
        sendAcp: (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
          sent.push({ provider, body, meta: opts?.meta });
        },
        getNowMs: () => 1_700_000_000_000,
      });

      const started = await manager.start({
        sessionId: 'parent_session_1' as SessionId,
        intent: 'review',
        backendId: 'claude',
        instructions: 'Review this repo.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      await manager.waitForTerminal(started.runId);
      expect(manager.get(started.runId)?.status).toBe('succeeded');

      const sidechainToolCall = sent.find(
        (m) => m.body.type === 'tool-call' && m.body.sidechainId === started.callId && m.body.name === 'Read',
      );
      expect(sidechainToolCall).toBeTruthy();
      expect((sidechainToolCall!.body as any).callId).toBe(`sc:${started.callId}:toolu_1`);

      const sidechainToolResult = sent.find(
        (m) =>
          m.body.type === 'tool-result' &&
          m.body.sidechainId === started.callId &&
          m.body.callId === `sc:${started.callId}:toolu_1`,
      );
      expect(sidechainToolResult).toBeTruthy();

      const tokenCount = sent.find((m) => m.body.type === 'token_count' && m.body.sidechainId === started.callId) as any;
      expect(tokenCount).toBeTruthy();
      expect(tokenCount.body.tokens?.input).toBe(11);
      expect(tokenCount.body.tokens?.output).toBe(22);
      expect(tokenCount.body.tokens?.cache_read).toBe(3);
      expect(tokenCount.body.tokens?.cache_creation).toBe(4);
      expect(tokenCount.body.cost?.total).toBe(0.123);
    } finally {
      if (savedClaudePath === undefined) delete process.env.HAPPIER_CLAUDE_PATH;
      else process.env.HAPPIER_CLAUDE_PATH = savedClaudePath;
      if (savedDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = savedDebug;
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
