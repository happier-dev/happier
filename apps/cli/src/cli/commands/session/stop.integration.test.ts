import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session stop (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-stop-'));

    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:12345';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    mockIo.mockReset();
  });

  afterEach(async () => {
    if (happyHomeDir) await rm(happyHomeDir, { recursive: true, force: true });

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('emits session-end and returns a session_stop JSON envelope', async () => {
    const sessionId = 'sess_integration_stop_123';
    const emitSpy = vi.fn((...args: any[]) => {
      const cb = args[2];
      if (typeof cb === 'function') cb();
    });

    mockIo.mockImplementation(() => {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      });
      const connect = vi.fn(() => {
        const list = handlers.get('connect') ?? [];
        for (const cb of list) cb();
      });
      return {
        on,
        off: vi.fn(),
        connect,
        emit: emitSpy,
        disconnect: vi.fn(),
        close: vi.fn(),
      };
    });

    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['stop', sessionId, '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(emitSpy).toHaveBeenCalledWith('session-end', expect.objectContaining({ sid: sessionId }), expect.anything());

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_stop');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.stopped).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
