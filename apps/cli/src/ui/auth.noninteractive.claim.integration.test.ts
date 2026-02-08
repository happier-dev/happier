import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
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

function sha256Base64Url(input: Buffer): string {
  return createHash('sha256').update(input).digest('base64url');
}

function encryptForTerminal(recipientPublicKey: Uint8Array, plaintext: Uint8Array): string {
  const ephemeral = tweetnacl.box.keyPair();
  const nonce = randomBytes(tweetnacl.box.nonceLength);
  const cipher = tweetnacl.box(plaintext, nonce, recipientPublicKey, ephemeral.secretKey);
  const bundle = Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(nonce), Buffer.from(cipher)]);
  return bundle.toString('base64');
}

type ClaimRequestRow = { claimSecretHash: string; response: string | null; statusChecks: number };

function parseAuthRequestBody(body: unknown): { publicKey: string; claimSecretHash: string } | null {
  if (!body || typeof body !== 'object') return null;
  const publicKey = (body as { publicKey?: unknown }).publicKey;
  const claimSecretHash = (body as { claimSecretHash?: unknown }).claimSecretHash;
  if (typeof publicKey !== 'string') return null;
  if (typeof claimSecretHash !== 'string' || !claimSecretHash.trim()) return null;
  return { publicKey, claimSecretHash };
}

describe('authAndSetupMachineIfNeeded (non-TTY) (status+claim)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ] as const;

  let restoreTty: (() => void) | null = null;
  let homeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    vi.useRealTimers();
    envScope = createEnvKeyScope(envKeys);
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-auth-nontty-'));
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_AUTH_METHOD: 'web',
      HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
      HAPPIER_SERVER_URL: 'http://happier-auth.test',
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

  it('completes web auth without Ink by polling status and claiming once authorized', async () => {
    const requests = new Map<string, ClaimRequestRow>();
    const app = fastify({ logger: false });

    app.post('/v1/auth/request', async (req, reply) => {
      const parsed = parseAuthRequestBody(req.body);
      if (!parsed) return reply.code(400).send({ error: 'claim_required' });

      if (!requests.has(parsed.publicKey)) {
        requests.set(parsed.publicKey, {
          claimSecretHash: parsed.claimSecretHash,
          response: null,
          statusChecks: 0,
        });
      }
      return reply.send({ state: 'requested' });
    });

    app.get('/v1/auth/request/status', async (req, reply) => {
      const query = req.query as { publicKey?: unknown } | undefined;
      const publicKey = typeof query?.publicKey === 'string' ? query.publicKey : '';
      const row = requests.get(publicKey);
      if (!row) return reply.send({ status: 'not_found', supportsV2: false });

      row.statusChecks += 1;
      if (!row.response && row.statusChecks >= 1) {
        const recipientPk = new Uint8Array(Buffer.from(publicKey, 'base64'));
        const secret = new Uint8Array(32).fill(7);
        row.response = encryptForTerminal(recipientPk, secret);
      }

      if (row.response) return reply.send({ status: 'authorized', supportsV2: true });
      return reply.send({ status: 'pending', supportsV2: true });
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
      if (!row.response) return reply.send({ state: 'requested' });
      return reply.send({ state: 'authorized', token: 'token-1', response: row.response });
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

      expect(result.credentials.token).toBe('token-1');
      expect(result.credentials.encryption.type).toBe('legacy');
    } finally {
      output.restore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 15_000);

  it('returns null with a clear message when claim returns 410 consumed', async () => {
    const requests = new Map<string, ClaimRequestRow>();
    const app = fastify({ logger: false });

    app.post('/v1/auth/request', async (req, reply) => {
      const parsed = parseAuthRequestBody(req.body);
      if (!parsed) return reply.code(400).send({ error: 'claim_required' });

      if (!requests.has(parsed.publicKey)) {
        requests.set(parsed.publicKey, {
          claimSecretHash: parsed.claimSecretHash,
          response: null,
          statusChecks: 0,
        });
      }
      return reply.send({ state: 'requested' });
    });

    app.get('/v1/auth/request/status', async (req, reply) => {
      const query = req.query as { publicKey?: unknown } | undefined;
      const publicKey = typeof query?.publicKey === 'string' ? query.publicKey : '';
      const row = requests.get(publicKey);
      if (!row) return reply.send({ status: 'not_found', supportsV2: false });

      row.statusChecks += 1;
      if (!row.response && row.statusChecks >= 1) {
        const recipientPk = new Uint8Array(Buffer.from(publicKey, 'base64'));
        const secret = new Uint8Array(32).fill(7);
        row.response = encryptForTerminal(recipientPk, secret);
      }

      if (row.response) return reply.send({ status: 'authorized', supportsV2: true });
      return reply.send({ status: 'pending', supportsV2: true });
    });

    app.post('/v1/auth/request/claim', async (_req, reply) => {
      return reply.code(410).send({ error: 'consumed' });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({
      app,
      origin: process.env.HAPPIER_SERVER_URL ?? '',
    });
    vi.resetModules();
    const { doAuth } = await import('./auth');

    const output = captureConsoleLogAndMuteStdout();
    try {
      const result = await doAuth();
      expect(result).toBeNull();
      expect(output.logs.join('\n').toLowerCase()).toContain('claimed');
    } finally {
      output.restore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 15_000);
});
