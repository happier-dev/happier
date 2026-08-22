import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readFakeClaudeRuntimeContinuityEvidence,
  releaseFakeClaudeRuntimeContinuityTurn,
  waitForFakeClaudeRuntimeContinuityEffect,
} from '../../src/testkit/providers/fakeClaudeContinuity';

describe('fake Claude runtime continuity boundary control', () => {
  it('holds only the opted-in provider turn until the test-owned release file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-runtime-continuity-'));
    const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
    const logPath = join(dir, 'fake-claude.jsonl');
    const releaseFilePath = join(dir, 'release');
    const promptMarker = 'DAEMON_RUNTIME_CONTINUITY_HOLD_UNIT';
    const child = spawn(
      process.execPath,
      [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'],
      {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'continuity-invocation',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'continuity-provider-session',
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'daemon-runtime-continuity',
          HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: releaseFilePath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const childExit = new Promise<
      Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
    >((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });

    try {
      child.stdin.write(`${JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: promptMarker }],
        },
      })}\n`);

      const entered = await waitForFakeClaudeRuntimeContinuityEffect({
        logPath,
        promptMarker,
        timeoutMs: 10_000,
      });
      expect(entered).toMatchObject({
        sessionId: 'continuity-provider-session',
        turn: 1,
        userTextPreview: promptMarker,
      });
      expect(stdout).not.toContain('FAKE_CLAUDE_OK_1');

      await releaseFakeClaudeRuntimeContinuityTurn(releaseFilePath);
      child.stdin.end();
      const exit = await childExit;
      expect(exit, stderr).toEqual({ code: 0, signal: null });
      expect(stdout).toContain('FAKE_CLAUDE_OK_1');
      expect(await readFakeClaudeRuntimeContinuityEvidence(logPath)).toMatchObject({
        sdkInvocationCount: 1,
        sdkProviderPids: [child.pid],
        providerEffectEntries: [{
          pid: child.pid,
          sessionId: 'continuity-provider-session',
          turn: 1,
          userTextPreview: promptMarker,
        }],
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await childExit.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
