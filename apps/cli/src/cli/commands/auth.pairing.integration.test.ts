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

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';
import { handleAuthRequest } from './auth/request';
import { writeCredentialsDataKey, readCredentials, readStoredCredentials, writeCredentialsTokenOnly, readSettings } from '@/persistence';
import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { handleAuthWait } from './auth/wait';

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
    reloadConfiguration();
    vi.unstubAllGlobals();
    await removeTempDir(remoteHomeDir);
    await removeTempDir(localHomeDir);
  });

  it.each([240_000, 7_200_000, null])('reports the server deadline %s capped by crypto validity and binds links and saved state to it', async (remainingMs) => {
    const serverExpiresAt = remainingMs === null ? null : Date.now() + remainingMs;
    const app = fastify({ logger: false });
    // The absent field is the released server response, before #403.
    app.post('/v1/auth/request', async () => ({ state: 'requested', ...(serverExpiresAt === null ? {} : { expiresAt: serverExpiresAt }) }));
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: remoteHomeDir,
        HAPPIER_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      reloadConfiguration();
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthRequest(['--json']);
        const request = JSON.parse(output.logs[0] ?? '') as {
          expiresAtMs: number | null;
          expiryNotice: string;
          pairing: { createdAtMs: number; expiresAtMs: number };
          links: { webUrl: string; mobileUrl: string };
          stateFile: string;
        };
        const cryptoExpiresAt = request.pairing.createdAtMs + 3_600_000;
        const expectedDeadline = serverExpiresAt === null ? null : Math.min(serverExpiresAt, cryptoExpiresAt);
        expect(request.expiresAtMs).toBe(expectedDeadline);
        if (expectedDeadline === null) {
          expect(request.expiryNotice).toMatch(/expires soon/i);
          expect(request.expiryNotice).not.toMatch(/hour|minute|\d/);
        } else {
          expect(request.expiryNotice).toContain(new Date(expectedDeadline).toISOString());
        }
        const pairingDeadline = expectedDeadline ?? cryptoExpiresAt;
        expect(request.pairing.expiresAtMs).toBe(pairingDeadline);
        for (const link of [request.links.webUrl, request.links.mobileUrl]) expect(link).toContain(`expiresAt=${pairingDeadline}`);
        const state = JSON.parse(await readFile(request.stateFile, 'utf8')) as { pairingExpiresAtMs: number };
        expect(state.pairingExpiresAtMs).toBe(pairingDeadline);
      } finally {
        output.restore();
      }
    } finally {
      restoreAxios();
      await app.close();
    }
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
      reloadConfiguration();
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toContain('/v1/features');
        events.push('features');
        return createFeaturesResponse();
      }));

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
      reloadConfiguration();
      vi.stubGlobal('fetch', vi.fn(async () => createFeaturesResponse()));

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
      reloadConfiguration();
      const remoteWarns: string[] = [];
      const remoteWarnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        remoteWarns.push(args.map((arg) => String(arg)).join(' '));
      });
      const remoteOutput = captureStdoutJsonOutput();

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
      reloadConfiguration();
      const machineKey = new Uint8Array(32).fill(7);
      await writeCredentialsDataKey({
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        machineKey,
        token: 'local-token',
      });

      // 2) Local: approve using existing local credentials (token never leaves local machine).
      // The approval carries the remote request's v3 pairing context exactly as
      // `auth pair-remote` does, so the response is bound to the pairing secret.
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
      reloadConfiguration();
      const waitOut = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthWait(['--public-key', requestJson.publicKey, '--json']);
        expect(waitOut.logs.length).toBe(1);
        const parsed = JSON.parse(waitOut.logs[0] ?? '');
        expect(parsed.success).toBe(true);
        expect(parsed).not.toHaveProperty('token');
        expect(waitOut.logs.join('\n')).not.toContain('issued-token');
        expect(parsed.encryptionType).toBe('dataKey');
        expect(parsed.pairingAuthentication).toBe('v3');
      } finally {
        waitOut.restore();
      }

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
      reloadConfiguration();

      const requestOut = captureConsoleLogAndMuteStdout();
      let requestJson: {
        publicKey: string;
        stateFile: string;
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
      const pendingState = JSON.parse(await readFile(requestJson.stateFile, 'utf8')) as { secretKey: string };

      const waitOut = captureConsoleLogAndMuteStdout();
      try {
        await handleAuthWait(['--public-key', requestJson.publicKey, '--json']);
        const envelope = JSON.parse(waitOut.logs[0] ?? '');
        expect(envelope).toMatchObject({
          success: true,
          encryptionType: 'tokenOnly',
          pairingAuthentication: 'v3',
        });
        expect(envelope).not.toHaveProperty('token');
        // Token-only provisioning must not synthesize or echo secret material.
        for (const secret of ['plain-issued-token', pendingState.secretKey, requestJson.pairing.secretB64Url, response]) {
          expect(waitOut.logs.join('\n')).not.toContain(secret);
        }
      } finally {
        waitOut.restore();
      }
      await expect(readFile(requestJson.stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

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

      reloadConfiguration();
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
        expect(parsed).not.toHaveProperty('token');
        expect(waitOut.logs.join('\n')).not.toContain('fresh-approved-token');
        expect(typeof parsed.machineId).toBe('string');
        expect(parsed.machineId?.length).toBeGreaterThan(0);
      } finally {
        waitOut.restore();
      }

      const settings = await readSettings();
      expect(settings.machineId).toMatch(/^[-a-z0-9]+$/i);
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
