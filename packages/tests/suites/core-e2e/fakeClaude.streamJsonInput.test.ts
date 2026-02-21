import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function parseJsonLines(raw: string): any[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

describe('fake Claude CLI fixture', () => {
  it('acknowledges control_request messages with a control_response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-control-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');

      const input = [
        JSON.stringify({ type: 'control_request', request_id: 'req-1', request: { subtype: 'initialize' } }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      ].join('\n');

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const rows = parseJsonLines(res.stdout);
      const response = rows.find((row) => row?.type === 'control_response');
      expect(response?.response?.subtype).toBe('success');
      expect(response?.response?.request_id).toBe('req-1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('responds to role=user messages even when message type differs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-stream-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');

      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const rows = parseJsonLines(res.stdout);
      const assistant = rows.find((row) => row?.type === 'assistant');
      expect(assistant?.message?.content?.[0]?.text).toBe('FAKE_CLAUDE_OK_1');

      const logRaw = await readFile(logPath, 'utf8');
      expect(parseJsonLines(logRaw).some((row) => row?.type === 'invocation')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
