import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tweetnacl from 'tweetnacl';

import { installAxiosFastifyAdapter } from '@/ui/testHelpers/axiosFastifyAdapter.testHelper';
import {
  captureConsoleLogAndMuteStdout,
  createEnvKeyScope,
  setStdioTtyForTest,
} from '@/ui/testHelpers/authNonInteractiveGlobals.testHelper';

type LegacyRequestRow = { response: string | null; pollCount: number };

function encryptForTerminal(recipientPublicKey: Uint8Array, plaintext: Uint8Array): string {
  const ephemeral = tweetnacl.box.keyPair();
  const nonce = randomBytes(tweetnacl.box.nonceLength);
  const cipher = tweetnacl.box(plaintext, nonce, recipientPublicKey, ephemeral.secretKey);
  const bundle = Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(nonce), Buffer.from(cipher)]);
  return bundle.toString('base64');
}

function parsePublicKey(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const publicKey = (body as { publicKey?: unknown }).publicKey;
  return typeof publicKey === 'string' ? publicKey : null;
}

function installLegacyAuthRequestRoute(params: Readonly<{
  token: string;
  rows: Map<string, LegacyRequestRow>;
  strictUnknownKeys?: boolean;
  app: ReturnType<typeof fastify>;
}>): void {
  params.app.post('/v1/auth/request', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const publicKey = parsePublicKey(body);
    if (!publicKey) return reply.code(400).send({ error: 'bad_request' });

    if (params.strictUnknownKeys) {
      const keys = Object.keys(body ?? {});
      if (keys.some((key) => key !== 'publicKey')) {
        return reply.code(400).send({ error: 'unknown_key' });
      }
    }

    const row = params.rows.get(publicKey) ?? { response: null, pollCount: 0 };
    row.pollCount += 1;
    if (!row.response && row.pollCount >= 2) {
      const recipientPk = new Uint8Array(Buffer.from(publicKey, 'base64'));
      const secret = new Uint8Array(32).fill(7);
      row.response = encryptForTerminal(recipientPk, secret);
    }
    params.rows.set(publicKey, row);

    if (row.response) {
      return reply.send({ state: 'authorized', token: params.token, response: row.response });
    }
    return reply.send({ state: 'requested' });
  });
}

describe('authAndSetupMachineIfNeeded (legacy server fallback) (integration)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'DEBUG',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ] as const;

  let restoreTty: (() => void) | null = null;
  let homeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    vi.useRealTimers();
    envScope = createEnvKeyScope(envKeys);
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-auth-legacy-'));
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_AUTH_METHOD: 'web',
      HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
      DEBUG: '0',
      HAPPIER_SERVER_URL: 'http://happier-legacy.test',
      HAPPIER_WEBAPP_URL: 'http://example.test',
    });
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  });

  afterEach(async () => {
    restoreTty?.();
    restoreTty = null;
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('falls back to legacy /v1/auth/request polling when /v1/auth/request/claim is missing', async () => {
    const requests = new Map<string, LegacyRequestRow>();
    const statusChecks = new Map<string, number>();
    const app = fastify({ logger: false });

    installLegacyAuthRequestRoute({
      app,
      rows: requests,
      token: 'token-legacy',
    });

    app.get('/v1/auth/request/status', async (req, reply) => {
      const query = req.query as { publicKey?: unknown } | undefined;
      const publicKey = typeof query?.publicKey === 'string' ? query.publicKey : '';
      const row = requests.get(publicKey);
      if (!row) return reply.send({ status: 'not_found', supportsV2: false });
      const checks = statusChecks.get(publicKey) ?? 0;
      statusChecks.set(publicKey, checks + 1);
      if (!row.response && checks >= 1) {
        const recipientPk = new Uint8Array(Buffer.from(publicKey, 'base64'));
        const secret = new Uint8Array(32).fill(7);
        row.response = encryptForTerminal(recipientPk, secret);
      }
      if (row.response) return reply.send({ status: 'authorized', supportsV2: true });
      return reply.send({ status: 'pending', supportsV2: true });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({
      app,
      origin: process.env.HAPPIER_SERVER_URL ?? '',
    });
    vi.resetModules();
    const { authAndSetupMachineIfNeeded } = await import('./auth');
    const output = captureConsoleLogAndMuteStdout();
    try {
      const result = await authAndSetupMachineIfNeeded();
      expect(result.credentials.token).toBe('token-legacy');
      expect(result.credentials.encryption.type).toBe('legacy');
    } finally {
      output.restore();
      restoreAxios();
      await app.close();
    }
  }, 15_000);

  it('falls back to legacy /v1/auth/request polling when /v1/auth/request/status is missing', async () => {
    const requests = new Map<string, LegacyRequestRow>();
    const app = fastify({ logger: false });

    installLegacyAuthRequestRoute({
      app,
      rows: requests,
      token: 'token-legacy-2',
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({
      app,
      origin: process.env.HAPPIER_SERVER_URL ?? '',
    });
    vi.resetModules();
    const { authAndSetupMachineIfNeeded } = await import('./auth');
    const output = captureConsoleLogAndMuteStdout();
    try {
      const result = await authAndSetupMachineIfNeeded();
      expect(result.credentials.token).toBe('token-legacy-2');
      expect(result.credentials.encryption.type).toBe('legacy');
    } finally {
      output.restore();
      restoreAxios();
      await app.close();
    }
  }, 15_000);

  it('retries /v1/auth/request without extra fields when a legacy server rejects unknown keys', async () => {
    const requests = new Map<string, LegacyRequestRow>();
    const app = fastify({ logger: false });

    installLegacyAuthRequestRoute({
      app,
      rows: requests,
      token: 'token-legacy-strict',
      strictUnknownKeys: true,
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({
      app,
      origin: process.env.HAPPIER_SERVER_URL ?? '',
    });
    vi.resetModules();
    const { authAndSetupMachineIfNeeded } = await import('./auth');
    const output = captureConsoleLogAndMuteStdout();
    try {
      const result = await authAndSetupMachineIfNeeded();
      expect(result.credentials.token).toBe('token-legacy-strict');
      expect(result.credentials.encryption.type).toBe('legacy');
    } finally {
      output.restore();
      restoreAxios();
      await app.close();
    }
  }, 15_000);
});
