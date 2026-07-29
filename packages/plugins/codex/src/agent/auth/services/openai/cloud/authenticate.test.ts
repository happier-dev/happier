import type {
  CloudAuthCallbackSessionV1,
  CloudCustomAuthenticatorContextV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import type {
  CodexRuntimeFetchRequest as FetchRuntimeRequestV1,
  CodexRuntimeFetchResponse as FetchRuntimeResponseV1,
} from '../../runtimeFetch.js';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { describe, expect, it, vi } from 'vitest';

import { OPENAI_CODEX_AUTH_BASE_URL } from './exchange.js';
import { authenticateCodexCloudConnect } from './authenticate.js';

type TestCloudAuthContext = CloudCustomAuthenticatorContextV1 & Readonly<{
  fetchRequests: FetchRuntimeRequestV1[];
  writtenRecords: ConnectedServiceCredentialRecordV1[];
}>;

function encodeJwtPayload(payload: Readonly<Record<string, unknown>>): string {
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function createJsonResponse(json: unknown): FetchRuntimeResponseV1 {
  const text = JSON.stringify(json);
  return {
    ok: true,
    status: 200,
    headers: {},
    body: json,
    text: async () => text,
    json: async () => json,
    arrayBuffer: async () => Buffer.from(text).buffer,
  };
}

function createContext(overrides: Partial<CloudCustomAuthenticatorContextV1> = {}): TestCloudAuthContext {
  const session: CloudAuthCallbackSessionV1 = {
    mode: 'loopback',
    state: 'oauth-state',
    redirectUri: 'http://localhost:1455/auth/callback',
    callbackUrl: 'http://127.0.0.1:1455/auth/callback',
    port: 1455,
    wait: vi.fn(async () => ({
      ok: true,
      code: 'auth-code',
      state: 'oauth-state',
      redirectUri: 'http://localhost:1455/auth/callback',
    })),
    close: vi.fn(async () => {}),
  };
  const fetchRequests: FetchRuntimeRequestV1[] = [];
  const writtenRecords: ConnectedServiceCredentialRecordV1[] = [];
  const base: TestCloudAuthContext = {
    signal: new AbortController().signal,
    now: () => 1_700_000_000_000,
    fetch: vi.fn(async (request) => {
      fetchRequests.push(request);
      return createJsonResponse({
        id_token: encodeJwtPayload({
          'https://api.openai.com/auth': { account_id: 'acct_nested' },
        }),
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 60,
      });
    }),
    browser: {
      open: vi.fn(async () => ({ ok: true })),
    },
    prompt: {
      requestText: vi.fn(async () => ({ ok: true, value: '' })),
    },
    oauth: {
      createPkceChallenge: vi.fn(async () => ({ verifier: 'verifier', challenge: 'challenge' })),
      callback: {
        create: vi.fn(async () => ({ ok: true, session })),
      },
      listenForCallback: vi.fn(async () => ({
        ok: true,
        code: 'auth-code',
        state: 'oauth-state',
        redirectUri: 'http://localhost:1455/auth/callback',
      })),
    },
    credentials: {
      write: vi.fn(async (input) => {
        const record = input.record as ConnectedServiceCredentialRecordV1;
        writtenRecords.push(record);
        return { ok: true, credentialRef: `${record.serviceId}/${record.profileId}` };
      }),
    },
    diagnostics: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    fetchRequests,
    writtenRecords,
  };
  return Object.freeze({
    ...base,
    ...overrides,
  });
}

describe('authenticateCodexCloudConnect', () => {
  it('uses the host callback service and writes a Codex OAuth credential record', async () => {
    const context = createContext();

    const result = await authenticateCodexCloudConnect({
      serviceId: 'openai-codex',
      profileId: 'default',
    }, context);

    expect(result).toEqual({
      ok: true,
      accountRef: 'acct_nested',
      credentialRef: 'openai-codex/default',
    });
    expect(context.oauth.callback.create).toHaveBeenCalledWith({
      mode: 'loopback',
      preferredPort: 1455,
      callbackPath: '/auth/callback',
    });
    expect(context.browser.open).toHaveBeenCalledWith(expect.stringContaining(`${OPENAI_CODEX_AUTH_BASE_URL}/oauth/authorize`));
    expect(context.fetchRequests[0]?.url).toBe(`${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`);
    expect(context.writtenRecords).toHaveLength(1);
    expect(context.writtenRecords[0]).toMatchObject({
      serviceId: 'openai-codex',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 1_700_000_060_000,
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        providerAccountId: 'acct_nested',
      },
    });
  });

  it('uses paste callback mode for no-open browser auth so the host prompt can display the URL', async () => {
    const context = createContext();

    await expect(authenticateCodexCloudConnect({
      serviceId: 'openai-codex',
      noOpen: true,
    }, context)).resolves.toEqual({
      ok: true,
      accountRef: 'acct_nested',
      credentialRef: 'openai-codex/default',
    });
    expect(context.oauth.callback.create).toHaveBeenCalledWith({
      mode: 'paste',
      preferredPort: 1455,
      callbackPath: '/auth/callback',
    });
    expect(context.browser.open).not.toHaveBeenCalled();
  });
});
