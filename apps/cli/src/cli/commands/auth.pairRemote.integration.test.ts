import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { decodeBase64 } from '@/api/encryption';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

const spawnSyncMock = vi.fn();

vi.mock('cross-spawn', () => {
  return {
    default: {
      sync: (...args: any[]) => spawnSyncMock(...(args as [string, string[], any])),
    },
  };
});

describe('auth pair-remote (ssh)', () => {
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
    localHomeDir = await createTempDir('happier-cli-auth-local-');
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    spawnSyncMock.mockReset();
  });

  afterEach(async () => {
    restoreTty?.();
    restoreTty = null;
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    await removeTempDir(localHomeDir);
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
      const legacySecret = new Uint8Array(32).fill(9);
      await writeCredentialsLegacy({ secret: legacySecret, token: 'local-token' });

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
      const { decryptWithEphemeralKey } = await import('@/ui/auth');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthPairRemote(['--ssh', 'user@host', '--json', '--no-post-check']);
      } finally {
        output.restore();
      }

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      const firstCall = spawnSyncMock.mock.calls[0] as any[];
      expect(firstCall[0]).toBe('ssh');
      expect(firstCall[1][0]).toBe('user@host');
      expect(firstCall[1].join(' ')).toContain('happier auth request --json');
      expect(firstCall[1]).toEqual([
        'user@host',
        'happier',
        'auth',
        'request',
        '--json',
        '--persist',
        '--server-url',
        'http://happier-auth.test',
        '--webapp-url',
        'http://webapp.test',
      ]);

      const secondCall = spawnSyncMock.mock.calls[1] as any[];
      expect(secondCall[0]).toBe('ssh');
      expect(secondCall[1][0]).toBe('user@host');
      expect(secondCall[1].join(' ')).toContain(`happier auth wait --public-key ${remotePublicKey} --json`);
      expect(secondCall[1]).toEqual([
        'user@host',
        'happier',
        'auth',
        'wait',
        '--public-key',
        remotePublicKey,
        '--json',
        '--persist',
        '--server-url',
        'http://happier-auth.test',
        '--webapp-url',
        'http://webapp.test',
      ]);

      expect(requests.has(remotePublicKey)).toBe(true);
      const response = requests.get(remotePublicKey)?.response;
      expect(typeof response).toBe('string');
      const decrypted = decryptWithEphemeralKey(decodeBase64(String(response)), remoteKeypair.secretKey);
      const expectedMachineKey = deriveAccountMachineKeyFromRecoverySecret(legacySecret);
      expect(decrypted).not.toBeNull();
      expect(decrypted?.[0]).toBe(0);
      expect(Array.from(decrypted?.slice(1, 33) ?? [])).toEqual(Array.from(expectedMachineKey));
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('skips the post-pair repair check when the remote CLI cannot report the paired server id', async () => {
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
      const remoteRequestJson = JSON.stringify({
        publicKey: remotePublicKey,
        claimSecret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
      });

      spawnSyncMock
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(remoteRequestJson + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ findings: ['would-be-unscoped'] }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthPairRemote(['--ssh', 'user@host', '--json']);
      } finally {
        output.restore();
      }

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(requests.has(remotePublicKey)).toBe(true);
      expect(JSON.parse(output.logs.join('\n'))).toEqual(expect.objectContaining({
        success: true,
        postCheck: {
          skipped: true,
          reason: 'remote-server-id-unavailable',
        },
      }));
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('reuses the approving machine data key when pairing a remote machine', async () => {
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
      const machineKey = new Uint8Array(32).fill(7);
      const { writeCredentialsDataKey } = await import('@/persistence');
      await writeCredentialsDataKey({
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        machineKey,
        token: 'local-token',
      });

      const remoteKeypair = tweetnacl.box.keyPair();
      const remotePublicKey = Buffer.from(remoteKeypair.publicKey).toString('base64');
      const remoteRequestJson = JSON.stringify({ publicKey: remotePublicKey, claimSecret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url') });

      spawnSyncMock
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(remoteRequestJson + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const { decryptWithEphemeralKey } = await import('@/ui/auth');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthPairRemote(['--ssh', 'user@host', '--json', '--no-post-check']);
      } finally {
        output.restore();
      }

      const response = requests.get(remotePublicKey)?.response;
      expect(typeof response).toBe('string');
      const decrypted = decryptWithEphemeralKey(decodeBase64(String(response)), remoteKeypair.secretKey);
      expect(decrypted).not.toBeNull();
      expect(decrypted?.[0]).toBe(0);
      expect(Array.from(decrypted?.slice(1, 33) ?? [])).toEqual(Array.from(machineKey));
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
