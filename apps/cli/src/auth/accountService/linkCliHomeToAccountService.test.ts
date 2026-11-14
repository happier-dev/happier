import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

import { linkCliHomeToAccountService, unlinkCliHomeFromAccountService } from './linkCliHomeToAccountService';

const controller = vi.hoisted(() => ({ current: null as AbortController | null }));
const closeRuntimeMock = vi.hoisted(() => vi.fn(async () => {}));
const fetchServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const readStoredCredentialsForServerIdMock = vi.hoisted(() => vi.fn(async (_serverId: string) => ({ token: 'home-token' })));
const readSelectionMock = vi.hoisted(() => vi.fn(async () => ({
  endpoint: 'https://accounts.example.test',
  serverIdentityId: 'srv_account_service',
  canonicalServerUrl: 'https://accounts.example.test',
})));
const readCredentialMock = vi.hoisted(() => vi.fn(async () => ({ token: 'account-service-token' })));

const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_a',
  canonicalServerUrl: 'https://home.example.test',
  revision: 1,
  endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }],
};

vi.mock('@happier-dev/cli-common/agents', () => ({
  resolveHappyHomeDirFromEnvironment: () => '/tmp/happier-test',
}));
vi.mock('@/auth/terminalAuthEnrollmentRuntime', () => ({
  acquireTerminalAuthEnrollmentRuntime: async () => ({
    ok: true,
    runtime: { runtimeOrigin: 'https://home.example.test' },
    close: closeRuntimeMock,
  }),
}));
vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (input: unknown) => fetchServerFeaturesSnapshotMock(input),
}));
vi.mock('@/persistence', () => ({
  readStoredCredentialsForServerId: (input: string) => readStoredCredentialsForServerIdMock(input),
  readAccountE2eeCustody: (credential: Readonly<{ encryption?: unknown; accountE2eeCustody?: 'historical' }>) =>
    !credential.encryption ? 'absent' : credential.accountE2eeCustody === 'historical' ? 'historical' : 'active',
  readAccountE2eeCustodyForToken: async () => 'absent',
}));
vi.mock('@/server/serverProfiles', () => ({
  getActiveServerProfile: async () => ({
    id: 'profile-home-a',
    name: 'Home A',
    homeConnectionDescriptor: descriptor,
    homeConnectionDescriptorAuthority: 'exact',
  }),
  getServerProfile: async () => ({
    id: 'profile-home-a',
    name: 'Home A',
    homeConnectionDescriptor: descriptor,
    homeConnectionDescriptorAuthority: 'exact',
  }),
}));
vi.mock('./cliAccountServiceSession', () => ({
  createCliAccountServiceSessionOwner: () => ({
    readSelection: readSelectionMock,
    readCredential: readCredentialMock,
  }),
}));

describe('linkCliHomeToAccountService production adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controller.current = new AbortController();
    fetchServerFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: {
        features: {},
        capabilities: {
          accountDirectory: {
            version: 1,
            homeDirectory: true,
            homeEnrollment: true,
            deviceApproval: true,
            homeLoginAssertion: {
              keyId: 'a'.repeat(64),
              publicKeyBase64Url: 'A'.repeat(43),
            },
          },
          serverIdentity: { serverIdentityId: 'srv_account_service' },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([200, 302, 307])('settles an authenticated unlink (%s) without forwarding its bearer or body', async (status) => {
    let secondHopRequests = 0;
    let firstHopAuthenticated = false;
    let firstHopBodyReceived = false;
    let origin = '';
    const server = createServer(async (request, response) => {
      if (request.url === '/redirected') {
        secondHopRequests += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ v: 1, deleted: true, issuerServerIdentityId: 'srv_account_service' }));
        return;
      }
      firstHopAuthenticated = request.headers.authorization === 'Bearer home-token';
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      firstHopBodyReceived = JSON.parse(Buffer.concat(chunks).toString('utf8')).v === 1;
      response.writeHead(status, status === 200
        ? { 'Content-Type': 'application/json' }
        : { Location: `${origin.replace('127.0.0.1', '127.0.0.2')}/redirected` });
      response.end(JSON.stringify({ v: 1, deleted: true, issuerServerIdentityId: 'srv_account_service' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
    origin = `http://127.0.0.1:${address.port}`;
    // The transport boundary maps the fixture Home to this real HTTP listener.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      realFetch(new URL(new URL(String(url)).pathname, origin), init));
    try {
      const result = unlinkCliHomeFromAccountService({ homeServerIdentityId: descriptor.homeServerIdentityId });
      if (status === 200) {
        await expect(result).resolves.toEqual({
          kind: 'unlinked', homeServerIdentityId: descriptor.homeServerIdentityId, issuerServerIdentityId: 'srv_account_service',
        });
      } else {
        await expect(result).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status });
      }
      expect(firstHopAuthenticated).toBe(true);
      expect(firstHopBodyReceived).toBe(true);
      expect(secondHopRequests).toBe(0);
      expect(closeRuntimeMock).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('finishes Account Service publication when abort flips during the successful Home PUT', async () => {
    const requests: Array<{
      url: string;
      signal: AbortSignal | null | undefined;
      authorization: string | null;
      body: unknown;
    }> = [];
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = String(urlInput);
      requests.push({
        url,
        signal: init?.signal,
        authorization: new Headers(init?.headers).get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (url.endsWith('/v1/account-directory/me')) {
        return Response.json({
          v: 1,
          accountId: 'account-1',
          encryptionMode: 'plain',
          displayName: null,
          avatar: null,
          linkedAuthenticationMethods: [],
        });
      }
      if (url.includes('/v1/account/directory-links/')) {
        controller.current?.abort();
        return Response.json({
          v: 1,
          issuerServerIdentityId: 'srv_account_service',
          issuerSubjectId: 'account-1',
          issuerSigningKeyId: 'a'.repeat(64),
          issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
        });
      }
      if (url.endsWith('/v1/account-directory/private-labels/recipient-census')) {
        return Response.json({ contentEncryptionMode: 'plain', recipients: [] });
      }
      return Response.json({
        v: 1,
        homeServerIdentityId: descriptor.homeServerIdentityId,
        canonicalServerUrl: descriptor.canonicalServerUrl,
        label: { content: { t: 'plain', v: 'Home A' }, recipientEnvelope: null },
        preferred: false,
        connectionDescriptor: descriptor,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_001,
      });
    }));

    await expect(linkCliHomeToAccountService({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      relink: false,
      signal: controller.current!.signal,
    })).resolves.toEqual({ kind: 'linked', homeServerIdentityId: descriptor.homeServerIdentityId });

    expect(requests.map((request) => request.url)).toEqual([
      'https://accounts.example.test/v1/account-directory/me',
      'https://home.example.test/v1/account/directory-links/srv_account_service',
      'https://accounts.example.test/v1/account-directory/private-labels/recipient-census',
      'https://accounts.example.test/v1/account-directory/homes/srv_home_a',
    ]);
    expect(requests[3]?.signal).toBeUndefined();
    expect(requests.map((request) => request.authorization)).toEqual([
      'Bearer account-service-token',
      'Bearer home-token',
      'Bearer account-service-token',
      'Bearer account-service-token',
    ]);
    expect(requests[2]?.body).toEqual({ owner: { kind: 'account', accountId: 'account-1' } });
    expect(requests[3]?.body).toEqual({
      v: 1,
      label: { content: { t: 'plain', v: 'Home A' }, recipients: [] },
      connectionDescriptor: descriptor,
    });
    expect(closeRuntimeMock).toHaveBeenCalledOnce();
  });

  it('seals the Home name for the Account census before publishing its Directory row', async () => {
    const accountContentPrivateKey = new Uint8Array(32).fill(19);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(accountContentPrivateKey).publicKey;
    let published: unknown = null;
    readCredentialMock.mockResolvedValueOnce({ token: 'account-service-token', accountContentPrivateKey });
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = String(urlInput);
      if (url.endsWith('/v1/account-directory/me')) {
        return Response.json({
          v: 1,
          accountId: 'account-1',
          encryptionMode: 'e2ee',
          displayName: null,
          avatar: null,
          linkedAuthenticationMethods: [],
        });
      }
      if (url.includes('/v1/account/directory-links/')) {
        return Response.json({
          v: 1,
          issuerServerIdentityId: 'srv_account_service',
          issuerSubjectId: 'account-1',
          issuerSigningKeyId: 'a'.repeat(64),
          issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
        });
      }
      if (url.endsWith('/v1/account-directory/private-labels/recipient-census')) {
        return Response.json({
          contentEncryptionMode: 'e2ee',
          recipients: [{
            account: { kind: 'account', accountId: 'account-1', firstName: null, lastName: null, username: null, avatarUrl: null },
            readiness: {
              status: 'available',
              contentPublicKey: encodeBase64(recipientPublicKey),
              contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientPublicKey),
            },
            envelopeStatus: 'missing',
          }],
        });
      }
      published = JSON.parse(String(init?.body));
      const body = published as {
        label: { content: unknown; recipients: readonly [{ envelope: unknown }] };
      };
      return Response.json({
        v: 1,
        homeServerIdentityId: descriptor.homeServerIdentityId,
        canonicalServerUrl: descriptor.canonicalServerUrl,
        label: { content: body.label.content, recipientEnvelope: body.label.recipients[0].envelope },
        preferred: false,
        connectionDescriptor: descriptor,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_001,
      });
    }));

    await expect(linkCliHomeToAccountService({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      relink: false,
    })).resolves.toEqual({ kind: 'linked', homeServerIdentityId: descriptor.homeServerIdentityId });

    expect(published).toMatchObject({
      v: 1,
      label: {
        content: { t: 'encrypted' },
        recipients: [{
          accountId: 'account-1',
          envelope: { recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientPublicKey) },
        }],
      },
    });
    expect(JSON.stringify(published)).not.toContain('Home A');
  });

  it('refuses a Plain Directory mode while this Account Service credential retains an active key', async () => {
    readCredentialMock.mockResolvedValueOnce({
      token: 'account-service-token',
      accountContentPrivateKey: new Uint8Array(32).fill(31),
    });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request) => {
      const url = String(urlInput);
      requests.push(url);
      if (url.endsWith('/v1/account-directory/me')) {
        return Response.json({
          v: 1,
          accountId: 'account-1',
          encryptionMode: 'plain',
          displayName: null,
          avatar: null,
          linkedAuthenticationMethods: [],
        });
      }
      throw new Error(`Unexpected Directory request: ${url}`);
    }));

    await expect(linkCliHomeToAccountService({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      relink: false,
    })).resolves.toEqual({ kind: 'failed' });

    expect(requests).toEqual(['https://accounts.example.test/v1/account-directory/me']);
    expect(closeRuntimeMock).not.toHaveBeenCalled();
  });

  it('revokes the selected service link on the Home with the Home credential only', async () => {
    const requests: Array<{ url: string; method: string | undefined; authorization: string | null; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(urlInput),
        method: init?.method,
        authorization: new Headers(init?.headers).get('Authorization'),
        body: init?.body,
      });
      return Response.json({ v: 1, deleted: true, issuerServerIdentityId: 'srv_account_service' });
    }));

    await expect(unlinkCliHomeFromAccountService({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      signal: controller.current!.signal,
    })).resolves.toEqual({
      kind: 'unlinked',
      homeServerIdentityId: descriptor.homeServerIdentityId,
      issuerServerIdentityId: 'srv_account_service',
    });

    expect(requests).toEqual([{
      url: 'https://home.example.test/v1/account/directory-links/srv_account_service',
      method: 'DELETE',
      authorization: 'Bearer home-token',
      body: JSON.stringify({ v: 1 }),
    }]);
    expect(readCredentialMock).not.toHaveBeenCalled();
    expect(fetchServerFeaturesSnapshotMock).not.toHaveBeenCalled();
    expect(closeRuntimeMock).toHaveBeenCalledOnce();
  });

  it('names the selected sign-in service when this CLI is not signed in to it', async () => {
    readCredentialMock.mockResolvedValueOnce(null as never);

    await expect(linkCliHomeToAccountService({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      relink: false,
    })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'account_service_credentials_unavailable',
      selectedEndpoint: 'https://accounts.example.test',
    });
    expect(fetchServerFeaturesSnapshotMock).not.toHaveBeenCalled();
  });

  it('fails closed before credential or network use when the selected Account Service changed after confirmation', async () => {
    readSelectionMock.mockResolvedValueOnce({
      endpoint: 'https://other-accounts.example.test',
      serverIdentityId: 'srv_other_account_service',
      canonicalServerUrl: 'https://other-accounts.example.test',
    });

    await expect(linkCliHomeToAccountService({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      relink: false,
      expectedAccountServiceSelection: {
        endpoint: 'https://accounts.example.test',
        serverIdentityId: 'srv_account_service',
      },
    })).resolves.toEqual({ kind: 'failed' });

    expect(readCredentialMock).not.toHaveBeenCalled();
    expect(fetchServerFeaturesSnapshotMock).not.toHaveBeenCalled();
  });
});
