import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentMessageHandler } from '@/agent/core/AgentBackend';

import { createExecutionRunBackend } from './createExecutionRunBackend';

describe('createExecutionRunBackend (coderabbit)', () => {
  it('does not throw when the command env var is missing (defaults to "coderabbit")', () => {
    const prevCmd = process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
    const prevTimeout = process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;
    try {
      delete process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
      delete process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;

      expect(() => createExecutionRunBackend({ cwd: process.cwd(), backendId: 'coderabbit', permissionMode: 'read_only' })).not.toThrow();
    } finally {
      if (prevCmd === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
      else process.env.HAPPIER_CODERABBIT_REVIEW_CMD = prevCmd;
      if (prevTimeout === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;
      else process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS = prevTimeout;
    }
  });

  it('builds a per-run coderabbit invocation from intentInput (no stdin prompt) and emits model-output text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-coderabbit-test-'));
    const scriptPath = join(dir, 'coderabbit-fake.mjs');

    await writeFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (c) => { stdin += String(c); });",
        "process.stdin.on('end', () => {",
        "  const argv = process.argv.slice(2);",
        "  process.stdout.write(JSON.stringify({ argv, stdin }));",
        "});",
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const prevCmd = process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
    const prevTimeout = process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;
    try {
      process.env.HAPPIER_CODERABBIT_REVIEW_CMD = scriptPath;
      process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS = '5000';

      const backend = createExecutionRunBackend({
        cwd: dir,
        backendId: 'coderabbit',
        permissionMode: 'read_only',
        start: {
          intentInput: {
            sessionId: 'parent_session_1',
            engineIds: ['coderabbit'],
            instructions: 'ignored',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            engines: { coderabbit: { plain: true } },
          },
        },
      });
      let fullText = '';
      const handler: AgentMessageHandler = (msg) => {
        if (msg.type === 'model-output' && typeof (msg as any).fullText === 'string') {
          fullText = String((msg as any).fullText);
        }
      };
      backend.onMessage(handler);

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'ignored prompt');

      const parsed = JSON.parse(fullText);
      expect(Array.isArray(parsed.argv)).toBe(true);
      expect(parsed.argv).toContain('review');
      expect(parsed.argv).toContain('--type');
      expect(parsed.argv).toContain('uncommitted');
      expect(parsed.argv).toContain('--cwd');
      expect(parsed.argv).toContain(dir);
      expect(parsed.argv).toContain('--plain');
      expect(parsed.argv).toContain('--no-color');
      expect(String(parsed.stdin ?? '')).toBe('');
      await backend.dispose();
    } finally {
      if (prevCmd === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
      else process.env.HAPPIER_CODERABBIT_REVIEW_CMD = prevCmd;
      if (prevTimeout === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;
      else process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS = prevTimeout;
    }
  }, 20_000);
});
