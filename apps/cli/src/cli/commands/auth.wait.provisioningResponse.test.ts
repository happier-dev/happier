import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  sealTerminalProvisioningV3TokenOnlyPayload,
} from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import {
  ensureProtectedLocalStateDirectory,
  writeProtectedLocalStateFileAtomic,
} from '@/utils/fs/protectedLocalState';
import { configuration, reloadConfiguration } from '@/configuration';
import { readSettings, writeCredentialsTokenOnly } from '@/persistence';
import { handleAuthWait } from './auth/wait';
import { handleAuthCliCommand } from './auth';

// Hoisted passthrough: one test substitutes the features snapshot without
// resetting the module graph that the other tests' static imports share.
const featuresSnapshot = vi.hoisted(() => ({ next: null as null | (() => Promise<unknown>) }));
vi.mock('@/features/serverFeaturesClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/serverFeaturesClient')>();
  return {
    ...actual,
    fetchServerFeaturesSnapshot: (...args: Parameters<typeof actual.fetchServerFeaturesSnapshot>) => {
      const substitute = featuresSnapshot.next;
      return substitute
        ? substitute() as ReturnType<typeof actual.fetchServerFeaturesSnapshot>
        : actual.fetchServerFeaturesSnapshot(...args);
    },
  };
});

function deterministicRandomBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(length);
}

const serverIdentityId = 'srv_auth_wait_home';

describe('auth wait provisioning response', () => {
  const envKeys = [
    'DEBUG',
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
  ] as const;

  let localHomeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    envScope = createEnvKeyScope(envKeys);
    localHomeDir = await createTempDir('happier-cli-auth-wait-');
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    vi.unstubAllGlobals();
    await removeTempDir(localHomeDir);
  });

  async function prepareState(params: Readonly<{
    keypair: ReturnType<typeof tweetnacl.box.keyPair>;
    pairingSecret?: Uint8Array;
    createdAtMs?: number;
    expiresAtMs?: number;
    claimSecret?: string;
    pairingRequirement?: unknown;
    omitPairingRequirement?: boolean;
  }>): Promise<string> {
    envScope.patch({
      HAPPIER_HOME_DIR: localHomeDir,
      HAPPIER_SERVER_URL: 'https://happier-auth.test',
      HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
      HAPPIER_WEBAPP_URL: 'http://webapp.test',
      HAPPIER_AUTH_POLL_INTERVAL_MS: '10',
    });
    reloadConfiguration();
    const publicKeyB64 = Buffer.from(params.keypair.publicKey).toString('base64');
    const statePath = join(
      configuration.activeServerDir,
      'auth',
      'pending',
      `${createHash('sha256').update(Buffer.from(params.keypair.publicKey)).digest('hex').slice(0, 24)}.json`,
    );
    await ensureProtectedLocalStateDirectory(join(configuration.activeServerDir, 'auth', 'pending'), { authority: 'owned' });
    await writeProtectedLocalStateFileAtomic(
      statePath,
      JSON.stringify(
        {
          publicKey: publicKeyB64,
          secretKey: Buffer.from(params.keypair.secretKey).toString('base64'),
          claimSecret: params.claimSecret ?? Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
          serverIdentityId,
          ...(params.pairingSecret
            && params.createdAtMs !== undefined
            && params.expiresAtMs !== undefined
            ? {
                pairingSecret: Buffer.from(params.pairingSecret).toString('base64url'),
                pairingCreatedAtMs: params.createdAtMs,
                pairingExpiresAtMs: params.expiresAtMs,
                supportsTokenOnly: true,
                ...(params.omitPairingRequirement
                  ? {}
                  : { pairingRequirement: params.pairingRequirement ?? 'v3' }),
              }
            : params.pairingRequirement !== undefined
              ? { pairingRequirement: params.pairingRequirement }
              : {}),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { authority: 'owned' },
    );
    return statePath;
  }

  it('rejects pending state without the mandatory v3 requirement before polling', async () => {
    const keypair = tweetnacl.box.keyPair();
    await prepareState({
      keypair,
      pairingSecret: new Uint8Array(32).fill(11),
      createdAtMs: Date.now() - 60_000,
      expiresAtMs: Date.now() + 3_600_000,
      omitPairingRequirement: true,
    });
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue(
      new Error('network boundary must not be reached for unbound pending state'),
    );
    try {
      await expect(
        handleAuthWait(['--public-key', Buffer.from(keypair.publicKey).toString('base64'), '--json']),
      ).rejects.toMatchObject({ code: 'AUTH_WAIT_INVALID_STATE' });
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  }, 20_000);

  it('rejects a non-v3 pending requirement before polling', async () => {
    const keypair = tweetnacl.box.keyPair();
    await prepareState({
      keypair,
      pairingSecret: new Uint8Array(32).fill(11),
      createdAtMs: Date.now() - 60_000,
      expiresAtMs: Date.now() + 3_600_000,
      pairingRequirement: 'compatible',
    });
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue(
      new Error('network boundary must not be reached for non-v3 pending state'),
    );
    try {
      await expect(
        handleAuthWait(['--public-key', Buffer.from(keypair.publicKey).toString('base64'), '--json']),
      ).rejects.toMatchObject({ code: 'AUTH_WAIT_INVALID_STATE' });
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  }, 20_000);

  function authServerApp(params: Readonly<{
    responseB64: string;
    serverIdentityId?: string;
    machineRegistrationStatus?: number;
  }>) {
    const app = fastify({ logger: false });
    app.get('/v1/auth/request/status', async () => ({ status: 'authorized', supportsV2: true }));
    app.post('/v1/auth/request/claim', async () => ({
      state: 'authorized',
      token: 'token-from-claim',
      response: params.responseB64,
      serverIdentityId: params.serverIdentityId ?? serverIdentityId,
    }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.post('/v1/machines', async (request, reply) => {
      if (params.machineRegistrationStatus) {
        return reply.code(params.machineRegistrationStatus).send({ error: 'machine_registration_unavailable' });
      }
      const body = request.body as Record<string, unknown>;
      return { machine: { id: body.id, metadata: body.metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } };
    });
    return app;
  }

  it('keeps ordinary credentials when registration retries exhaust the pairing lifetime', async () => {
    const keypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const createdAtMs = Date.now() - 60_000;
    const expiresAtMs = Date.now() + 3_600_000;
    const statePath = await prepareState({ keypair, pairingSecret, createdAtMs, expiresAtMs });
    const sealed = sealTerminalProvisioningV3TokenOnlyPayload({
      terminalEphemeralPublicKey: keypair.publicKey,
      pairingSecret,
      createdAtMs,
      expiresAtMs,
      randomBytes: deterministicRandomBytes,
    });
    const app = authServerApp({
      responseB64: Buffer.from(sealed).toString('base64'),
      machineRegistrationStatus: 503,
    });
    let now = Date.now();
    let registrationAttempts = 0;
    app.addHook('onRequest', async request => {
      if (request.method === 'POST' && request.url === '/v1/machines') {
        registrationAttempts++;
        // Let one real registration retry run, then expire the same request
        // lifetime while its second HTTP failure is in flight.
        if (registrationAttempts === 2) now = expiresAtMs;
      }
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });
    const controller = new AbortController();
    let completion: Promise<void> | undefined;
    onTestFinished(async () => {
      controller.abort();
      await completion?.catch(() => {});
    });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      featuresSnapshot.next = async () => ({
        status: 'ready',
        features: {
          capabilities: {
            accountStoredContentCompatibility: {
              v: 1,
              minimumProtocolVersion: 2,
              currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
              declarationTransport: 'http-header-and-socket-auth-v1',
            },
          },
        },
      });
      completion = handleAuthWait(['--public-key', Buffer.from(keypair.publicKey).toString('base64'), '--json'], controller.signal);
      await expect(
        completion,
      ).rejects.toMatchObject({
        message: expect.stringMatching(/credentials were saved/i),
        cause: { response: { status: 503 } },
      });
      expect(registrationAttempts).toBe(2);

      await expect(readFile(join(configuration.activeServerDir, 'access.key'), 'utf8'))
        .resolves.toBe(JSON.stringify({ token: 'token-from-claim' }, null, 2));
      await expect(rm(statePath)).rejects.toMatchObject({ code: 'ENOENT' });

      const settings = await readSettings();
      expect(settings.machineId).toBeTruthy();
      expect(settings.machineIdConfirmedByServer).not.toBe(true);
    } finally {
      controller.abort();
      await completion?.catch(() => {});
      clock.mockRestore();
      featuresSnapshot.next = null;
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('rejects a claimed credential from another Home without changing credentials or pending state', async () => {
    const keypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const createdAtMs = Date.now() - 60_000;
    const expiresAtMs = Date.now() + 3_600_000;
    const statePath = await prepareState({ keypair, pairingSecret, createdAtMs, expiresAtMs });
    await writeCredentialsTokenOnly({ token: 'existing-token' });
    const sealed = sealTerminalProvisioningV3TokenOnlyPayload({
      terminalEphemeralPublicKey: keypair.publicKey,
      pairingSecret,
      createdAtMs,
      expiresAtMs,
      randomBytes: deterministicRandomBytes,
    });
    const app = authServerApp({
      responseB64: Buffer.from(sealed).toString('base64'),
      serverIdentityId: 'srv_other_home',
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });
    try {
      await expect(
        handleAuthWait(['--public-key', Buffer.from(keypair.publicKey).toString('base64'), '--json']),
      ).rejects.toMatchObject({ code: 'AUTH_RESPONSE_HOME_MISMATCH' });
      await expect(readFile(statePath, 'utf8')).resolves.toContain(serverIdentityId);

      await expect(readFile(join(configuration.activeServerDir, 'access.key'), 'utf8'))
        .resolves.toBe(JSON.stringify({ token: 'existing-token' }, null, 2));
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('rejects an oversized provisioning response before decoding it', async () => {
    const keypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const createdAtMs = Date.now() - 60_000;
    const expiresAtMs = Date.now() + 3_600_000;
    await prepareState({ keypair, pairingSecret, createdAtMs, expiresAtMs });

    const app = authServerApp({ responseB64: 'A'.repeat(8192) });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });
    try {
      await expect(
        handleAuthWait(['--public-key', Buffer.from(keypair.publicKey).toString('base64'), '--json']),
      ).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' });
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('rejects malformed pairing context instead of silently treating it as legacy state', async () => {
    const keypair = tweetnacl.box.keyPair();
    const statePath = await prepareState({
      keypair,
      pairingSecret: new Uint8Array(31).fill(11),
      createdAtMs: Date.now() - 60_000,
      expiresAtMs: Date.now() + 3_600_000,
    });
    const getSpy = vi.spyOn(axios, 'get').mockRejectedValue(
      new Error('network boundary must not be reached for invalid pending state'),
    );

    try {
      await expect(
        handleAuthWait(['--public-key', Buffer.from(keypair.publicKey).toString('base64'), '--json']),
      ).rejects.toMatchObject({ code: 'AUTH_WAIT_INVALID_STATE' });
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  }, 20_000);

  it('keeps enrollment secrets out of DEBUG diagnostics when the claim request fails', async () => {
    const keypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const createdAtMs = Date.now() - 60_000;
    const expiresAtMs = Date.now() + 3_600_000;
    const claimSecret = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url');
    const machineKeySentinel = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
    const ciphertextSentinel = 'sealed-provisioning-response-ciphertext-sentinel';
    const tokenSentinel = 'token-echoed-by-error-response-sentinel';
    const authorizationSentinel = 'Bearer cli-debug-authorization-sentinel';
    const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64');
    await prepareState({ keypair, pairingSecret, createdAtMs, expiresAtMs, claimSecret });

    const app = fastify({ logger: false });
    app.get('/v1/auth/request/status', async () => ({ status: 'authorized', supportsV2: true }));
    app.post('/v1/auth/request/claim', async (_request, reply) => {
      await reply.code(500).send({
        error: 'server_error',
        token: tokenSentinel,
        response: ciphertextSentinel,
        machineKey: machineKeySentinel,
      });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const output = captureStdoutJsonOutput();

    const previousAuthorization = axios.defaults.headers.common.Authorization;
    axios.defaults.headers.common.Authorization = authorizationSentinel;

    try {
      envScope.patch({ DEBUG: '1' });
      await expect(
        handleAuthCliCommand({
          args: ['auth', 'wait', '--public-key', publicKeyB64, '--json'],
          rawArgv: ['happier', 'auth', 'wait', '--public-key', publicKeyB64, '--json'],
          terminalRuntime: null,
        }),
      ).rejects.toThrow('process.exit:1');

      const printed = JSON.stringify({ stdout: output.chunks, stderr: errorSpy.mock.calls });

      // Request/response enrollment material must never reach diagnostics.
      for (const sentinel of [claimSecret, tokenSentinel, ciphertextSentinel, machineKeySentinel, authorizationSentinel]) {
        expect(printed).not.toContain(sentinel);
      }
      // Local pending-state material must not reach diagnostics either.
      expect(printed).not.toContain(Buffer.from(keypair.secretKey).toString('base64'));
      expect(printed).not.toContain(Buffer.from(pairingSecret).toString('base64url'));

      expect(output.json()).toEqual({ v: 1, ok: false, kind: 'auth_wait', error: {
        code: 'AUTH_WAIT_HOME_UNAVAILABLE', category: 'http_error', status: 500,
      } });
    } finally {
      output.restore();
      axios.defaults.headers.common.Authorization = previousAuthorization;
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
