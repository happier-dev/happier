import { spawn as spawnChild } from 'node:child_process';
import { once } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const events: string[] = [];
let spawned = false;
let fetchCount = 0;

function encodeMetadata(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

vi.mock('./auth', () => ({
  createTestAuth: async () => {
    events.push('create-auth');
    return { token: 'token-1', publicKeyBase64: 'pk-1' };
  },
}));

vi.mock('./cliAuth', () => ({
  seedCliAuthForServer: async () => {
    events.push('seed-auth');
  },
}));

vi.mock('./cliAttachFile', () => ({
  writeCliSessionAttachFile: async () => {
    events.push('write-attach');
    return '/tmp/attach.json';
  },
}));

vi.mock('./daemon/daemon', () => ({
  stopDaemonFromHomeDir: async () => {
    events.push('stop-daemon');
  },
}));

vi.mock('./manifestForServer', () => ({
  writeTestManifestForServer: () => {
    events.push('write-manifest');
  },
}));

vi.mock('./messageCrypto', () => ({
  encryptLegacyBase64: (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
}));

vi.mock('./decryptLegacyBase64Normalized', () => ({
  decryptLegacyBase64Normalized: (value: string) => JSON.parse(Buffer.from(value, 'base64').toString('utf8')),
}));

vi.mock('./process/serverLight', () => ({
  startServerLight: async () => {
    events.push('start-server');
    return {
      baseUrl: 'http://127.0.0.1:31735',
      stop: async () => {
        events.push('stop-server');
      },
    };
  },
}));

vi.mock('./process/spawnProcess', () => ({
  spawnLoggedProcess: (params: { stdoutPath: string; stderrPath: string }) => {
    events.push('spawn');
    spawned = true;
    return {
      child: { pid: 123 } as never,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
      stop: async () => {
        events.push('stop-proc');
      },
    };
  },
}));

vi.mock('./process/commands', () => ({
  yarnCommand: () => 'yarn',
}));

vi.mock('./sessions', () => ({
  createSessionWithCiphertexts: async () => {
    events.push('create-session');
    return { sessionId: 'session-1', tag: 'tag-1' };
  },
  fetchSessionV2: async () => {
    fetchCount += 1;
    events.push(`fetch-${fetchCount}-${spawned ? 'after-spawn' : 'before-spawn'}`);
    return {
      active: false,
      agentStateVersion: spawned ? 2 : 1,
      seq: 0,
      metadata: encodeMetadata(
        spawned
          ? { codexBackendMode: 'appServer', codexSessionId: 'session-1' }
          : { codexBackendMode: 'appServer' },
      ),
    };
  },
}));

vi.mock('./timing', () => ({
  waitFor: async (fn: () => Promise<boolean>) => {
    events.push('wait-for');
    const result = await fn();
    if (!result) {
      throw new Error('waitFor failed');
    }
  },
}));

describe('startCodexAppServerRemoteHarness', () => {
  beforeEach(() => {
    vi.resetModules();
    events.length = 0;
    spawned = false;
    fetchCount = 0;
  });

  it('captures the pre-spawn session baseline before launching the CLI', async () => {
    const { startCodexAppServerRemoteHarness } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-harness-'));

    const harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: 'run-1',
      testName: 'codex-app-server-harness-race',
    });

    try {
      expect(events).not.toContain('wait-for');
      expect(events).not.toContain('fetch-1-before-spawn');
      expect(events.indexOf('spawn')).toBeLessThan(events.indexOf('fetch-1-after-spawn'));
      expect(harness.readySession.agentStateVersion).toBe(2);
    } finally {
      await harness.stop();
    }
  });

  it('can stop only the spawned Codex runtime while keeping the test server alive', async () => {
    const { startCodexAppServerRemoteHarness } = await import('./codexAppServerRemoteHarness');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-harness-runtime-stop-'));

    const harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: 'run-1',
      testName: 'codex-app-server-harness-runtime-stop',
    });

    try {
      await harness.stopRuntime();
      expect(events).toContain('stop-proc');
      expect(events).not.toContain('stop-server');
    } finally {
      await harness.stop();
    }
  });

  it('writes structured native review payloads for review/start', async () => {
    const { writeFakeCodexAppServerScript } = await import('./codexAppServerRemoteHarness');
    const { parseCodexReviewText } = await import('@/agent/reviews/normalize/codex/parseCodexReviewText');
    const testDir = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-review-'));
    const requestLogPath = join(testDir, 'requests.jsonl');
    const scriptPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath,
    });

    const child = spawnChild(process.execPath, [scriptPath], {
      cwd: testDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let childExited = false;
    child.once('exit', () => {
      childExited = true;
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const notifications: Record<string, unknown>[] = [];
    const pendingResponses = new Map<number, Record<string, unknown>>();
    const responseWaiters = new Map<number, (value: Record<string, unknown>) => void>();

    lines.on('line', (line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = typeof parsed.id === 'number' ? parsed.id : null;
      if (id == null) {
        notifications.push(parsed);
        return;
      }
      const waiter = responseWaiters.get(id);
      if (waiter) {
        responseWaiters.delete(id);
        waiter(parsed);
        return;
      }
      pendingResponses.set(id, parsed);
    });

    const readResponse = async (id: number): Promise<Record<string, unknown>> => {
      const existing = pendingResponses.get(id);
      if (existing) {
        pendingResponses.delete(id);
        return existing;
      }
      return await Promise.race([
        new Promise<Record<string, unknown>>((resolve) => {
          responseWaiters.set(id, resolve);
        }),
        once(child, 'exit').then(() => {
          throw new Error(`Fake app-server exited before response ${id}`);
        }),
      ]);
    };

    const send = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return await readResponse(id);
    };

    try {
      expect(await send(1, 'review/start', {
        threadId: 'thread-started',
        delivery: 'inline',
        target: {
          custom: {
            instructions: 'Review the changed files for duplicate output.',
          },
        },
      })).toMatchObject({
        result: {
          turn: {
            id: expect.stringMatching(/^review-turn-/),
          },
          reviewThreadId: 'thread-started',
        },
      });

      const startedAt = Date.now();
      while (notifications.filter((entry) => entry.method === 'turn/completed').length < 1 && Date.now() - startedAt < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const exitedReviewMode = notifications.find((entry) => entry.method === 'item/completed'
        && (entry.params as { item?: { type?: unknown } } | undefined)?.item?.type === 'exitedReviewMode');
      const agentMessage = notifications.find((entry) => entry.method === 'item/completed'
        && (entry.params as { item?: { type?: unknown } } | undefined)?.item?.type === 'agentMessage');

      const exitedPayload = JSON.parse(String((exitedReviewMode as { params?: { item?: { review?: unknown } } } | undefined)?.params?.item?.review ?? ''));
      const agentPayload = JSON.parse(String((agentMessage as { params?: { item?: { text?: unknown } } } | undefined)?.params?.item?.text ?? ''));

      expect(exitedPayload).toEqual({
        overall_explanation: 'Native Codex review completed.',
        findings: [
          expect.objectContaining({
            title: 'Duplicate assistant text is persisted once',
            body: 'The review bridge should not store both exitedReviewMode text and the matching final assistant message as duplicate output.',
            priority: 2,
            code_location: {
              absolute_file_path: '/fake/workspace/src/nativeReview.ts',
              line_range: { start: 12, end: 14 },
            },
          }),
        ],
      });
      expect(agentPayload).toEqual(exitedPayload);
      expect(parseCodexReviewText(JSON.stringify(exitedPayload))).toMatchObject({
        format: 'native',
        review: {
          summary: 'Native Codex review completed.',
          findings: [{
            title: 'Duplicate assistant text is persisted once',
            severity: 'medium',
            summary: exitedPayload.findings[0].body,
            filePath: '/fake/workspace/src/nativeReview.ts',
            startLine: 12,
            endLine: 14,
          }],
        },
      });
    } finally {
      if (!childExited) child.kill();
      lines.close();
      if (!childExited) await once(child, 'exit').catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
