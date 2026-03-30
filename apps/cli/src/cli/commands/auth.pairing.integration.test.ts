import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { createHash } from 'node:crypto';

import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

type RequestRow = {
  claimSecretHash: string;
  response: string | null;
  responseAccountId: string | null;
};

function sha256Base64Url(input: Buffer): string {
  return createHash('sha256').update(input).digest('base64url');
}

describe('auth pairing commands (request/approve/wait) (json)', () => {
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
  let remoteHomeDir = '';
  let localHomeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    vi.useRealTimers();
    envScope = createEnvKeyScope(envKeys);
    remoteHomeDir = await createTempDir('happier-cli-auth-remote-');
    localHomeDir = await createTempDir('happier-cli-auth-local-');
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  });

  afterEach(async () => {
    restoreTty?.();
    restoreTty = null;
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    await removeTempDir(remoteHomeDir);
    await removeTempDir(localHomeDir);
  });

  it('pairs a remote machine by creating a claim-gated request, approving it with an authenticated local CLI, then waiting and writing dataKey credentials on the remote', async () => {
    const requests = new Map<string, RequestRow>();
    const app = fastify({ logger: false });

    app.post('/v1/auth/request', async (req, reply) => {
      const body = req.body as { publicKey?: unknown; claimSecretHash?: unknown; supportsV2?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const claimSecretHash = typeof body?.claimSecretHash === 'string' ? body.claimSecretHash : '';
      if (!publicKey || !claimSecretHash) return reply.code(400).send({ error: 'claim_required' });
      if (!requests.has(publicKey)) {
        requests.set(publicKey, { claimSecretHash, response: null, responseAccountId: null });
      }
      return reply.send({ state: 'requested' });
    });

    app.get('/v1/auth/request/status', async (req, reply) => {
      const query = req.query as { publicKey?: unknown } | undefined;
      const publicKey = typeof query?.publicKey === 'string' ? query.publicKey : '';
      const row = requests.get(publicKey);
      if (!row) return reply.send({ status: 'not_found', supportsV2: false });
      if (row.response && row.responseAccountId) return reply.send({ status: 'authorized', supportsV2: true });
      return reply.send({ status: 'pending', supportsV2: true });
    });

    app.post('/v1/auth/response', async (req, reply) => {
      const authHeader = String((req.headers as any)?.authorization ?? '');
      if (authHeader !== 'Bearer local-token') return reply.code(401).send({ error: 'unauthorized' });
      const body = req.body as { publicKey?: unknown; response?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const response = typeof body?.response === 'string' ? body.response : '';
      const row = requests.get(publicKey);
      if (!row) return reply.code(404).send({ error: 'Request not found' });
      if (!row.response) {
        row.response = response;
        row.responseAccountId = 'account-1';
      }
      return reply.send({ success: true });
    });

    app.post('/v1/auth/request/claim', async (req, reply) => {
      const body = req.body as { publicKey?: unknown; claimSecret?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const row = requests.get(publicKey);
      if (!row) return reply.code(410).send({ error: 'expired' });

      const claimSecret = typeof body?.claimSecret === 'string' ? body.claimSecret : '';
      const claimBytes = Buffer.from(claimSecret, 'base64url');
      if (sha256Base64Url(claimBytes) !== row.claimSecretHash) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!row.response || !row.responseAccountId) return reply.send({ state: 'requested' });
      return reply.send({ state: 'authorized', token: 'issued-token', response: row.response });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });

    try {
      // 1) Remote: create pairing request (json output should be clean even in dev variant)
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_METHOD: 'web',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_VARIANT: 'dev',
      });
      vi.resetModules();
      const remoteLogs: string[] = [];
      const remoteWarns: string[] = [];
      const remoteLogSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        remoteLogs.push(args.map((arg) => String(arg)).join(' '));
      });
      const remoteWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        remoteWarns.push(args.map((arg) => String(arg)).join(' '));
      });
      const remoteWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const { handleAuthRequest } = await import('./auth/request');
      let requestJson: any;
      try {
        await handleAuthRequest(['--json']);
        expect(remoteWarns).toEqual([]);
        expect(remoteLogs.length).toBe(1);
        requestJson = JSON.parse(remoteLogs[0] ?? '');
      } finally {
        remoteLogSpy.mockRestore();
        remoteWarnSpy.mockRestore();
        remoteWriteSpy.mockRestore();
      }
      expect(typeof requestJson.publicKey).toBe('string');
      expect(typeof requestJson.claimSecret).toBe('string');

      // 2) Local: approve using existing local credentials (token never leaves local machine)
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

      vi.resetModules();
      const { handleAuthApprove } = await import('./auth/approve');
      const approveOut = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthApprove(['--public-key', requestJson.publicKey, '--json']);
        expect(approveOut.logs.length).toBe(1);
        expect(JSON.parse(approveOut.logs[0] ?? '')).toEqual({ success: true });
      } finally {
        approveOut.restore();
      }

      // 3) Remote: wait + claim, then write credentials (dataKey)
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();
      const { handleAuthWait } = await import('./auth/wait');
      const waitOut = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthWait(['--public-key', requestJson.publicKey, '--json']);
        expect(waitOut.logs.length).toBe(1);
        const parsed = JSON.parse(waitOut.logs[0] ?? '');
        expect(parsed.success).toBe(true);
        expect(parsed.token).toBe('issued-token');
        expect(parsed.encryptionType).toBe('dataKey');
      } finally {
        waitOut.restore();
      }

      const { readCredentials } = await import('@/persistence');
      const creds = await readCredentials();
      expect(creds?.token).toBe('issued-token');
      expect(creds?.encryption.type).toBe('dataKey');
      expect(Array.from(creds?.encryption.type === 'dataKey' ? creds.encryption.machineKey : [])).toEqual(
        Array.from(deriveAccountMachineKeyFromRecoverySecret(legacySecret)),
      );
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('ensures a local machine id when auth wait runs on an already authenticated machine', async () => {
    const requests = new Map<string, RequestRow>();
    const app = fastify({ logger: false });

    app.post('/v1/auth/request', async (req, reply) => {
      const body = req.body as { publicKey?: unknown; claimSecretHash?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const claimSecretHash = typeof body?.claimSecretHash === 'string' ? body.claimSecretHash : '';
      if (!publicKey || !claimSecretHash) return reply.code(400).send({ error: 'claim_required' });
      requests.set(publicKey, { claimSecretHash, response: null, responseAccountId: null });
      return reply.send({ state: 'requested' });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_METHOD: 'web',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_VARIANT: 'stable',
      });

      vi.resetModules();
      const { handleAuthRequest } = await import('./auth/request');
      const requestOut = captureConsoleLogAndMuteStdout();
      let requestJson: { publicKey: string };
      try {
        await handleAuthRequest(['--json']);
        requestJson = JSON.parse(requestOut.logs[0] ?? '') as { publicKey: string };
      } finally {
        requestOut.restore();
      }

      vi.resetModules();
      const { writeCredentialsLegacy, readSettings } = await import('@/persistence');
      const legacySecret = new Uint8Array(32).fill(4);
      const tokenPayload = Buffer.from(JSON.stringify({ sub: 'acct_local' })).toString('base64url');
      await writeCredentialsLegacy({ secret: legacySecret, token: `header.${tokenPayload}.sig` });

      vi.resetModules();
      const { handleAuthWait } = await import('./auth/wait');
      const waitOut = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthWait(['--public-key', requestJson.publicKey, '--json']);
        expect(waitOut.logs.length).toBe(1);
        const parsed = JSON.parse(waitOut.logs[0] ?? '') as {
          success?: boolean;
          machineId?: string;
          encryptionType?: string;
        };
        expect(parsed.success).toBe(true);
        expect(parsed.encryptionType).toBe('legacy');
        expect(typeof parsed.machineId).toBe('string');
        expect(parsed.machineId?.length).toBeGreaterThan(0);
      } finally {
        waitOut.restore();
      }

      const settings = await readSettings();
      expect(settings.machineId).toMatch(/^[-a-z0-9]+$/i);
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
