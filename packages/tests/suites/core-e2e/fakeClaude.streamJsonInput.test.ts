import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';

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
  it('uses scenario-owned controls when the parent fake-control environment is filtered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-shim-'));
    try {
      const ambientHome = join(dir, 'ambient-home');
      await mkdir(ambientHome, { recursive: true });
      const fixture = await createIsolatedFakeClaudeControlShim({
        testDir: dir,
        invocationId: 'isolated-invocation',
        captureEnvironmentKeys: ['ANTHROPIC_API_KEY'],
        logFullStdin: true,
      });
      const marker = 'ISOLATED_FAKE_CLAUDE_STDIN';
      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: marker }] },
      });
      const filteredParentEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: ambientHome,
        ANTHROPIC_API_KEY: 'scenario-provider-key',
      };
      for (const key of Object.keys(filteredParentEnv)) {
        if (key.startsWith('HAPPIER_E2E_FAKE_CLAUDE_') || key === 'CLAUDE_CONFIG_DIR') {
          delete filteredParentEnv[key];
        }
      }

      const res = spawnSync(
        process.execPath,
        [fixture.executablePath, '--output-format', 'stream-json', '--input-format', 'stream-json'],
        {
          cwd: dir,
          env: filteredParentEnv,
          input: `${input}\n`,
          encoding: 'utf8',
        },
      );

      expect(res.status).toBe(0);
      const events = parseJsonLines(await readFile(fixture.logPath, 'utf8'));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'invocation',
          invocationId: 'isolated-invocation',
          environmentAttestation: {
            ANTHROPIC_API_KEY: expect.objectContaining({ present: true }),
          },
        }),
        expect.objectContaining({
          type: 'sdk_stdin',
          invocationId: 'isolated-invocation',
          userText: marker,
        }),
      ]));
      expect(await readdir(ambientHome, { recursive: true })).toEqual([]);
      expect(await readdir(fixture.configDir, { recursive: true }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/\.jsonl$/)]));
      expect(fixture.executablePath).toBe(resolve(join(dir, 'fake-claude-control.mjs')));
      expect(fixture.logPath).toBe(resolve(join(dir, 'fake-claude.jsonl')));
      expect(fixture.configDir).toBe(resolve(join(dir, 'fake-claude-config')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it('can opt into logging full user stdin text for targeted assertions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-full-stdin-'));
    try {
      const logPath = join(dir, 'fake-claude.jsonl');
      const fixturePath = resolve(process.cwd(), 'src/fixtures/fake-claude-code-cli.cjs');
      const marker = 'FULL_STDIN_MARKER_AFTER_PREVIEW';
      const longText = `${'x'.repeat(900)}${marker}`;

      const input = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: longText }] },
      });

      const res = spawnSync(process.execPath, [fixturePath, '--output-format', 'stream-json', '--input-format', 'stream-json'], {
        cwd: dir,
        env: {
          ...process.env,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: 'inv-1',
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: 'session-1',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const logRaw = await readFile(logPath, 'utf8');
      const stdinRow = parseJsonLines(logRaw).find((row) => row?.type === 'sdk_stdin' && row?.hasUserText === true);
      expect(stdinRow?.userTextPreview).not.toContain(marker);
      expect(typeof stdinRow?.userText).toBe('string');
      expect(String(stdinRow?.userText ?? '')).toContain(marker);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('publishes execution-run runtime metadata for the permission prompt scenario', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fake-claude-runtime-'));
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
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
        },
        input: `${input}\n`,
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);

      const rows = parseJsonLines(res.stdout);
      expect(rows.some((row) => row?.type === 'event' && row?.name === 'runtime.descriptor')).toBe(true);
      expect(rows.some((row) => row?.type === 'event' && row?.name === 'runtime.capabilities')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
