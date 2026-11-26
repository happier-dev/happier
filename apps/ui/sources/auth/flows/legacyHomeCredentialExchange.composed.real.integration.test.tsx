import React from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '../../../../server/sources/testkit/lightSqliteHarness';
import { authRoutes } from '../../../../server/sources/app/api/routes/auth/authRoutes';
import { featuresRoutes } from '../../../../server/sources/app/api/routes/features/featuresRoutes';
import { accountRoutes } from '../../../../server/sources/app/api/routes/account/accountRoutes';
import { registerTeamRoutes } from '../../../../server/sources/app/teams/registerTeamRoutes';
import { homeDomainActionPathForMethod } from '../../../../server/sources/app/api/routes/actions/homeDomainActionRoute';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import type { Fastify as HomeApp } from '../../../../server/sources/app/api/types';

installTokenStorageWebPlatformMocks();
const { renderScreen } = await import('@/dev/testkit');
const { initializeAuthRouteRuntimeForTests } =
  await import('@/dev/testkit/harness/authRouteRuntimeHarness');
await initializeAuthRouteRuntimeForTests();
const { AuthProvider, getCurrentAuth } =
  await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { adoptHomeProfile, setActiveServerId } =
  await import('@/sync/domains/server/serverProfiles');
const { authGetTokenAtEndpoint } = await import('@/auth/flows/getToken');
const { createServerFetchAtEndpoint, serverFetch } =
  await import('@/sync/http/client');
const { encodeBase64 } = await import('@/encryption/base64');
const { Encryption } = await import('@/sync/encryption/encryption');
const { parseToken, parseTokenPayload } =
  await import('@/utils/auth/parseToken');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { disconnectActiveServerConnection } =
  await import('@/sync/runtime/orchestration/connectionManager');
const { exchangeLegacyHomeCredentialOnce } =
  await import('./legacyHomeCredentialExchange');

type StoredCredentials = Awaited<
  ReturnType<typeof TokenStorage.getCredentialsForServerUrl>
>;

const homeUrl = 'https://legacy-exchange-home.test';
const homeIdentity = 'srv_legacy_exchange_home';
const otherUrl = 'https://legacy-exchange-other.test';
/** A second address served by the same Home process. */
const movedUrl = 'https://legacy-exchange-moved.test';
const teamsListPath = homeDomainActionPathForMethod('teams.list', 'POST');
const integrationTimeout = 120_000;

let database: LightSqliteHarness;
let app: HomeApp;
let storage: ReturnType<typeof installLocalStorageMock> | undefined;
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let releasedTokenGenerator: Awaited<
  ReturnType<typeof privacyKit.createPersistentTokenGenerator>
>;
const requests: Array<{ path: string; status: number }> = [];
/** Lets a case act at the exact network boundary (refuse, fail, or race a request). */
let intercept:
  | ((path: string) => Promise<Response | null> | Response | null)
  | null = null;

beforeAll(async () => {
  database = await createLightSqliteHarness({
    tempDirPrefix: 'happier-legacy-cred-exchange-',
    initAuth: true,
    initEncrypt: true,
    env: {
      AUTH_REQUIRED_LOGIN_PROVIDERS: '',
      HAPPIER_PUBLIC_SERVER_URL: homeUrl,
      HAPPIER_SERVER_IDENTITY_ID: homeIdentity,
      HAPPIER_FEATURE_TEAMS__ENABLED: '1',
    },
  });
  app = createAuthenticatedTestApp({ authentication: 'real' });
  authRoutes(app);
  featuresRoutes(app);
  accountRoutes(app);
  registerTeamRoutes(app, process.env);
  await app.ready();
  // The exact released 0.2 signer shape: `createToken(accountId)` without a provenance marker.
  releasedTokenGenerator = await privacyKit.createPersistentTokenGenerator({
    service: 'handy',
    seed: process.env.HANDY_MASTER_SECRET!,
  });
}, integrationTimeout);

beforeEach(() => {
  storage = installLocalStorageMock();
  requests.length = 0;
  intercept = null;
  setRuntimeFetch(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== homeUrl && url.origin !== movedUrl) {
      requests.push({ path: `${url.origin}${url.pathname}`, status: 503 });
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
    const intercepted = await intercept?.(url.pathname);
    if (intercepted) {
      requests.push({ path: url.pathname, status: intercepted.status });
      return intercepted;
    }
    const result = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    requests.push({ path: url.pathname, status: result.statusCode });
    return new Response(result.body, {
      status: result.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  await disconnectActiveServerConnection();
  setRuntimeFetch(async () => new Response('{}', { status: 404 }));
  database.resetEnv();
  storage?.restore();
  storage = undefined;
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

async function focusHome(identity = homeIdentity, url = homeUrl) {
  const home = await adoptHomeProfile({
    descriptor: {
      v: 1,
      homeServerIdentityId: identity,
      canonicalServerUrl: url,
      revision: 1,
      endpoints: [{ kind: 'https', url }],
    },
    source: 'manual',
    descriptorAuthority: 'current_connection_observation',
  });
  await setActiveServerId(home.id, { scope: 'device' });
  return home;
}

/** An Account provisioned by a real sign-in, then holding the bearer its 0.2 app stored. */
async function seedReleasedAccount(
  homeId: string,
  secret = nacl.randomBytes(32),
) {
  const current = await authGetTokenAtEndpoint({
    endpointUrl: homeUrl,
    serverId: homeId,
    serverIdentityId: homeIdentity,
    secret,
    requireKeyChallengeV2: true,
  });
  const accountId = parseToken(current.token);
  const legacyToken = await releasedTokenGenerator.new({
    user: accountId,
    extras: { tokenEpoch: 0 },
  });
  const credentials = {
    token: legacyToken,
    secret: encodeBase64(secret, 'base64url'),
  };
  expect(
    await TokenStorage.setCredentialsForServerUrl(
      homeUrl,
      { serverId: homeId },
      credentials,
    ),
  ).toBe(true);
  requests.length = 0;
  return { accountId, secret, credentials, currentToken: current.token };
}

function readLegacy(token: string) {
  return readAuthTokenProvenance(parseTokenPayload(token), {
    allowLegacyHome: true,
  });
}

async function teamsListStatus(
  homeId: string,
  credentials: NonNullable<StoredCredentials>,
) {
  const request = createServerFetchAtEndpoint({
    endpointUrl: homeUrl,
    serverId: homeId,
    credentials,
  });
  const response = await request(
    teamsListPath,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, scope: 'member', archived: 'active' }),
    },
    { retry: 'none' },
  );
  return {
    status: response.status,
    error: response.ok
      ? null
      : ((await response.json()) as { error?: string }).error,
  };
}

async function ordinaryHomeStatus(
  homeId: string,
  credentials: NonNullable<StoredCredentials>,
) {
  const request = createServerFetchAtEndpoint({
    endpointUrl: homeUrl,
    serverId: homeId,
    credentials,
  });
  return (
    await request(
      '/v1/account/encryption',
      { method: 'GET' },
      { retry: 'none' },
    )
  ).status;
}

const authPaths = () =>
  requests.filter(
    (row) => row.path === '/v1/auth/challenge' || row.path === '/v1/auth',
  );

describe('one-time exchange of a released 0.2 Home credential (real Home routes)', () => {
  it(
    'exchanges once through key-challenge v2, keeps the Account key, and opens Team routes',
    async () => {
      const home = await focusHome();
      const released = await seedReleasedAccount(home.id);
      expect(readLegacy(released.credentials.token)).toMatchObject({
        legacy: true,
        provenance: { kind: 'account' },
      });

      // Before: ordinary Home routes accept the 0.2 bearer; Team routes refuse it as a permission answer.
      expect(await ordinaryHomeStatus(home.id, released.credentials)).toBe(200);
      expect(await teamsListStatus(home.id, released.credentials)).toEqual({
        status: 403,
        error: 'team_forbidden',
      });
      requests.length = 0;

      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: homeUrl, serverId: home.id },
          released.credentials,
        ),
      ).toBe(true);
      expect(authPaths()).toEqual([
        { path: '/v1/auth/challenge', status: 200 },
        { path: '/v1/auth', status: 200 },
      ]);

      const stored = await TokenStorage.getCredentialsForServerUrl(homeUrl, {
        serverId: home.id,
      });
      expect(stored).toEqual({
        token: stored!.token,
        secret: released.credentials.secret,
      });
      expect(stored!.token).not.toBe(released.credentials.token);
      expect(parseToken(stored!.token)).toBe(released.accountId);
      expect(readLegacy(stored!.token)).toMatchObject({
        legacy: false,
        provenance: { kind: 'account' },
      });

      // After: the exact same Team route answers 200 for the exchanged credential.
      expect(await teamsListStatus(home.id, stored!)).toEqual({
        status: 200,
        error: null,
      });

      // The attempt is remembered; the exchanged credential is not legacy.
      requests.length = 0;
      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: homeUrl, serverId: home.id },
          released.credentials,
        ),
      ).toBe(true);
      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: homeUrl, serverId: home.id },
          stored!,
        ),
      ).toBe(false);
      expect(requests).toEqual([]);
    },
    integrationTimeout,
  );

  it(
    'makes no request for current, terminal, token-only, data-key or malformed credentials',
    async () => {
      const home = await focusHome();
      const released = await seedReleasedAccount(home.id);
      const terminalToken = await releasedTokenGenerator.new({
        user: released.accountId,
        extras: { tokenEpoch: 0, session: 'released-terminal-request' },
      });
      const encryption = await Encryption.create(released.secret);
      const candidates = [
        { token: released.currentToken, secret: released.credentials.secret },
        { token: terminalToken, secret: released.credentials.secret },
        { token: released.credentials.token },
        {
          token: released.credentials.token,
          encryption: {
            machineKey: encodeBase64(encryption.getContentPrivateKey()),
            publicKey: encodeBase64(encryption.contentDataKey),
          },
        },
        { token: 'not-a-credential', secret: released.credentials.secret },
      ];
      for (const credentials of candidates) {
        expect(
          await exchangeLegacyHomeCredentialOnce(
            { serverUrl: homeUrl, serverId: home.id },
            credentials,
          ),
        ).toBe(false);
      }
      expect(requests).toEqual([]);
      expect(
        await TokenStorage.getCredentialsForServerUrl(homeUrl, {
          serverId: home.id,
        }),
      ).toEqual(released.credentials);
    },
    integrationTimeout,
  );

  it.each([
    [
      'a Home without key-challenge v2 (0.2-shaped)',
      { env: { HAPPIER_PUBLIC_SERVER_URL: '' } },
    ],
    [
      'a Home that disables key-challenge sign-in',
      { env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0' } },
    ],
    [
      'a Home that requires another sign-in method',
      { env: { AUTH_REQUIRED_LOGIN_PROVIDERS: 'github' } },
    ],
    ['a 500 answer', { status: 500 }],
    ['an unreachable Home', { offline: true }],
  ] as const)(
    'keeps the 0.2 credential, signs nobody out and does not retry on %s',
    async (_label, failure) => {
      const home = await focusHome();
      const released = await seedReleasedAccount(home.id);
      if ('env' in failure) database.resetEnv(failure.env);
      if ('status' in failure)
        intercept = (path) =>
          path === '/v1/auth'
            ? Response.json({ error: 'internal' }, { status: 500 })
            : null;
      if ('offline' in failure)
        intercept = () => {
          throw new TypeError('Failed to fetch');
        };

      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: homeUrl, serverId: home.id },
          released.credentials,
        ),
      ).toBe(false);
      expect(
        await TokenStorage.getCredentialsForServerUrl(homeUrl, {
          serverId: home.id,
        }),
      ).toEqual(released.credentials);
      const attempted = requests.length;
      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: homeUrl, serverId: home.id },
          released.credentials,
        ),
      ).toBe(false);
      expect(requests.length).toBe(attempted);

      // The retained 0.2 credential still serves ordinary Home routes.
      database.resetEnv();
      intercept = null;
      expect(await ordinaryHomeStatus(home.id, released.credentials)).toBe(200);
    },
    integrationTimeout,
  );

  it.each(['sign-out', 'another Account sign-in', 'a Home switch'] as const)(
    'never overwrites a newer state after %s during the exchange',
    async (race) => {
      const home = await focusHome();
      const released = await seedReleasedAccount(home.id);
      const other = await seedReleasedAccount(home.id);
      await TokenStorage.setCredentialsForServerUrl(
        homeUrl,
        { serverId: home.id },
        released.credentials,
      );
      requests.length = 0;
      let otherHomeId: string | null = null;
      intercept = async (path) => {
        if (path !== '/v1/auth') return null;
        intercept = null;
        if (race === 'sign-out')
          await TokenStorage.removeCredentialsForServerUrl(homeUrl, {
            serverId: home.id,
          });
        if (race === 'another Account sign-in') {
          await TokenStorage.setCredentialsForServerUrl(
            homeUrl,
            { serverId: home.id },
            other.credentials,
          );
        }
        if (race === 'a Home switch') {
          const next = await adoptHomeProfile({
            descriptor: {
              v: 1,
              homeServerIdentityId: 'srv_legacy_exchange_other',
              canonicalServerUrl: otherUrl,
              revision: 1,
              endpoints: [{ kind: 'https', url: otherUrl }],
            },
            source: 'manual',
            descriptorAuthority: 'current_connection_observation',
          });
          otherHomeId = next.id;
          await setActiveServerId(next.id, { scope: 'device' });
        }
        return null;
      };

      const exchanged = await exchangeLegacyHomeCredentialOnce(
        { serverUrl: homeUrl, serverId: home.id },
        released.credentials,
      );
      const stored = await TokenStorage.getCredentialsForServerUrl(homeUrl, {
        serverId: home.id,
      });
      if (race === 'sign-out') {
        expect(exchanged).toBe(false);
        expect(stored).toBeNull();
      } else if (race === 'another Account sign-in') {
        expect(exchanged).toBe(false);
        expect(stored).toEqual(other.credentials);
      } else {
        // The initiating Home still holds the credential it started from, so it alone is upgraded.
        expect(exchanged).toBe(true);
        expect(parseToken(stored!.token)).toBe(released.accountId);
        expect(readLegacy(stored!.token)?.legacy).toBe(false);
        expect(
          await TokenStorage.getCredentialsForServerUrl(otherUrl, {
            serverId: otherHomeId!,
          }),
        ).toBeNull();
      }
    },
    integrationTimeout,
  );

  it(
    'refuses persistence when the Home identity or the Account key does not match the stored credential',
    async () => {
      const home = await focusHome();
      const released = await seedReleasedAccount(home.id);
      // Account key mismatch: the stored 0.2 bearer names one Account, the stored key proves another.
      const mismatchedKey = {
        token: released.credentials.token,
        secret: encodeBase64(nacl.randomBytes(32), 'base64url'),
      };
      await TokenStorage.setCredentialsForServerUrl(
        homeUrl,
        { serverId: home.id },
        mismatchedKey,
      );
      requests.length = 0;
      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: homeUrl, serverId: home.id },
          mismatchedKey,
        ),
      ).toBe(false);
      expect(
        await TokenStorage.getCredentialsForServerUrl(homeUrl, {
          serverId: home.id,
        }),
      ).toEqual(mismatchedKey);
      expect(
        requests.filter((row) => row.path === '/v1/auth' && row.status === 200),
      ).toEqual([]);

      // Home identity mismatch: this address now answers as another Home than the saved profile names.
      const movedReleased = await seedReleasedAccount(home.id);
      const moved = await focusHome('srv_legacy_exchange_previous_identity', movedUrl);
      expect(await TokenStorage.setCredentialsForServerUrl(movedUrl, { serverId: moved.id },
        movedReleased.credentials)).toBe(true);
      requests.length = 0;
      expect(
        await exchangeLegacyHomeCredentialOnce(
          { serverUrl: movedUrl, serverId: moved.id },
          movedReleased.credentials,
        ),
      ).toBe(false);
      expect(authPaths()).toEqual([]);
      expect(
        await TokenStorage.getCredentialsForServerUrl(movedUrl, {
          serverId: moved.id,
        }),
      ).toEqual(movedReleased.credentials);
    },
    integrationTimeout,
  );

  it(
    'upgrades the live Auth and Sync runtime once on restore, and the next restore makes no exchange',
    async () => {
      const home = await focusHome();
      const released = await seedReleasedAccount(home.id);
      screen = await renderScreen(
        <AuthProvider initialCredentials={released.credentials}>
          <></>
        </AuthProvider>,
      );
      await vi.waitFor(
        async () => {
          const live = getCurrentAuth()?.credentials;
          expect(live?.token, JSON.stringify(requests.slice(-20))).not.toBe(
            released.credentials.token,
          );
          expect(readLegacy(live!.token)?.legacy).toBe(false);
        },
        { timeout: integrationTimeout },
      );
      expect(authPaths()).toEqual([
        { path: '/v1/auth/challenge', status: 200 },
        { path: '/v1/auth', status: 200 },
      ]);
      const exchanged = await TokenStorage.getCredentialsForServerUrl(homeUrl, {
        serverId: home.id,
      });
      expect(getCurrentAuth()?.credentials).toEqual(exchanged);
      expect(getCurrentAuth()?.isAuthenticated).toBe(true);
      expect(exchanged).toEqual({
        token: exchanged!.token,
        secret: released.credentials.secret,
      });

      // The focused Home's own transport reads the exchanged credential: Team routes work without a reload.
      const teams = await serverFetch(
        teamsListPath,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: 1, scope: 'member', archived: 'active' }),
        },
        { retry: 'none' },
      );
      expect(teams.status).toBe(200);

      await screen.unmount();
      screen = undefined;
      await disconnectActiveServerConnection();
      requests.length = 0;
      screen = await renderScreen(
        <AuthProvider initialCredentials={exchanged}>
          <></>
        </AuthProvider>,
      );
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), {
        timeout: integrationTimeout,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(authPaths()).toEqual([]);
      expect(getCurrentAuth()?.credentials).toEqual(exchanged);
    },
    integrationTimeout,
  );
});
