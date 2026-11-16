import { generateKeyPairSync, sign } from 'node:crypto';

import * as privacyKit from 'privacy-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OidcAuthProviderInstanceConfig } from '@/app/auth/providers/oidc/oidcProviderConfig';
import { createOidcOAuthProvider } from './oidcOAuthProvider';
// Verbatim `/.well-known/openid-configuration` documents fetched from login.microsoftonline.com
// on 2026-11-16 (single-tenant = Microsoft's own public tenant).
import commonDiscovery from './fixtures/entraDiscovery/common.json' with { type: 'json' };
import organizationsDiscovery from './fixtures/entraDiscovery/organizations.json' with { type: 'json' };
import consumersDiscovery from './fixtures/entraDiscovery/consumers.json' with { type: 'json' };
import singleTenantDiscovery from './fixtures/entraDiscovery/single-tenant.json' with { type: 'json' };

// The network is the only boundary faked here: every outbound identity request goes to the
// stubbed global fetch, while discovery, PKCE, ID-token signature and claim validation all run
// through the real owner and the real `openid-client`.
vi.mock(
  '@/app/net/outboundIdentityFetch',
  () => import('@/testkit/outboundFetchViaGlobalFetch'),
);

const ENTRA = 'https://login.microsoftonline.com';
const CLIENT_ID = '00000000-aaaa-bbbb-cccc-000000000001';
const CONSUMERS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const SINGLE_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const KID = 'entra-test-key';
const jwks = {
  keys: [
    {
      ...publicKey.export({ format: 'jwk' }),
      kid: KID,
      use: 'sig',
      alg: 'RS256',
    },
  ],
};

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  return privacyKit.encodeBase64(bytes, 'base64url').replace(/=+$/, '');
}

function signIdToken(claims: Record<string, unknown>): string {
  const data = `${base64Url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: KID }))}.${base64Url(JSON.stringify(claims))}`;
  return `${data}.${base64Url(sign('RSA-SHA256', new TextEncoder().encode(data), privateKey))}`;
}

type Discovery = Record<string, unknown> & {
  issuer: string;
  token_endpoint: string;
  jwks_uri: string;
};

/** Serves one IdP: its discovery document, JWKS, and a token endpoint minting the next queued ID token. */
function stubIdentityProvider(issuer: string, discovery: Discovery) {
  const idTokens: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Response.json(discovery);
    if (url === discovery.jwks_uri) return Response.json(jwks);
    if (url === discovery.token_endpoint && init?.method === 'POST') {
      const claims = idTokens.shift();
      if (!claims)
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({
        access_token: 'at',
        token_type: 'Bearer',
        id_token: signIdToken(claims),
      });
    }
    return new Response('not found', { status: 404 });
  });
  return {
    queueIdToken: (claims: Record<string, unknown>) => idTokens.push(claims),
  };
}

let instanceSeq = 0;
function microsoftInstance(issuer: string): OidcAuthProviderInstanceConfig {
  instanceSeq += 1;
  return {
    id: `microsoft-${instanceSeq}`,
    type: 'oidc',
    displayName: 'Microsoft',
    issuer,
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    clientAuthenticationMethod: 'client_secret_post',
    redirectUrl: 'https://home.example.test/v1/oauth/microsoft/callback',
    scopes: 'openid profile email',
    httpTimeoutSeconds: 5,
    claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
    allow: {
      usersAllowlist: [],
      emailDomains: [],
      groupsAny: [],
      groupsAll: [],
    },
    fetchUserInfo: false,
    storeRefreshToken: false,
    ui: { buttonColor: null, iconHint: null },
  };
}

function entraIdToken(input: {
  iss: string;
  tid: string;
  nonce: string;
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    ver: '2.0',
    iss: input.iss,
    tid: input.tid,
    aud: CLIENT_ID,
    sub: 'pairwise-subject',
    oid: 'object-id',
    nonce: input.nonce,
    iat: now,
    nbf: now,
    exp: now + 600,
    name: 'Alice',
    preferred_username: 'alice@contoso.example',
    email: 'alice@contoso.example',
  };
}

async function signIn(
  provider: ReturnType<typeof createOidcOAuthProvider>,
  nonce: string,
) {
  const authorizeUrl = new URL(
    await provider.resolveAuthorizeUrl({
      state: 'state-1',
      scope: 'openid profile email',
      codeChallenge: 'E9Melhoe2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      nonce,
    }),
  );
  const exchange = await provider.exchangeCodeForAccessToken({
    code: 'code-1',
    state: 'state-1',
    pkceCodeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    expectedNonce: nonce,
  });
  return { authorizeUrl, exchange };
}

// openid-client wraps the oauth4webapi claim-comparison error, whose own cause names the claim.
const issuerClaimRejected = {
  code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
  cause: { cause: { claim: 'iss' } },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Microsoft Entra ID through the generic OIDC owner', () => {
  it.each([
    ['common', commonDiscovery],
    ['organizations', organizationsDiscovery],
  ])(
    'signs in through the multi-tenant /%s authority and pins the ID-token issuer to its tid',
    async (form, discovery) => {
      const issuer = `${ENTRA}/${form}/v2.0`;
      const idp = stubIdentityProvider(issuer, discovery);
      const provider = createOidcOAuthProvider(
        microsoftInstance(issuer),
        `fp-${form}`,
      );

      await expect(provider.validateConfiguration()).resolves.toBeUndefined();

      idp.queueIdToken(
        entraIdToken({
          iss: `${ENTRA}/${SINGLE_TENANT}/v2.0`,
          tid: SINGLE_TENANT,
          nonce: 'n1',
        }),
      );
      const { authorizeUrl, exchange } = await signIn(provider, 'n1');
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
        `${ENTRA}/${form}/oauth2/v2.0/authorize`,
      );
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe(
        'S256',
      );
      expect(exchange.idTokenClaims).toMatchObject({
        sub: 'pairwise-subject',
        tid: SINGLE_TENANT,
      });

      // A token whose issuer names a different tenant than the one it claims is refused.
      idp.queueIdToken(
        entraIdToken({
          iss: `${ENTRA}/${SINGLE_TENANT}/v2.0`,
          tid: OTHER_TENANT,
          nonce: 'n2',
        }),
      );
      await expect(signIn(provider, 'n2')).rejects.toMatchObject(
        issuerClaimRejected,
      );
    },
  );

  it("signs in through /consumers and accepts only the consumer tenant's issuer", async () => {
    const issuer = `${ENTRA}/consumers/v2.0`;
    const idp = stubIdentityProvider(issuer, consumersDiscovery);
    const provider = createOidcOAuthProvider(
      microsoftInstance(issuer),
      'fp-consumers',
    );

    idp.queueIdToken(
      entraIdToken({
        iss: `${ENTRA}/${CONSUMERS_TENANT}/v2.0`,
        tid: CONSUMERS_TENANT,
        nonce: 'n1',
      }),
    );
    const { exchange } = await signIn(provider, 'n1');
    expect(exchange.idTokenClaims).toMatchObject({ tid: CONSUMERS_TENANT });

    idp.queueIdToken(
      entraIdToken({
        iss: `${ENTRA}/${OTHER_TENANT}/v2.0`,
        tid: OTHER_TENANT,
        nonce: 'n2',
      }),
    );
    await expect(signIn(provider, 'n2')).rejects.toMatchObject(
      issuerClaimRejected,
    );
  });

  it('signs in through a single-tenant issuer and refuses every other tenant', async () => {
    const issuer = `${ENTRA}/${SINGLE_TENANT}/v2.0`;
    const idp = stubIdentityProvider(issuer, singleTenantDiscovery);
    const provider = createOidcOAuthProvider(
      microsoftInstance(issuer),
      'fp-single',
    );

    idp.queueIdToken(
      entraIdToken({ iss: issuer, tid: SINGLE_TENANT, nonce: 'n1' }),
    );
    const { authorizeUrl, exchange } = await signIn(provider, 'n1');
    expect(authorizeUrl.pathname).toBe(
      `/${SINGLE_TENANT}/oauth2/v2.0/authorize`,
    );
    expect(exchange.idTokenClaims).toMatchObject({ tid: SINGLE_TENANT });

    idp.queueIdToken(
      entraIdToken({
        iss: `${ENTRA}/${OTHER_TENANT}/v2.0`,
        tid: OTHER_TENANT,
        nonce: 'n2',
      }),
    );
    await expect(signIn(provider, 'n2')).rejects.toMatchObject(
      issuerClaimRejected,
    );
  });

  it('still refuses an Entra authority whose discovered issuer is not an Entra issuer', async () => {
    const issuer = `${ENTRA}/common/v2.0`;
    stubIdentityProvider(issuer, {
      ...commonDiscovery,
      issuer: 'https://idp.example.test/{tenantid}/v2.0',
    });
    const provider = createOidcOAuthProvider(
      microsoftInstance(issuer),
      'fp-foreign',
    );
    await expect(provider.validateConfiguration()).rejects.toThrow(
      'oidc_issuer_mismatch',
    );
  });

  it('still refuses an Entra discovery that advertises PKCE methods without S256', async () => {
    const issuer = `${ENTRA}/${SINGLE_TENANT}/v2.0`;
    stubIdentityProvider(issuer, {
      ...singleTenantDiscovery,
      code_challenge_methods_supported: ['plain'],
    });
    const provider = createOidcOAuthProvider(
      microsoftInstance(issuer),
      'fp-plain',
    );
    await expect(provider.validateConfiguration()).rejects.toThrow(
      'oidc_pkce_s256_unsupported',
    );
  });
});

describe('non-Entra issuers keep failing closed', () => {
  const issuer = 'https://idp.example.test';
  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
  };

  it('refuses an issuer that differs from the configured one', async () => {
    stubIdentityProvider(issuer, { ...discovery, issuer: `${issuer}/` });
    const provider = createOidcOAuthProvider(
      microsoftInstance(issuer),
      'fp-generic-mismatch',
    );
    await expect(provider.validateConfiguration()).rejects.toThrow(
      'oidc_issuer_mismatch',
    );
  });

  it('refuses a provider that does not advertise S256', async () => {
    const { code_challenge_methods_supported: _omitted, ...withoutPkce } =
      discovery;
    stubIdentityProvider(issuer, withoutPkce);
    const provider = createOidcOAuthProvider(
      microsoftInstance(issuer),
      'fp-generic-pkce',
    );
    await expect(provider.validateConfiguration()).rejects.toThrow(
      'oidc_pkce_s256_unsupported',
    );
  });
});
