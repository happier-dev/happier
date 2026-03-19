import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { createRunDirs } from '../../src/testkit/runDir';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';
import { which } from '../../src/testkit/process/commands';

const run = createRunDirs({ runLabel: 'providers' });

type OpenCodeSession = Readonly<{
  id?: string;
  sessionID?: string;
}>;

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve TCP port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
    server.once('error', reject);
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

describe('providers: OpenCode shared session real probe', () => {
  const providersEnabled = envFlag(['HAPPIER_E2E_PROVIDERS', 'HAPPY_E2E_PROVIDERS'], false);
  const opencodeServerEnabled = envFlag(['HAPPIER_E2E_PROVIDER_OPENCODE_SERVER', 'HAPPY_E2E_PROVIDER_OPENCODE_SERVER'], false);
  const liveProbeEnabled = envFlag('HAPPIER_TEST_REAL_OPENCODE', false);

  let stopServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await stopServer?.();
    stopServer = null;
  });

  it.skipIf(!(providersEnabled && opencodeServerEnabled && liveProbeEnabled))(
    'accepts multiple API prompts into one live server session and records them in a shared transcript',
    async () => {
      const opencodePath = which('opencode');
      expect(opencodePath).not.toBeNull();
      if (!opencodePath) return;

      const testDir = run.testDir('opencode-server-shared-session-real-probe');
      const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-opencode-server-real-probe-'));
      mkdirSync(testDir, { recursive: true });

      const port = await reservePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      writeTestManifest(testDir, {
        startedAt: new Date().toISOString(),
        runId: run.runId,
        testName: 'opencode-server-shared-session-real-probe',
        ports: { server: port },
        baseUrl,
        env: {
          HAPPIER_E2E_PROVIDERS: process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS,
          HAPPIER_E2E_PROVIDER_OPENCODE_SERVER: process.env.HAPPIER_E2E_PROVIDER_OPENCODE_SERVER ?? process.env.HAPPY_E2E_PROVIDER_OPENCODE_SERVER,
          HAPPIER_TEST_REAL_OPENCODE: process.env.HAPPIER_TEST_REAL_OPENCODE,
        },
      });

      const stdoutPath = resolve(join(testDir, 'opencode-serve.stdout.log'));
      const stderrPath = resolve(join(testDir, 'opencode-serve.stderr.log'));
      const stdoutHandle = createWriteStream(stdoutPath, { flags: 'w' });
      const stderrHandle = createWriteStream(stderrPath, { flags: 'w' });
      const child = spawn(opencodePath, ['serve', '--port', String(port)], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.pipe(stdoutHandle);
      child.stderr?.pipe(stderrHandle);

      stopServer = async () => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
          await new Promise<void>((resolveStop) => child.once('exit', () => resolveStop()));
        }
        stdoutHandle.end();
        stderrHandle.end();
      };

      await waitFor(async () => {
        const health = await fetch(`${baseUrl}/global/health`).catch(() => null);
        return health?.ok === true;
      }, { timeoutMs: 30_000 });

      const session = await fetchJson<OpenCodeSession[] | OpenCodeSession>(
        `${baseUrl}/session?directory=${encodeURIComponent(workspaceDir)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      );
      const createdSession = Array.isArray(session) ? session[0] : session;
      const sessionId = createdSession?.id ?? createdSession?.sessionID ?? null;
      expect(typeof sessionId).toBe('string');
      if (!sessionId) return;

      const listMessages = async (): Promise<unknown[]> => {
        const raw = await fetchJson<unknown>(
          `${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(workspaceDir)}`,
        );
        return Array.isArray(raw) ? raw : [];
      };

      const initialMessages = await listMessages();
      const firstPromptToken = `SERVER_PROMPT_ONE_${Date.now()}`;
      const secondPromptToken = `SERVER_PROMPT_TWO_${Date.now()}`;

      const sendPrompt = async (token: string): Promise<void> => {
        await fetchJson<void>(
          `${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(workspaceDir)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              parts: [{ type: 'text', text: `Reply with exactly ${token}` }],
            }),
          },
        );
      };

      await sendPrompt(firstPromptToken);
      await waitFor(async () => {
        const nextMessages = await listMessages();
        return nextMessages.length > initialMessages.length
          && JSON.stringify(nextMessages).includes(firstPromptToken);
      }, { timeoutMs: 90_000 });

      const afterFirstPrompt = await listMessages();
      await sendPrompt(secondPromptToken);
      await waitFor(async () => {
        const nextMessages = await listMessages();
        return nextMessages.length > afterFirstPrompt.length
          && JSON.stringify(nextMessages).includes(secondPromptToken);
      }, { timeoutMs: 90_000 });

      const finalMessages = await listMessages();
      const transcriptJson = JSON.stringify(finalMessages);
      expect(transcriptJson).toContain(firstPromptToken);
      expect(transcriptJson).toContain(secondPromptToken);
    },
    240_000,
  );
});
