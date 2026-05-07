import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';

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

describe('auth pair-remote server selection', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_LOCAL_SERVER_URL',
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

  it('pairs in text mode with an explicit remote server URL while approving through the local API URL', async () => {
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://relay.example.test',
        HAPPIER_WEBAPP_URL: 'https://app.example.test',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(9), token: 'local-token' });

      const remoteKeypair = tweetnacl.box.keyPair();
      const remotePublicKey = Buffer.from(remoteKeypair.publicKey).toString('base64');
      const remoteRequestJson = JSON.stringify({
        publicKey: remotePublicKey,
        serverUrl: 'https://relay.example.test',
      });

      spawnSyncMock
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: Buffer.from(remoteRequestJson + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await expect(handleAuthPairRemote([
          '--ssh',
          'user@host',
          '--no-post-check',
          '--remote-server-url',
          'https://relay.example.test',
          '--remote-webapp-url',
          'https://app.example.test',
        ])).resolves.toBeUndefined();
      } finally {
        output.restore();
      }

      expect(requests.has(remotePublicKey)).toBe(true);
      expect(output.logs.join('\n')).toContain('Remote machine paired');
      expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
        'user@host',
        'happier',
        'auth',
        'request',
        '--json',
        '--persist',
        '--server-url',
        'https://relay.example.test',
        '--webapp-url',
        'https://app.example.test',
      ]);
    } finally {
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('prompts with current-machine reachable address choices when the selected relay is loopback-only', async () => {
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
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://127.0.0.1:52753' });
    const restoreInteractiveTty = setStdioTtyForTest({ stdin: true, stdout: true });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
        HAPPIER_WEBAPP_URL: 'http://127.0.0.1:52753',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(9), token: 'local-token' });

      const remoteKeypair = tweetnacl.box.keyPair();
      const remotePublicKey = Buffer.from(remoteKeypair.publicKey).toString('base64');
      const remoteReachableUrl = 'http://100.96.55.1:52753';

      spawnSyncMock
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            publicKey: remotePublicKey,
            serverUrl: remoteReachableUrl,
          }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
      }));

      const promptForCurrentMachineReachableServerUrl = vi.fn(async () => remoteReachableUrl);

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await expect(handleAuthPairRemote(['--ssh', 'user@host', '--no-post-check'], {
          promptForCurrentMachineReachableServerUrl,
        })).resolves.toBeUndefined();
      } finally {
        output.restore();
      }

      expect(promptForCurrentMachineReachableServerUrl).toHaveBeenCalledWith(expect.objectContaining({
        localServerUrl: 'http://127.0.0.1:52753',
      }));
      expect(requests.has(remotePublicKey)).toBe(true);
      expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
        'user@host',
        'happier',
        'auth',
        'request',
        '--json',
        '--persist',
        '--server-url',
        remoteReachableUrl,
        '--webapp-url',
        remoteReachableUrl,
      ]);
    } finally {
      restoreInteractiveTty();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('fails before ssh when the selected relay is loopback and no remote server URL is provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
        HAPPIER_WEBAPP_URL: 'http://127.0.0.1:52753',
        HAPPIER_VARIANT: 'stable',
      });
      spawnSyncMock.mockImplementationOnce(() => ({
        status: 0,
        stdout: Buffer.from(JSON.stringify({ publicKey: Buffer.from(new Uint8Array(32)).toString('base64') }) + '\n', 'utf8'),
        stderr: Buffer.alloc(0),
      }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      await expect(handleAuthPairRemote(['--ssh', 'user@host', '--json'])).rejects.toThrow('process.exit:1');

      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('--remote-server-url');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('stops before approval when the remote request reports a different relay', async () => {
    const requests = new Map<string, { response: string | null }>();
    const app = fastify({ logger: false });

    app.post('/v1/auth/response', async (req, reply) => {
      const body = req.body as { publicKey?: unknown; response?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const response = typeof body?.response === 'string' ? body.response : '';
      if (publicKey && response) {
        requests.set(publicKey, { response });
      }
      return reply.send({ success: true });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://relay.example.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'https://relay.example.test',
        HAPPIER_WEBAPP_URL: 'https://app.example.test',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(9), token: 'local-token' });

      const remotePublicKey = Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64');
      spawnSyncMock
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            publicKey: remotePublicKey,
            serverUrl: 'https://other-relay.example.test',
          }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      await expect(handleAuthPairRemote(['--ssh', 'user@host', '--json'])).rejects.toThrow('process.exit:1');

      expect(requests.size).toBe(0);
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('different relay');
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
