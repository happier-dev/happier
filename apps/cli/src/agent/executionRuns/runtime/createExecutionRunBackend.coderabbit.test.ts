import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('overlays isolated XDG state/cache/data dirs for ephemeral runs', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-coderabbit-home-'));
    const dir = await mkdtemp(join(tmpdir(), 'happier-coderabbit-isolation-'));
    const scriptPath = join(dir, 'coderabbit-env.mjs');

    await writeFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  state: process.env.XDG_STATE_HOME || null,",
        "  cache: process.env.XDG_CACHE_HOME || null,",
        "  data: process.env.XDG_DATA_HOME || null,",
        "}));",
      ].join('\n'),
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const prevCmd = process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
    const prevTimeout = process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;
    const prevHomeDir = process.env.HAPPIER_HOME_DIR;
    const prevServer = process.env.HAPPIER_SERVER_URL;
    const prevWebapp = process.env.HAPPIER_WEBAPP_URL;
    const prevState = process.env.XDG_STATE_HOME;
    const prevCache = process.env.XDG_CACHE_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    try {
      process.env.HAPPIER_CODERABBIT_REVIEW_CMD = scriptPath;
      process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS = '5000';

      process.env.XDG_STATE_HOME = '/tmp/xdg-state-original';
      process.env.XDG_CACHE_HOME = '/tmp/xdg-cache-original';
      process.env.XDG_DATA_HOME = '/tmp/xdg-data-original';

      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();

      const backend = createExecutionRunBackend({
        cwd: dir,
        backendId: 'coderabbit',
        permissionMode: 'read_only',
        runId: 'run_1',
        start: {
          intentInput: {
            sessionId: 'parent_session_1',
            engineIds: ['coderabbit'],
            instructions: 'ignored',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            engines: { coderabbit: { plain: true } },
          },
          retentionPolicy: 'ephemeral',
          intent: 'review',
        },
      });

      let fullText = '';
      backend.onMessage((msg: any) => {
        if (msg.type === 'model-output' && typeof msg.fullText === 'string') {
          fullText = String(msg.fullText);
        }
      });

      const started = await backend.startSession();
      await backend.sendPrompt(started.sessionId, 'ignored prompt');

      const parsed = JSON.parse(fullText);
      const root = join(configMod.configuration.activeServerDir, 'isolation', 'coderabbit', 'execution_run', 'run_1', 'xdg');
      expect(parsed.state).toBe(join(root, 'state'));
      expect(parsed.cache).toBe(join(root, 'cache'));
      expect(parsed.data).toBe(join(root, 'data'));

      await backend.dispose();
    } finally {
      if (prevCmd === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_CMD;
      else process.env.HAPPIER_CODERABBIT_REVIEW_CMD = prevCmd;
      if (prevTimeout === undefined) delete process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS;
      else process.env.HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS = prevTimeout;

      if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHomeDir;
      if (prevServer === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServer;
      if (prevWebapp === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebapp;

      if (prevState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevState;
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
      if (prevData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevData;

      await rm(dir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 20_000);
});
