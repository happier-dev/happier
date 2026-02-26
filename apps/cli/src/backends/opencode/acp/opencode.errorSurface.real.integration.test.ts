/**
 * Real OpenCode ACP probe (opt-in):
 * - Spawns the locally installed `opencode` CLI (must already be authenticated on the host for real provider calls).
 * - Forces an invalid model id via `session/set_model` so OpenCode emits an error.
 * - Asserts Happier surfaces the failure as a `status:error` AgentMessage (instead of silently stalling).
 *
 * Enable locally:
 *   HAPPIER_TEST_REAL_OPENCODE=1 yarn -s vitest run --config vitest.integration.config.ts src/backends/opencode/acp/opencode.errorSurface.real.integration.test.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';
import { createOpenCodeBackend } from './backend';

const ENABLED = (process.env.HAPPIER_TEST_REAL_OPENCODE ?? '').toString().trim() === '1';

function findFirstStatusError(messages: AgentMessage[]): Extract<AgentMessage, { type: 'status'; status: 'error' }> | null {
  for (const msg of messages) {
    if (msg.type === 'status' && msg.status === 'error') return msg as any;
  }
  return null;
}

describe('real OpenCode ACP error surface probe', () => {
  if (!ENABLED) {
    it.skip('requires HAPPIER_TEST_REAL_OPENCODE=1 (opt-in)', () => {});
    return;
  }

  it(
    'surfaces OpenCode failures as status:error AgentMessages (end-to-end)',
    { timeout: 120_000 },
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Real OpenCode CLI probe is not supported on Windows in this repo.');
      }

      const version = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
      if (version.status !== 0) {
        throw new Error(`opencode is not available on PATH (status=${String(version.status)}): ${String(version.stderr || version.stdout)}`);
      }

      const workDir = mkdtempSync(join(tmpdir(), 'happier-real-opencode-error-surface-'));
      const messages: AgentMessage[] = [];

      const backend = createOpenCodeBackend({
        cwd: workDir,
        env: {
          // Force-enable stderr log printing for the real probe regardless of parent env.
          HAPPIER_OPENCODE_ACP_PRINT_LOGS: '1',
          HAPPIER_OPENCODE_ACP_LOG_LEVEL: 'ERROR',
          // Force a deterministic provider failure without hitting the real network:
          // OpenCode honors OPENAI_BASE_URL, so pointing to a closed port yields a connection error
          // that should be surfaced to the UI as status:error.
          OPENAI_BASE_URL: 'http://127.0.0.1:1',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'openai/gpt-5.2' }),
        },
        permissionMode: 'yolo',
      });

      try {
        backend.onMessage((msg) => messages.push(msg));

        const started = await backend.startSession();

        await backend.sendPrompt(started.sessionId, 'hi');

        await expect(backend.waitForResponseComplete(60_000)).rejects.toBeInstanceOf(Error);

        const statusError = findFirstStatusError(messages);
        if (!statusError) {
          const tail = messages.slice(-20);
          throw new Error(`Expected a status:error message, but none was emitted. Message tail: ${JSON.stringify(tail, null, 2)}`);
        }
        expect(typeof statusError.detail === 'string' && statusError.detail.trim().length > 0).toBe(true);
        expect(String(statusError.detail)).toMatch(/connect|connection|refused|unable to connect/i);
      } finally {
        await backend.dispose().catch(() => {});
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  );
});
