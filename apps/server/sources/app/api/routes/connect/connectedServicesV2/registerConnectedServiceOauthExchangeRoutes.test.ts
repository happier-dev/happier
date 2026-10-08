import Fastify from 'fastify';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { AGY_OAUTH_SCOPES } from '@happier-dev/agents';

import { decodeBase64, encodeBase64, openBoxBundle } from '@happier-dev/protocol';

import { registerConnectedServiceOauthExchangeRoutes } from './registerConnectedServiceOauthExchangeRoutes';

function createTestApp() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>() as any;
  typed.decorate('authenticate', async () => {});
  registerConnectedServiceOauthExchangeRoutes(typed);
  return typed;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('registerConnectedServiceOauthExchangeRoutes', () => {
  it.each([
    ['ineligible', 'connect_oauth_account_ineligible'],
    ['missing-project', 'connect_oauth_project_required'],
  ])('returns an actionable redacted Antigravity %s result', async (scenario, errorCode) => {
    const app = createTestApp();
    let loaded = false;
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/token')) return Response.json({ access_token: 'at', refresh_token: 'rt', scope: AGY_OAUTH_SCOPES.join(' ') });
      if (url.endsWith('/userinfo')) return Response.json({ sub: 'account-a', email: 'a@example.test' });
      if (url.endsWith(':onboardUser')) return Response.json({ done: true });
      if (loaded || scenario === 'ineligible') return Response.json({ ineligibleTiers: [{ reasonMessage: 'private-provider-detail' }] });
      loaded = true;
      return Response.json({ allowedTiers: [{ id: 'free-tier' }] });
    };
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await app.inject({ method: 'POST', url: '/v2/connect/antigravity/oauth/exchange', payload: {
        publicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'), code: 'code', verifier: 'verifier',
        redirectUri: 'http://localhost:54545/', state: 'state',
      } });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: errorCode });
    } finally {
      await app.close();
    }
  });

  it('serves native Antigravity OAuth through the authenticated V2 contract with required state and PKCE', async () => {
    const app = createTestApp();
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/token')) return Response.json({ access_token: 'at', refresh_token: 'rt', scope: AGY_OAUTH_SCOPES.join(' ') });
      if (url.endsWith('/userinfo')) return Response.json({ sub: 'account-a', email: 'a@example.test', email_verified: true });
      return Response.json({ cloudaicompanionProject: 'project-a', currentTier: { id: 'paid-tier' } });
    };
    vi.stubGlobal('fetch', fetchMock);
    const keyPair = tweetnacl.box.keyPair();
    const request = { publicKey: encodeBase64(keyPair.publicKey, 'base64url'), code: 'code', verifier: 'verifier',
      redirectUri: 'http://localhost:54545/', state: 'state' };
    try {
      const result = await app.inject({ method: 'POST', url: '/v2/connect/antigravity/oauth/exchange', payload: request });
      expect(result.statusCode).toBe(200);
      const opened = openBoxBundle({ bundle: decodeBase64(JSON.parse(result.body).bundle, 'base64url'), recipientSecretKeyOrSeed: keyPair.secretKey });
      expect(opened).toBeTruthy();
      expect(JSON.parse(new TextDecoder().decode(opened!))).toMatchObject({ serviceId: 'antigravity',
        idToken: null, providerAccountId: 'account-a', raw: { antigravity: { projectId: 'project-a' } } });
      const missingState = await app.inject({ method: 'POST', url: '/v2/connect/antigravity/oauth/exchange', payload: { ...request, state: null } });
      expect(missingState.statusCode).toBe(400);
      expect(JSON.parse(missingState.body)).toEqual({ error: 'connect_oauth_state_mismatch' });
      const { verifier: _verifier, ...withoutVerifier } = request;
      const missingVerifier = await app.inject({ method: 'POST', url: '/v2/connect/antigravity/oauth/exchange', payload: withoutVerifier });
      expect(missingVerifier.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('exchanges openai-codex tokens and returns a decryptable bundle', async () => {
    const app = createTestApp();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id_token: 'id.token.value',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 60,
        token_type: 'Bearer',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const keyPair = tweetnacl.box.keyPair();
    const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

    const res = await app.inject({
      method: 'POST',
      url: '/v2/connect/openai-codex/oauth/exchange',
      payload: {
        publicKey,
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:1455/auth/callback',
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(typeof json.bundle).toBe('string');
    const bundleBytes = decodeBase64(String(json.bundle), 'base64url');
    const opened = openBoxBundle({ bundle: bundleBytes, recipientSecretKeyOrSeed: keyPair.secretKey });
    expect(opened).toBeTruthy();
    const payload = JSON.parse(new TextDecoder().decode(opened!));
    expect(payload.serviceId).toBe('openai-codex');
    expect(payload.refreshToken).toBe('refresh-token');
    expect(payload.accessToken).toBe('access-token');
  });

  it('rejects oauth exchange for openai api-key connected service', async () => {
    const app = createTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v2/connect/openai/oauth/exchange',
      payload: {
        publicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:1455/auth/callback',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'connect_oauth_exchange_failed' });
  });

  it('exchanges gemini tokens and returns a decryptable bundle', async () => {
    const app = createTestApp();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 60,
        token_type: 'Bearer',
        scope: 'email',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const keyPair = tweetnacl.box.keyPair();
    const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

    const res = await app.inject({
      method: 'POST',
      url: '/v2/connect/gemini/oauth/exchange',
      payload: {
        publicKey,
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:54545/oauth2callback',
      },
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(typeof json.bundle).toBe('string');
    const bundleBytes = decodeBase64(String(json.bundle), 'base64url');
    const opened = openBoxBundle({ bundle: bundleBytes, recipientSecretKeyOrSeed: keyPair.secretKey });
    expect(opened).toBeTruthy();
    const payload = JSON.parse(new TextDecoder().decode(opened!));
    expect(payload.serviceId).toBe('gemini');
    expect(payload.refreshToken).toBe('refresh-token');
    expect(payload.accessToken).toBe('access-token');
  });

  it('maps gemini invalid_grant to a dedicated oauth error code', async () => {
    const app = createTestApp();

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Bad Request' }),
      text: async () => 'invalid_grant',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const res = await app.inject({
      method: 'POST',
      url: '/v2/connect/gemini/oauth/exchange',
      payload: {
        publicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:54545/oauth2callback',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'connect_oauth_invalid_grant' });
  });

  it('maps gemini missing refresh_token to a dedicated oauth error code', async () => {
    const app = createTestApp();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-token',
        // refresh_token intentionally omitted
        expires_in: 60,
        token_type: 'Bearer',
        scope: 'email',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const res = await app.inject({
      method: 'POST',
      url: '/v2/connect/gemini/oauth/exchange',
      payload: {
        publicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:54545/oauth2callback',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'connect_oauth_missing_refresh_token' });
  });

  it('exchanges claude-subscription tokens and requires a state', async () => {
    const app = createTestApp();

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 60,
        token_type: 'Bearer',
        scope: 'email',
        account: { email_address: 'test@example.com', uuid: 'acct-1' },
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const keyPair = tweetnacl.box.keyPair();
    const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

    const okRes = await app.inject({
      method: 'POST',
      url: '/v2/connect/claude-subscription/oauth/exchange',
      payload: {
        publicKey,
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'https://platform.claude.com/oauth/code/callback',
        state: 'st1',
      },
    });
    expect(okRes.statusCode).toBe(200);
    const okJson = JSON.parse(okRes.body);
    const okBundleBytes = decodeBase64(String(okJson.bundle), 'base64url');
    const okOpened = openBoxBundle({ bundle: okBundleBytes, recipientSecretKeyOrSeed: keyPair.secretKey });
    expect(okOpened).toBeTruthy();
    const okPayload = JSON.parse(new TextDecoder().decode(okOpened!));
    expect(okPayload.serviceId).toBe('claude-subscription');
    expect(okPayload.providerEmail).toBe('test@example.com');
    expect(okPayload.providerAccountId).toBe('acct-1');

    const missingStateRes = await app.inject({
      method: 'POST',
      url: '/v2/connect/claude-subscription/oauth/exchange',
      payload: {
        publicKey,
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'https://platform.claude.com/oauth/code/callback',
      },
    });
    expect(missingStateRes.statusCode).toBe(400);
    expect(JSON.parse(missingStateRes.body)).toEqual({ error: 'connect_oauth_state_mismatch' });
  });
});
