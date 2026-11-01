import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TERMINAL_PAIRING_REQUIRE'] as const;
const envScope = createEnvKeyScope(envKeys);
const tokenForAccount = (account: string) => `header.${Buffer.from(JSON.stringify({ sub: account })).toString('base64url')}.sig`;

afterEach(() => {
  envScope.restore();
  vi.resetModules();
});

describe('token-only terminal pairing', () => {
  it('rejects malformed token-only credentials without erasing incumbent encryption keys', async () => {
    await withTempDir('happier-invalid-token-only-', async (home) => {
      envScope.patch({ HAPPIER_HOME_DIR: home });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const incumbent = {
        token: tokenForAccount('existing-account'),
        secret: new Uint8Array(32).fill(14),
      };
      await persistence.writeCredentialsLegacy(incumbent);
      await expect(persistence.writeCredentialsTokenOnly({ token: 'malformed-token' }))
        .rejects.toMatchObject({ code: 'AUTH_CREDENTIAL_INVALID' });
      expect(await persistence.readCredentials()).toEqual({
        token: incumbent.token,
        encryption: { type: 'legacy', secret: incumbent.secret },
      });
    });
  });

  it.each(['none', 'sameAccount', 'otherAccount'] as const)('claims authenticated token-only pairing with existing keys: %s', async (existingKeys) => {
    await withTempDir('happier-auth-token-only-', async (home) => {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
        HAPPIER_TERMINAL_PAIRING_REQUIRE: 'v3',
      });
      vi.resetModules();
      const app = fastify({ logger: false });
      app.post('/v1/auth/request', async (req) => {
        expect(req.body).toMatchObject({ supportsV2: true, supportsTokenOnly: true });
        return { state: 'requested' };
      });
      app.get('/v1/auth/request/status', async () => ({ status: 'authorized' }));
      let response = '';
      const token = tokenForAccount('account-token-only');
      app.post('/v1/auth/request/claim', async () => ({ state: 'authorized', token, response }));
      await app.ready();
      const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
      try {
        const { handleAuthRequest } = await import('./auth/request');
        const requestOut = captureConsoleLogAndMuteStdout();
        let request: {
          publicKey: string;
          stateFile: string;
          pairing: { secretB64Url: string; createdAtMs: number; expiresAtMs: number };
        };
        try {
          await handleAuthRequest(['--json']);
          request = JSON.parse(requestOut.logs[0] ?? '');
        } finally {
          requestOut.restore();
        }
        response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
          terminalEphemeralPublicKey: Buffer.from(request.publicKey, 'base64'),
          pairingSecret: Buffer.from(request.pairing.secretB64Url, 'base64url'),
          createdAtMs: request.pairing.createdAtMs,
          expiresAtMs: request.pairing.expiresAtMs,
          randomBytes: (length) => new Uint8Array(length).fill(length),
        })).toString('base64');
        const persistence = await import('@/persistence');
        const secret = new Uint8Array(32).fill(8);
        if (existingKeys !== 'none') await persistence.writeCredentialsLegacy({
          secret,
          token: existingKeys === 'sameAccount' ? token : tokenForAccount('other-account'),
        });

        const { handleAuthWait } = await import('./auth/wait');
        const waitOut = captureConsoleLogAndMuteStdout();
        try {
          await handleAuthWait(['--json', '--replace-existing', '--public-key', request.publicKey]);
          expect(JSON.parse(waitOut.logs[0] ?? '')).toMatchObject({
            success: true,
            encryptionType: existingKeys === 'sameAccount' ? 'legacy' : 'tokenOnly',
            pairingAuthentication: 'v3',
            machineId: expect.any(String),
          });
        } finally {
          waitOut.restore();
        }
        expect(await persistence.readCredentials()).toEqual({
          token,
          encryption: existingKeys === 'sameAccount' ? { type: 'legacy', secret } : null,
        });
        await expect(readFile(request.stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        restoreAxios();
        await app.close();
      }
    });
  });

  it('refuses public-key-only approval when the terminal cannot receive token-only credentials', async () => {
    await withTempDir('happier-approve-token-only-', async (home) => {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: tokenForAccount('account-token-only') });
      const app = fastify({ logger: false });
      const responses: unknown[] = [];
      app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
      app.get('/v1/auth/request/status', async () => ({ status: 'pending', supportsV2: true, supportsTokenOnly: false }));
      app.post('/v1/auth/response', async (request) => { responses.push(request.body); return { success: true }; });
      await app.ready();
      const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
      const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
      try {
        const { approveTerminalAuthRequest } = await import('@/auth/terminalAuthApproval');
        await expect(approveTerminalAuthRequest({
          publicKey: Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64'),
        })).rejects.toMatchObject({ code: 'terminal_credential_variant_unsupported' });
        expect(responses).toEqual([]);
      } finally {
        restoreAxios();
        await app.close();
      }
    });
  });
});
