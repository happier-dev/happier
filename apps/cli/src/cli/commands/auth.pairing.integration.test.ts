import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  sealTerminalProvisioningV3Payload,
  sealTerminalProvisioningV3TokenOnlyPayload,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

type RequestRow = {
  claimSecretHash: string;
  response: string | null;
  responseAccountId: string | null;
};

const SERVER_IDENTITY_ID = 'srv_terminal_pairing_home';

function createFeaturesResponse(serverIdentityId = SERVER_IDENTITY_ID): Response {
  return new Response(JSON.stringify({
    features: {},
    capabilities: {
      serverIdentity: { serverIdentityId },
      accountStoredContentCompatibility: {
        v: 1,
        minimumProtocolVersion: 2,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
      },
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sha256Base64Url(input: Buffer): string {
  return createHash('sha256').update(input).digest('base64url');
}

function registerMachineSetupRoutes(app: FastifyInstance, mode: 'plain' | 'e2ee'): void {
  app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
  app.post('/v1/machines', async (request) => {
    const body = request.body as Record<string, unknown>;
    return {
      machine: {
        id: body.id,
        metadata: body.metadata,
        metadataVersion: 1,
        daemonState: body.daemonState ?? null,
        daemonStateVersion: body.daemonState ? 1 : 0,
        dataEncryptionKey: body.dataEncryptionKey,
      },
    };
  });
}

describe('auth pairing commands (request/approve/wait) (json)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'HAPPIER_LOG_LEVEL',
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
    // These in-process homes are removed while logger instances survive module
    // resets. Keep console diagnostics, but avoid queued file writes recreating
    // the homes during teardown; file logging has its own owner-level tests.
    envScope.patch({ HAPPIER_LOG_LEVEL: 'silent' });
    remoteHomeDir = await createTempDir('happier-cli-auth-remote-');
    localHomeDir = await createTempDir('happier-cli-auth-local-');
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    vi.stubGlobal('fetch', vi.fn(async () => createFeaturesResponse()));
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

  it('persists the mandatory v3 requirement with split request/wait state', async () => {
    const events: string[] = [];
    const app = fastify({ logger: false });
    app.post('/v1/auth/request', async (_req, reply) => {
      events.push('request');
      return reply.send({ state: 'requested' });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toContain('/v1/features');
        events.push('features');
        return createFeaturesResponse();
      }));

      const { handleAuthRequest } = await import('./auth/request');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthRequest(['--json']);
        const request = JSON.parse(output.logs[0] ?? '') as {
          pairingRequirement?: string;
          stateFile?: string;
          supportsTokenOnly?: boolean;
          serverIdentityId?: string;
          links?: {
            webUrl?: string;
            mobileUrl?: string;
          };
        };
        expect(request.pairingRequirement).toBe('v3');
        expect(request.supportsTokenOnly).toBe(true);
        expect(request.serverIdentityId).toBe(SERVER_IDENTITY_ID);
        expect(events).toEqual(['features', 'request']);
        expect(request.links?.webUrl).toContain('supportsTokenOnly=1');
        expect(request.links?.mobileUrl).toContain('supportsTokenOnly=1');
        const state = JSON.parse(await readFile(String(request.stateFile), 'utf8')) as {
          pairingRequirement?: string;
          supportsTokenOnly?: boolean;
          serverIdentityId?: string;
        };
        expect(state.pairingRequirement).toBe('v3');
        expect(state.supportsTokenOnly).toBe(true);
        expect(state.serverIdentityId).toBe(SERVER_IDENTITY_ID);
        expect(request.links?.webUrl).toContain(`serverIdentityId=${SERVER_IDENTITY_ID}`);
        expect(request.links?.mobileUrl).toContain(`serverIdentityId=${SERVER_IDENTITY_ID}`);
      } finally {
        output.restore();
      }
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  });

  it('emits only the short-lived v3 pairing context for authenticated SSH transport', async () => {
    const app = fastify({ logger: false });
    app.post('/v1/auth/request', async (_req, reply) => reply.send({ state: 'requested' }));
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      vi.stubGlobal('fetch', vi.fn(async () => createFeaturesResponse()));

      const { handleAuthRequest } = await import('./auth/request');
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthRequest(['--json', '--remote-pairing-context']);
        const request = JSON.parse(output.logs[0] ?? '') as Record<string, unknown>;
        expect(request).toMatchObject({
          serverIdentityId: SERVER_IDENTITY_ID,
          supportsTokenOnly: true,
          pairingRequirement: 'v3',
        });
        expect(request).toHaveProperty('publicKey');
        expect(request).toHaveProperty('pairing');
        expect(request).not.toHaveProperty('claimSecret');
        expect(request).not.toHaveProperty('stateFile');
        expect(request).not.toHaveProperty('links');
        expect(request).not.toHaveProperty('publicKeyB64Url');
      } finally {
        output.restore();
      }
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  });

  it('pairs a remote machine by creating a claim-gated request, approving it with an authenticated local CLI, then waiting and writing dataKey credentials on the remote', async () => {
    const requests = new Map<string, RequestRow>();
    const app = fastify({ logger: false });
    registerMachineSetupRoutes(app, 'e2ee');

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
      return reply.send({
        state: 'authorized',
        token: 'issued-token',
        response: row.response,
        serverIdentityId: SERVER_IDENTITY_ID,
      });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });

    try {
      // 1) Remote: create pairing request (json output should be clean even in dev variant)
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_METHOD: 'web',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_VARIANT: 'dev',
      });
      vi.resetModules();
      const remoteWarns: string[] = [];
      const remoteWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        remoteWarns.push(args.map((arg) => String(arg)).join(' '));
      });
      const remoteOutput = captureStdoutJsonOutput();

      const { handleAuthRequest } = await import('./auth/request');
      let requestJson: any;
      try {
        await handleAuthRequest(['--json']);
        expect(remoteWarns).toEqual([]);
        requestJson = remoteOutput.json();
      } finally {
        remoteWarnSpy.mockRestore();
        remoteOutput.restore();
      }
      expect(typeof requestJson.publicKey).toBe('string');
      expect(requestJson).not.toHaveProperty('claimSecret');

      // 2) Local: approve using existing local credentials (token never leaves local machine)
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
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

      // 2) Local: approve using existing local credentials (token never leaves local machine).
      // The approval carries the remote request's v3 pairing context exactly as
      // `auth pair-remote` does, so the response is bound to the pairing secret.
      vi.resetModules();
      const { approveTerminalAuthRequest } = await import('@/auth/terminalAuthApproval');
      await approveTerminalAuthRequest({
        publicKey: requestJson.publicKey,
        pairing: requestJson.pairing,
        supportsTokenOnly: requestJson.supportsTokenOnly === true,
      });

      // 3) Remote: wait + claim, then write credentials (dataKey)
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
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
        expect(parsed.pairingAuthentication).toBe('v3');
      } finally {
        waitOut.restore();
      }

      const { readCredentials } = await import('@/persistence');
      const creds = await readCredentials();
      expect(creds?.token).toBe('issued-token');
      expect(creds?.encryption.type).toBe('dataKey');
      expect(Array.from(creds?.encryption.type === 'dataKey' ? creds.encryption.machineKey : [])).toEqual(
        Array.from(machineKey),
      );
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('writes exact token-only credentials from an authenticated token-only pairing response', async () => {
    const app = fastify({ logger: false });
    let response = '';
    registerMachineSetupRoutes(app, 'plain');

    app.post('/v1/auth/request', async (_req, reply) => reply.send({ state: 'requested' }));
    app.get('/v1/auth/request/status', async (_req, reply) => {
      return reply.send({ status: response ? 'authorized' : 'pending', supportsV2: true });
    });
    app.post('/v1/auth/request/claim', async (_req, reply) => {
      return reply.send({
        state: 'authorized',
        token: 'plain-issued-token',
        response,
        serverIdentityId: SERVER_IDENTITY_ID,
      });
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_METHOD: 'web',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();

      const { handleAuthRequest } = await import('./auth/request');
      const requestOut = captureConsoleLogAndMuteStdout();
      let requestJson: {
        publicKey: string;
        pairing: {
          secretB64Url: string;
          createdAtMs: number;
          expiresAtMs: number;
        };
      };
      try {
        await handleAuthRequest(['--json']);
        requestJson = JSON.parse(requestOut.logs[0] ?? '') as typeof requestJson;
      } finally {
        requestOut.restore();
      }

      const terminalPublicKey = new Uint8Array(Buffer.from(requestJson.publicKey, 'base64'));
      response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
        terminalEphemeralPublicKey: terminalPublicKey,
        pairingSecret: new Uint8Array(Buffer.from(requestJson.pairing.secretB64Url, 'base64url')),
        createdAtMs: requestJson.pairing.createdAtMs,
        expiresAtMs: requestJson.pairing.expiresAtMs,
        randomBytes: (length) => new Uint8Array(length).fill(17),
      })).toString('base64');

      vi.resetModules();
      const { handleAuthWait } = await import('./auth/wait');
      const waitOut = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthWait(['--public-key', requestJson.publicKey, '--json']);
        expect(JSON.parse(waitOut.logs[0] ?? '')).toMatchObject({
          success: true,
          token: 'plain-issued-token',
          encryptionType: 'tokenOnly',
          pairingAuthentication: 'v3',
        });
      } finally {
        waitOut.restore();
      }

      const { readStoredCredentials, readCredentials } = await import('@/persistence');
      await expect(readStoredCredentials()).resolves.toEqual({
        token: 'plain-issued-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      });
      await expect(readCredentials()).resolves.toBeNull();
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('claims its pending request and replaces a stale stored token', async () => {
    const requests = new Map<string, RequestRow>();
    const app = fastify({ logger: false });
    let response = '';

    app.post('/v1/auth/request', async (req, reply) => {
      const body = req.body as { publicKey?: unknown; claimSecretHash?: unknown } | undefined;
      const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : '';
      const claimSecretHash = typeof body?.claimSecretHash === 'string' ? body.claimSecretHash : '';
      if (!publicKey || !claimSecretHash) return reply.code(400).send({ error: 'claim_required' });
      requests.set(publicKey, { claimSecretHash, response: null, responseAccountId: null });
      return reply.send({ state: 'requested' });
    });
    app.get('/v1/auth/request/status', async () => ({ status: 'authorized', supportsV2: true }));
    app.post('/v1/auth/request/claim', async () => ({
      state: 'authorized',
      token: 'fresh-approved-token',
      response,
      serverIdentityId: SERVER_IDENTITY_ID,
    }));
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
    app.post('/v1/machines', async (request) => {
      const body = request.body as Record<string, unknown>;
      return {
        machine: {
          id: body.id,
          metadata: body.metadata,
          metadataVersion: 1,
          daemonState: null,
          daemonStateVersion: 0,
        },
      };
    });

    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_NO_BROWSER_OPEN: '1',
        HAPPIER_AUTH_METHOD: 'web',
        HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
        HAPPIER_VARIANT: 'stable',
      });

      vi.resetModules();
      const { handleAuthRequest } = await import('./auth/request');
      const requestOut = captureConsoleLogAndMuteStdout();
      let requestJson: {
        publicKey: string;
        pairing: { secretB64Url: string; createdAtMs: number; expiresAtMs: number };
      };
      try {
        await handleAuthRequest(['--json']);
        requestJson = JSON.parse(requestOut.logs[0] ?? '') as typeof requestJson;
      } finally {
        requestOut.restore();
      }

      vi.resetModules();
      const { writeCredentialsTokenOnly, readSettings } = await import('@/persistence');
      const tokenPayload = Buffer.from(JSON.stringify({ sub: 'acct_local' })).toString('base64url');
      await writeCredentialsTokenOnly({ token: `header.${tokenPayload}.sig` });

      const freshMachineKey = new Uint8Array(32).fill(23);
      response = Buffer.from(sealTerminalProvisioningV3Payload({
        terminalEphemeralPublicKey: new Uint8Array(Buffer.from(requestJson.publicKey, 'base64')),
        contentPrivateKey: freshMachineKey,
        pairingSecret: new Uint8Array(Buffer.from(requestJson.pairing.secretB64Url, 'base64url')),
        createdAtMs: requestJson.pairing.createdAtMs,
        expiresAtMs: requestJson.pairing.expiresAtMs,
        randomBytes: (length) => new Uint8Array(length).fill(19),
      })).toString('base64');

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
        expect(parsed.encryptionType).toBe('dataKey');
        expect((parsed as { token?: string }).token).toBe('fresh-approved-token');
        expect(typeof parsed.machineId).toBe('string');
        expect(parsed.machineId?.length).toBeGreaterThan(0);
      } finally {
        waitOut.restore();
      }

      const settings = await readSettings();
      expect(settings.machineId).toMatch(/^[-a-z0-9]+$/i);
      const { readStoredCredentials } = await import('@/persistence');
      await expect(readStoredCredentials()).resolves.toEqual({
        token: 'fresh-approved-token',
        encryption: {
          type: 'dataKey',
          publicKey: tweetnacl.box.keyPair.fromSecretKey(freshMachineKey).publicKey,
          machineKey: freshMachineKey,
        },
        credentialProvenance: 'stored_session',
      });
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

});
