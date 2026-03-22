import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});
