import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { decodeBase64 } from '@/api/encryption';
import { safeBashSingleQuote } from '@/capabilities/systemTasks/ssh/sshTransport';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

const spawnSyncMock = vi.fn();

function normalizeExpectedUrl(raw: string): string {
  return new URL(raw).toString().replace(/\/+$/, '');
}

function expectBuiltSshInvocation(argv: unknown, params: Readonly<{
  target: string;
  remoteCommand: string;
  interactive?: boolean;
}>): void {
  const actual = Array.isArray(argv) ? argv.map((entry) => String(entry)) : [];
  expect(actual).toEqual([
    ...(params.interactive ? ['-t'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=yes',
    params.target,
    'bash',
    '-lc',
    params.remoteCommand,
  ]);
}

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
      expectBuiltSshInvocation(firstCall[1], {
        target: 'user@host',
        remoteCommand: [
          safeBashSingleQuote('happier'),
          safeBashSingleQuote('auth'),
          safeBashSingleQuote('request'),
          safeBashSingleQuote('--json'),
          safeBashSingleQuote('--persist'),
          safeBashSingleQuote('--server-url'),
          safeBashSingleQuote('http://happier-auth.test'),
          safeBashSingleQuote('--webapp-url'),
          safeBashSingleQuote('http://webapp.test'),
        ].join(' '),
      });

      const secondCall = spawnSyncMock.mock.calls[1] as any[];
      expect(secondCall[0]).toBe('ssh');
      expectBuiltSshInvocation(secondCall[1], {
        target: 'user@host',
        remoteCommand: [
          safeBashSingleQuote('happier'),
          safeBashSingleQuote('auth'),
          safeBashSingleQuote('wait'),
          safeBashSingleQuote('--public-key'),
          safeBashSingleQuote(remotePublicKey),
          safeBashSingleQuote('--json'),
          safeBashSingleQuote('--persist'),
          safeBashSingleQuote('--server-url'),
          safeBashSingleQuote('http://happier-auth.test'),
          safeBashSingleQuote('--webapp-url'),
          safeBashSingleQuote('http://webapp.test'),
        ].join(' '),
      });

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
  }, 40_000);

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
      const { writeCredentialsDataKey, writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(9), token: 'local-token' });
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

  it('shell-quotes remote ssh commands in json mode for request, wait, and post-check capture', async () => {
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

      const remoteExecutable = "happier; touch /tmp/pwn";
      const remoteServerUrl = "https://relay.example.test/with;semi?x='quoted'";
      const remoteWebappUrl = "https://app.example.test/from;web?y='quoted'";
      const normalizedRemoteServerUrl = normalizeExpectedUrl(remoteServerUrl);
      const normalizedRemoteWebappUrl = normalizeExpectedUrl(remoteWebappUrl);
      const remotePublicKey = Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64');

      spawnSyncMock
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            publicKey: remotePublicKey,
            serverId: 'server-123',
          }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ ok: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthPairRemote([
          '--ssh',
          'user@host',
          '--json',
          '--remote-command',
          remoteExecutable,
          '--remote-server-url',
          remoteServerUrl,
          '--remote-webapp-url',
          remoteWebappUrl,
        ]);
      } finally {
        output.restore();
      }

      expect(requests.has(remotePublicKey)).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledTimes(3);
      expectBuiltSshInvocation(spawnSyncMock.mock.calls[0]?.[1], {
        target: 'user@host',
        remoteCommand: [
          safeBashSingleQuote(remoteExecutable),
          safeBashSingleQuote('auth'),
          safeBashSingleQuote('request'),
          safeBashSingleQuote('--json'),
          safeBashSingleQuote('--persist'),
          safeBashSingleQuote('--server-url'),
          safeBashSingleQuote(normalizedRemoteServerUrl),
          safeBashSingleQuote('--webapp-url'),
          safeBashSingleQuote(normalizedRemoteWebappUrl),
        ].join(' '),
      });
      expectBuiltSshInvocation(spawnSyncMock.mock.calls[1]?.[1], {
        target: 'user@host',
        remoteCommand: [
          safeBashSingleQuote(remoteExecutable),
          safeBashSingleQuote('auth'),
          safeBashSingleQuote('wait'),
          safeBashSingleQuote('--public-key'),
          safeBashSingleQuote(remotePublicKey),
          safeBashSingleQuote('--json'),
          safeBashSingleQuote('--persist'),
          safeBashSingleQuote('--server-url'),
          safeBashSingleQuote(normalizedRemoteServerUrl),
          safeBashSingleQuote('--webapp-url'),
          safeBashSingleQuote(normalizedRemoteWebappUrl),
        ].join(' '),
      });
      expectBuiltSshInvocation(spawnSyncMock.mock.calls[2]?.[1], {
        target: 'user@host',
        remoteCommand: [
          safeBashSingleQuote(remoteExecutable),
          safeBashSingleQuote('doctor'),
          safeBashSingleQuote('repair'),
          safeBashSingleQuote('--report-only'),
          safeBashSingleQuote('--json'),
          safeBashSingleQuote('--server'),
          safeBashSingleQuote('server-123'),
        ].join(' '),
      });
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('shell-quotes the interactive post-check ssh command in text mode', async () => {
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
    const restoreInteractiveTty = setStdioTtyForTest({ stdin: true, stdout: true });

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

      const remoteExecutable = "happier; touch /tmp/pwn";
      const remotePublicKey = Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64');
      spawnSyncMock
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            publicKey: remotePublicKey,
            serverId: 'server-456',
          }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.from(JSON.stringify({ success: true }) + '\n', 'utf8'),
          stderr: Buffer.alloc(0),
        }))
        .mockImplementationOnce((_cmd, _args) => ({
          status: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }));

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthPairRemote([
          '--ssh',
          'user@host',
          '--remote-command',
          remoteExecutable,
        ]);
      } finally {
        output.restore();
      }

      expect(requests.has(remotePublicKey)).toBe(true);
      expectBuiltSshInvocation(spawnSyncMock.mock.calls[2]?.[1], {
        target: 'user@host',
        interactive: true,
        remoteCommand: [
          safeBashSingleQuote(remoteExecutable),
          safeBashSingleQuote('doctor'),
          safeBashSingleQuote('repair'),
          safeBashSingleQuote('--server'),
          safeBashSingleQuote('server-456'),
        ].join(' '),
      });
    } finally {
      restoreInteractiveTty();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('rejects ssh targets that start with an OpenSSH option before spawning', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_VARIANT: 'stable',
      });

      vi.resetModules();
      const { handleAuthPairRemote } = await import('./auth/pairRemote');
      await expect(handleAuthPairRemote(['--ssh', '-Fmalicious', '--json'])).rejects.toThrow('target must not start with "-"');
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
