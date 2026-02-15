import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tweetnacl from 'tweetnacl';

import { installAxiosFastifyAdapter } from '@/ui/testkit/axiosFastifyAdapter.testkit';
import { createEnvKeyScope, setStdioTtyForTest } from '@/ui/testkit/authNonInteractiveGlobals.testkit';

const spawnSyncMock = vi.fn();

vi.mock('cross-spawn', () => {
  return {
    default: {
      sync: (...args: any[]) => spawnSyncMock(...(args as [string, string[], any])),
    },
  };
});

describe('auth pair-remote (ssh) (json)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_VARIANT',
  ] as const;

  let restoreTty: (() => void) | null = null;
  let localHomeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    vi.useRealTimers();
    envScope = createEnvKeyScope(envKeys);
    localHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-auth-local-'));
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    spawnSyncMock.mockReset();
  });

  afterEach(async () => {
    restoreTty?.();
    restoreTty = null;
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    await rm(localHomeDir, { recursive: true, force: true });
  });

  it('orchestrates remote request + local approve + remote wait using ssh', async () => {
    const requests = new Map<string, { response: string | null }>();
    const app = fastify({ logger: false });

    app.post('/v1/auth/response', async (req, reply) => {
      const authHeader = String((req.headers as any)?.authorization ?? '');
      if (authHeader !== 'Bearer local-token') return reply.code(401).send({ error: 'unauthorized' });
      const body = req.body as { publicKey?: unknown; response?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const response = typeof body?.response === 'string' ? body.response : '';
      if (!publicKey || !response) return reply.code(400).send({ error: 'invalid' });
      requests.set(publicKey, { response });
      return reply.send({ success: true });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(9), token: 'local-token' });

      const remoteKeypair = tweetnacl.box.keyPair();
      const remotePublicKey = Buffer.from(remoteKeypair.publicKey).toString('base64');
      const remoteRequestJson = JSON.stringify({ publicKey: remotePublicKey, claimSecret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url') });

      spawnSyncMock
        // remote request
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(remoteRequestJson + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        // remote wait
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await handleAuthPairRemote(['--ssh', 'user@host', '--json']);
      } finally {
        logSpy.mockRestore();
      }

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      const firstCall = spawnSyncMock.mock.calls[0] as any[];
      expect(firstCall[0]).toBe('ssh');
      expect(firstCall[1][0]).toBe('user@host');
      expect(firstCall[1].join(' ')).toContain('happier auth request --json');

      const secondCall = spawnSyncMock.mock.calls[1] as any[];
      expect(secondCall[0]).toBe('ssh');
      expect(secondCall[1][0]).toBe('user@host');
      expect(secondCall[1].join(' ')).toContain(`happier auth wait --public-key ${remotePublicKey} --json`);

      expect(requests.has(remotePublicKey)).toBe(true);
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
