import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, computeAccountEncryptionMigrateKeyFingerprintV1, deriveAccountMachineKeyFromRecoverySecret, formatAccountApiTokenCredentialV1, openApiTokenEncryptionAccessV1, parseAccountApiTokenCredentialV1 } from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { writeCredentialsTokenOnly, writeCredentialsDataKey, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { handleAuthCommand } from './auth';
// The public auth dispatcher loads this leaf dynamically. Preload it here so
// the first command test exercises behavior rather than compiler startup.
import './auth/apiTokens';
import { addServerProfile } from '@/server/serverProfiles';
import { resolveServerSelectionFromArgs } from '@/server/serverSelection';
import * as persistence from '@/persistence';

function storedPlainLabel(value: string) {
  return { content: { t: 'plain' as const, v: value }, recipients: [] };
}

function readPlainLabel(value: string) {
  return { content: { t: 'plain' as const, v: value }, recipientEnvelope: null };
}

const TOKEN_SCOPE_FIELDS = {
  grant: API_TOKEN_FULL_GRANT_V1,
  parentTokenId: null,
  activeChildCount: 0,
  embedConfig: null,
};

describe('trusted auth api-tokens commands', () => {
  const env = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_TOKEN',
    'HAPPIER_ACCOUNT_SETTINGS_MODE',
  ]);
  let home = '';
  beforeEach(async () => {
    home = await createTempDir('happier-api-tokens-');
    env.patch({
      HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: 'http://account.test',
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: 'http://account.test',
      HAPPIER_WEBAPP_URL: 'http://account.test',
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_TOKEN: undefined,
      HAPPIER_ACCOUNT_SETTINGS_MODE: 'never',
    });
    reloadConfiguration();
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected process exit'); });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.restore();
    reloadConfiguration();
    process.exitCode = 0;
    await removeTempDir(home);
  });

  it.each([
    { authorizeUnattendedTeamAccess: false, json: false },
    { authorizeUnattendedTeamAccess: false, json: true },
    { authorizeUnattendedTeamAccess: true, json: true },
  ])('creates through the shared Action and shows the new token once; unattended=$authorizeUnattendedTeamAccess json=$json', async ({ authorizeUnattendedTeamAccess, json }) => {
    const release = publishServerHttpRuntimeOrigin('http://runtime.account.test', 'iroh');
    const app = fastify();
    let capturedRequest: Readonly<{ authorization: string | undefined; body: unknown }> | null = null;
    app.post('/v1/auth/api-tokens/create', async (request) => {
      capturedRequest = { authorization: request.headers.authorization, body: request.body };
      const tokenId = (request.body as { tokenId: string }).tokenId;
      const token = `hap_v1_${tokenId}_${'A'.repeat(43)}`;
      const apiToken = {
        ...TOKEN_SCOPE_FIELDS,
        tokenId,
        label: readPlainLabel('build'),
        displayPrefix: `hap_v1_${tokenId.slice(0, 8)}`,
        createdAt: '2026-09-05T00:00:00Z',
        expiresAt: null,
        lastUsedAt: null,
        hasEncryptionAccess: false,
        hasUnattendedTeamAccess: authorizeUnattendedTeamAccess,
      };
      return { token, apiToken };
    });
    app.get('/v1/account/profile', async () => ({ id: 'account-one' }));
    app.get('/v1/account/encryption/currentness', async () => ({
      mode: 'plain',
      version: 1,
      updatedAt: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    }));
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.endsWith('/v1/account/private-labels/recipient-census')) {
        return Response.json({ contentEncryptionMode: 'plain', recipients: [] });
      }
      if (href.endsWith('/v1/features')) {
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_cli_token_home' } } });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://runtime.account.test' });
    const output = captureConsoleText();
    try {
      await writeCredentialsTokenOnly({ token: 'interactive' });
      await handleAuthCommand([
        'api-tokens', 'create', '--label', 'build',
        ...(authorizeUnattendedTeamAccess ? ['--authorize-unattended-team-access'] : []),
        '--yes',
        ...(json ? ['--json'] : []),
      ]);
      expect(capturedRequest).not.toBeNull();
      const result = JSON.parse(output.text());
      if (json) expect(result).toMatchObject({ ok: true });
      const data = json ? result.data : result;
      expect(data).toMatchObject({ apiToken: { hasUnattendedTeamAccess: authorizeUnattendedTeamAccess } });
      expect(data.token).toEqual(expect.stringMatching(/^hap_v1_[0-9a-f-]{36}_/));
      expect(output.text()).not.toContain('interactive');
      expect(capturedRequest).toEqual({
        authorization: 'Bearer interactive',
        body: {
          tokenId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          label: storedPlainLabel('build'),
          ...(authorizeUnattendedTeamAccess ? { authorizeUnattendedTeamAccess: true } : {}),
        },
      });
    } finally {
      output.restore();
      restore();
      release();
      await app.close();
    }
  });

  it('does not invent token recovery when settings admission fails before the create request', async () => {
    env.patch({ HAPPIER_ACCOUNT_SETTINGS_MODE: 'blocking' });
    const app = fastify();
    const key = tweetnacl.box.keyPair();
    const requests: string[] = [];
    app.addHook('onRequest', async (request) => { requests.push(request.url); });
    app.get('/v1/account/profile', async () => ({ id: 'account-one' }));
    app.get('/v1/account/encryption/currentness', async () => ({
      mode: 'e2ee',
      version: 1,
      updatedAt: 1,
      signingKeyFingerprint: 'signing',
      contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(key.publicKey),
      recipientEnvelopeReadiness: { status: 'available' },
    }));
    app.get('/v2/account/settings', async () => ({
      content: { t: 'encrypted', c: 'corrupt-e2ee-settings' }, version: 15,
    }));
    app.post('/v1/auth/api-tokens/create', async () => ({}));
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      if (String(url).endsWith('/v1/account/private-labels/recipient-census')) {
        return Response.json({
          contentEncryptionMode: 'e2ee',
          recipients: [{
            account: { kind: 'account', accountId: 'account-one', firstName: null, lastName: null, username: null, avatarUrl: null },
            readiness: {
              status: 'available',
              contentPublicKey: encodeBase64(key.publicKey),
              contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(key.publicKey),
            },
            envelopeStatus: 'missing',
          }],
        });
      }
      throw new Error(`Unexpected fetch ${String(url)}`);
    });
    const output = captureConsoleText();
    try {
      await writeCredentialsDataKey({ token: 'interactive', machineKey: key.secretKey, publicKey: key.publicKey });
      await handleAuthCommand(['api-tokens', 'create', '--label', 'build', '--yes', '--json']);

      expect(requests).toContain('/v2/account/settings');
      expect(requests).not.toContain('/v1/auth/api-tokens/create');
      const result = JSON.parse(output.text());
      expect(result).toMatchObject({ ok: false, error: { code: 'api_token_operation_failed' } });
      expect(result.error).not.toHaveProperty('tokenId');
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('dispatches with the stored interactive credential and endpoint of the explicitly selected Home', async () => {
    const app = fastify();
    let authorization: string | undefined;
    app.post('/v1/auth/api-tokens/list', async (request) => {
      authorization = request.headers.authorization;
      return { tokens: [] };
    });
    app.get('/v1/account/encryption/currentness', async () => ({
      mode: 'plain',
      version: 1,
      updatedAt: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    }));
    const restore = installAxiosFastifyAdapter({ app, origin: 'https://company.test' });
    const output = captureConsoleText();
    try {
      const company = await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.test',
        webappUrl: 'https://company.test',
        use: false,
      });
      await writeCredentialsTokenOnlyForServerId(company.id, { token: 'company-interactive' });
      const resolvedSelection = await resolveServerSelectionFromArgs([
        'list', '--server', 'company', '--no-persist', '--json',
      ]);
      expect(resolvedSelection.selection).toMatchObject({
        activeServerId: company.id,
        serverUrl: 'https://company.test',
        application: { kind: 'ephemeralEnv' },
      });
      await handleAuthCommand(['api-tokens', 'list', '--server', 'company', '--no-persist', '--json']);

      const envelope = JSON.parse(output.text());
      expect(envelope.ok).toBe(true);
      expect(envelope).toMatchObject({ data: { tokens: [] } });
      expect(authorization).toBe('Bearer company-interactive');
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });

  it('manages the single strict list and both revocation intents without accepting a supplied PAT', async () => {
    const app = fastify();
    const requests: string[] = [];
    let currentnessReads = 0;
    const tokenId = '12345678-1234-4234-8234-123456789abc';
    const baseSummary = {
      ...TOKEN_SCOPE_FIELDS,
      label: readPlainLabel('build'),
      displayPrefix: 'hap_v1_12345678',
      createdAt: '2026-09-05T00:00:00Z',
      expiresAt: null,
      lastUsedAt: null,
      hasEncryptionAccess: false,
    };
    app.post('/v1/auth/api-tokens/list', async (request) => {
      requests.push('list');
      expect(request.body).toEqual({});
      expect(request.query).toEqual({});
      return {
        tokens: [
          { ...baseSummary, tokenId, hasUnattendedTeamAccess: false },
          {
            ...baseSummary,
            tokenId: '22345678-1234-4234-8234-123456789abc',
            displayPrefix: 'hap_v1_22345678',
            hasUnattendedTeamAccess: true,
            grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.transcript.get'] } },
          },
        ],
      };
    });
    app.post('/v1/auth/api-tokens/revoke', async (request) => {
      requests.push('revoke'); expect(request.body).toEqual({ tokenId }); return { revoked: true };
    });
    app.post('/v1/auth/api-tokens/revoke-all', async () => { requests.push('revoke-all'); return { revokedCount: 1 }; });
    app.get('/v1/account/encryption/currentness', async () => {
      currentnessReads += 1;
      return {
        mode: 'plain',
        version: 1,
        updatedAt: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      await writeCredentialsTokenOnly({ token: 'interactive' });
      for (const command of [['list'], ['revoke', tokenId, '--yes'], ['revoke-all', '--yes']]) {
        output.lines.length = 0;
        await handleAuthCommand(['api-tokens', ...command, '--json']);
        const result = JSON.parse(output.text());
        expect(result.ok).toBe(true);
        if (command[0] === 'list') {
          expect(result.data.tokens.map((item: { hasUnattendedTeamAccess: boolean }) => item.hasUnattendedTeamAccess))
            .toEqual([false, true]);
        }
      }
      output.lines.length = 0;
      await handleAuthCommand(['api-tokens', 'list']);
      expect(output.text()).toContain('Access');
      expect(output.text()).toContain('Full access');
      expect(output.text()).toContain('Limited');
      env.patch({ HAPPIER_TOKEN: `hap_v1_${tokenId}_${'A'.repeat(43)}` });
      for (const command of [['create', '--label', 'denied'], ['list'], ['revoke', tokenId], ['revoke-all']]) {
        output.lines.length = 0;
        await handleAuthCommand(['api-tokens', ...command, '--json']);
        expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'present_user_required' } });
      }
      env.patch({ HAPPIER_TOKEN: formatAccountApiTokenCredentialV1({
        bearer: `hap_v1_${tokenId}_${'A'.repeat(43)}`,
        wrappingSecret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        serverIdentityId: 'srv_cli_management_denied',
        accountId: 'account-1',
        contentPublicKey: encodeBase64(new Uint8Array(32).fill(9)),
      }) });
      output.lines.length = 0;
      await handleAuthCommand(['api-tokens', 'list', '--json']);
      expect(JSON.parse(output.text())).toMatchObject({ ok: false, error: { code: 'present_user_required' } });
      expect(requests).toEqual(['list', 'revoke', 'revoke-all', 'list']);
      expect(currentnessReads).toBe(2);
    } finally { output.restore(); restore(); await app.close(); }
  });

  it.each(['legacy', 'dataKey', 'plain', 'censusModeMismatch', 'stale', 'wrongPair', 'conflict', 'evidenceLimit', 'evidenceUnavailable', 'mismatch', 'malformed', 'noEffect503', 'lostAfterCommit', 'cancelled'] as const)('enforces content-key issuance and recovery with %s credentials', async (kind) => {
    const app = fastify();
    const secret = new Uint8Array(32).fill(7);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    let captured: { tokenId: string; encryptionAccess: unknown } | undefined;
    const controller = new AbortController();
    let createCount = 0;
    let listCount = 0;
    app.post('/v1/auth/api-tokens/list', async () => { listCount++; return { tokens: [] }; });
    app.get('/v1/account/profile', async () => ({ id: 'account-one' }));
    app.get('/v1/account/encryption/currentness', async () => ({
      mode: kind === 'plain' ? 'plain' : 'e2ee',
      version: 1,
      updatedAt: 1,
      signingKeyFingerprint: kind === 'plain' ? null : 'signing',
      contentKeyFingerprint: kind === 'plain'
        ? null
        : kind === 'stale'
          ? 'other-key'
          : computeAccountEncryptionMigrateKeyFingerprintV1(publicKey),
      recipientEnvelopeReadiness: kind === 'plain'
        ? { status: 'unavailable', reason: 'plain_account' }
        : { status: 'available' },
    }));
    app.post('/v1/auth/api-tokens/create', async (request, reply) => {
      createCount++;
      const body = request.body as {
        tokenId: string;
        label: ReturnType<typeof storedPlainLabel> | {
          content: { t: 'encrypted'; c: string };
          recipients: Array<{ accountId: string; envelope: { encryptedDataKey: string; recipientContentPublicKeyFingerprint: string } }>;
        };
        encryption?: { access: unknown };
      };
      captured = body.encryption ? { tokenId: body.tokenId, encryptionAccess: body.encryption.access } : undefined;
      if (kind === 'conflict') return reply.code(409).send({ error: 'api_token_id_conflict' });
      if (kind === 'evidenceLimit') {
        return reply.code(400).send({
          error: 'credential_authentication_evidence_limit',
        });
      }
      if (kind === 'evidenceUnavailable') {
        return reply.code(409).send({ error: 'credential_authentication_evidence_unavailable' });
      }
      if (kind === 'noEffect503') return reply.code(503).send({ error: 'unavailable', secret: 'DO_NOT_DISCLOSE' });
      if (kind === 'lostAfterCommit') {
        reply.hijack();
        request.raw.socket.destroy();
        return reply;
      }
      if (kind === 'malformed') return { accepted: true };
      const tokenId = kind === 'mismatch' ? '12345678-1234-4234-8234-123456789abc' : captured!.tokenId;
      return {
        token: `hap_v1_${tokenId}_${'A'.repeat(43)}`,
        apiToken: {
          ...TOKEN_SCOPE_FIELDS,
          tokenId,
          label: {
            content: body.label.content,
            recipientEnvelope: body.label.content.t === 'plain' ? null : body.label.recipients[0]!.envelope,
          },
          displayPrefix: `hap_v1_${tokenId.slice(0, 8)}`,
          createdAt: '2026-09-05T00:00:00Z',
          expiresAt: null,
          lastUsedAt: null,
          hasEncryptionAccess: true,
          hasUnattendedTeamAccess: false,
        },
      };
    });
    // Features fetch is a network boundary; retain its actual response parser
    // without intercepting unrelated runtime fetches such as Yoga's WASM load.
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof nativeFetch>) => {
      const [input] = args;
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/features')) {
        return new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_cli_token_home' } } }), { status: 200 });
      }
      if (url.endsWith('/v1/account/private-labels/recipient-census')) {
        return Response.json({
          contentEncryptionMode: kind === 'plain' || kind === 'censusModeMismatch' ? 'plain' : 'e2ee',
          recipients: kind === 'plain' || kind === 'censusModeMismatch' ? [] : [{
            account: { kind: 'account', accountId: 'account-one', firstName: null, lastName: null, username: null, avatarUrl: null },
            readiness: {
              status: 'available',
              contentPublicKey: encodeBase64(publicKey),
              contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey),
            },
            envelopeStatus: 'missing',
          }],
        });
      }
      return await nativeFetch(...args);
    });
    let restore = () => {};
    if (kind === 'lostAfterCommit') {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an HTTP API-token test address.');
      const origin = `http://127.0.0.1:${address.port}`;
      env.patch({
        HAPPIER_SERVER_URL: origin,
        HAPPIER_PUBLIC_SERVER_URL: origin,
        HAPPIER_WEBAPP_URL: origin,
      });
      reloadConfiguration();
    } else {
      restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    }
    const output = captureConsoleText();
    try {
      if (kind === 'legacy') await persistence.writeCredentialsLegacy({ token: 'interactive', secret });
      else await persistence.writeCredentialsDataKey({ token: 'interactive', machineKey, publicKey: kind === 'wrongPair' ? new Uint8Array(32).fill(9) : publicKey });
      if (kind === 'cancelled') controller.abort();
      await handleAuthCommand(['api-tokens', 'create', '--label', 'build', '--encryption', '--yes', '--json'], controller.signal);
      const result = JSON.parse(output.text());
      if (kind === 'censusModeMismatch') {
        expect(result).toMatchObject({ ok: false, error: { code: 'private_label_unavailable' } });
        expect(createCount).toBe(0);
        expect(output.text()).not.toContain('build');
        return;
      }
      if (kind === 'plain' || kind === 'stale' || kind === 'wrongPair') {
        expect(result).toMatchObject({ ok: false, error: { code: kind === 'plain' ? 'api_token_encryption_not_ready' : 'api_token_encryption_stale' } });
        expect(createCount).toBe(0); return;
      }
      if (kind === 'conflict' || kind === 'evidenceLimit' || kind === 'evidenceUnavailable' || kind === 'mismatch' || kind === 'malformed' || kind === 'noEffect503' || kind === 'lostAfterCommit' || kind === 'cancelled') {
        const expectedCode = kind === 'conflict'
          ? 'api_token_id_conflict'
          : kind === 'evidenceLimit'
            ? 'credential_authentication_evidence_limit'
            : kind === 'evidenceUnavailable'
              ? 'credential_authentication_evidence_unavailable'
            : kind === 'mismatch'
              ? 'api_token_creation_outcome_unknown'
              : kind === 'cancelled'
                ? 'cancelled'
                : kind === 'lostAfterCommit' || kind === 'malformed'
                  ? 'api_token_creation_outcome_unknown'
                  : 'api_token_operation_failed';
        if (kind === 'mismatch' || kind === 'lostAfterCommit' || kind === 'malformed') {
          expect(result).toMatchObject({ ok: false, error: { code: expectedCode, tokenId: captured!.tokenId } });
        } else {
          expect(result).toMatchObject({ ok: false, error: { code: expectedCode } });
          expect(result.error).not.toHaveProperty('tokenId');
        }
        expect(createCount).toBe(kind === 'cancelled' ? 0 : 1); expect(listCount).toBe(0);
        expect(output.text()).not.toMatch(/hapc_v1|hap_v1|DO_NOT_DISCLOSE/);
        return;
      }
      expect(result.ok).toBe(true);
      const credential = parseAccountApiTokenCredentialV1(result.data.token);
      expect(credential).not.toBeNull();
      expect(openApiTokenEncryptionAccessV1({ context: { ...credential!, tokenId: captured!.tokenId }, wrappingSecret: decodeBase64(credential!.wrappingSecret, 'base64url'), encryptionAccess: captured!.encryptionAccess })).toEqual(machineKey);
      expect(JSON.stringify(captured)).not.toContain(credential!.wrappingSecret);
    } finally {
      vi.unstubAllGlobals();
      output.restore(); restore(); await app.close();
    }
  });

  it.each([
    ['create', '--label', 'build'],
    ['revoke', '12345678-1234-4234-8234-123456789abc'],
    ['revoke-all'],
  ])('refuses %s without a completed direct CLI confirmation before dispatch', async (...command) => {
    const app = fastify();
    let requests = 0;
    app.post('/v1/auth/api-tokens/create', async () => { requests += 1; return {}; });
    app.post('/v1/auth/api-tokens/revoke', async () => { requests += 1; return {}; });
    app.post('/v1/auth/api-tokens/revoke-all', async () => { requests += 1; return {}; });
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    const output = captureConsoleText();
    try {
      await writeCredentialsTokenOnly({ token: 'interactive' });
      await handleAuthCommand(['api-tokens', ...command, '--json']);

      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        error: { code: 'confirmation_declined' },
      });
      expect(requests).toBe(0);
    } finally {
      output.restore();
      restore();
      await app.close();
    }
  });
});
