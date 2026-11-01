import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
  deriveAccountMachineKeyFromRecoverySecret,
  openTerminalProvisioningV3Response,
  resolveTerminalProvisioningVariantV2,
} from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

const { mockPost, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: mockPost,
    get: mockGet,
  },
}));

const currentness = (mode: 'plain' | 'e2ee', key: Uint8Array = new Uint8Array(32).fill(2)) => createAccountEncryptionCurrentnessFixture({ mode, version: 1, contentKeyFingerprint: mode === 'plain' ? null : computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey) });

describe('approveTerminalAuthRequest', () => {
  beforeEach(() => { mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee') }); });
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const;

  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    mockPost.mockReset();
    mockGet.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('posts default approval through the published endpoint without changing the configured Home', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_PUBLIC_SERVER_URL: 'http://host.lima.internal:53288',
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 's_local',
            servers: {
              s_local: {
                id: 's_local',
                name: 'Local dev',
                serverUrl: 'http://127.0.0.1:53288',
                webappUrl: 'http://localhost:53288',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serversDir = join(homeDir, 'servers', 's_local');
      mkdirSync(serversDir, { recursive: true });
      const machineKey = new Uint8Array(32).fill(2);
      writeFileSync(
        join(serversDir, 'access.key'),
        JSON.stringify(
          {
            token: 'token-1',
            encryption: {
              publicKey: Buffer.from(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey).toString('base64'),
              machineKey: Buffer.from(machineKey).toString('base64'),
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.serverUrl).toBe('http://host.lima.internal:53288');
      expect(configMod.configuration.apiServerUrl).toBe('http://127.0.0.1:53288');
      const { publishServerHttpRuntimeOrigin } = await import('@/api/client/serverHttpBaseUrl');
      const release = publishServerHttpRuntimeOrigin('http://127.0.0.1:53289', 'iroh');
      try {

      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      const approval = await import('./terminalAuthApproval');
      const terminalPublicKey = Buffer.alloc(32, 3).toString('base64');
      await approval.approveTerminalAuthRequest({
        publicKey: terminalPublicKey,
        pairing: {
          secretB64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
          createdAtMs: Date.now() - 60_000,
          expiresAtMs: Date.now() + 3_600_000,
        },
        supportsTokenOnly: true,
      });

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body] = mockPost.mock.calls[0] ?? [];
      expect(url).toBe('http://127.0.0.1:53289/v1/auth/response');
      expect(body).not.toHaveProperty('authorizeUnattendedTeamAccess');

      mockPost.mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            error: 'credential_authentication_evidence_unavailable',
            secret: 'DO_NOT_DISCLOSE',
          },
        },
      });
      await expect(approval.approveTerminalAuthRequest({
        publicKey: terminalPublicKey,
        pairing: {
          secretB64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
          createdAtMs: Date.now() - 60_000,
          expiresAtMs: Date.now() + 3_600_000,
        },
        supportsTokenOnly: true,
        authorizeUnattendedTeamAccess: true,
      })).rejects.toMatchObject({
        name: 'TerminalAuthenticationEvidenceUnavailableError',
        code: 'CREDENTIAL_AUTHENTICATION_EVIDENCE_UNAVAILABLE',
        message: expect.not.stringContaining('DO_NOT_DISCLOSE'),
      });
      } finally { release(); }
    });
  });

  it('uses the explicitly targeted Home profile and credential instead of the active Home', async () => {
    await withTempDir('happier-cli-terminal-auth-explicit-home-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 5,
        onboardingCompleted: true,
        activeServerId: 'home-a',
        servers: {
          'home-a': {
            id: 'home-a', name: 'Home A', serverUrl: 'https://home-a.example.test',
            webappUrl: 'https://home-a.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
          },
          'home-b': {
            id: 'home-b', name: 'Home B', serverUrl: 'https://home-b.example.test',
            webappUrl: 'https://home-b.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
          },
        },
      }), 'utf8');
      for (const [profileId, token] of [['home-a', 'token-a'], ['home-b', 'token-b']] as const) {
        const profileDir = join(homeDir, 'servers', profileId);
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(join(profileDir, 'access.key'), JSON.stringify({ token, encryption: null }), 'utf8');
      }

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.activeServerId).toBe('home-a');
      const { resolveCliHomeTarget } = await import('@/server/homeTarget');
      const target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: 'home-b' });
      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      mockGet.mockResolvedValue({ status: 200, data: currentness('plain') });
      const approval = await import('./terminalAuthApproval');
      await approval.approveTerminalAuthRequest({
        publicKey: Buffer.alloc(32, 3).toString('base64'),
        pairing: {
          secretB64Url: Buffer.alloc(32, 11).toString('base64url'),
          createdAtMs: Date.now() - 1_000,
          expiresAtMs: Date.now() + 60_000,
        },
        supportsTokenOnly: true,
        target,
      });

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, _body, options] = mockPost.mock.calls[0] ?? [];
      expect(url).toBe('https://home-b.example.test/v1/auth/response');
      expect(options).toMatchObject({ headers: { Authorization: 'Bearer token-b' } });
    });
  });

  it.each([
    { authorized: true, authority: 'manual_url' },
    { authorized: false, authority: 'manual_url' },
    { authorized: false, authority: 'account_directory' },
  ] as const)('authorizes a remote route from the saved descriptor before bearer disclosure ($authority, authorized: $authorized)', async ({ authorized, authority }) => {
    await withTempDir('happier-cli-terminal-auth-route-alias-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 5,
        onboardingCompleted: true,
        activeServerId: 'home-loopback',
        servers: {
          'home-loopback': {
            id: 'home-loopback',
            name: 'Loopback Home',
            serverUrl: 'http://127.0.0.1:3005',
            webappUrl: 'http://127.0.0.1:3005',
            homeConnectionDescriptor: {
              v: 1,
              homeServerIdentityId: 'srv_route_alias_home',
              canonicalServerUrl: 'http://127.0.0.1:3005',
              revision: 1,
              endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64) },
                ...(authorized ? [{ kind: 'https', url: 'https://public-route.example.test' }] : []),
              ],
            },
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      }), 'utf8');
      const profileDir = join(homeDir, 'servers', 'home-loopback');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'access.key'), JSON.stringify({ token: 'token-loopback', encryption: null }), 'utf8');
      mockGet.mockResolvedValue({ status: 200, data: currentness('plain') });
      const featuresBody = JSON.stringify({
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_route_alias_home' } },
      });
      const fetchMock = vi.fn(async () => new Response(featuresBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);
      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      const { resolveCliHomeTarget } = await import('@/server/homeTarget');
      const target = await resolveCliHomeTarget(authority === 'manual_url'
        ? { kind: 'https_url', url: 'https://public-route.example.test' }
        : { kind: 'descriptor', authority, descriptor: {
          v: 1, homeServerIdentityId: 'srv_route_alias_home',
          canonicalServerUrl: 'https://public-route.example.test', revision: 50,
          endpoints: [{ kind: 'https', url: 'https://public-route.example.test' }],
        } });
      const approval = await import('./terminalAuthApproval');
      const result = approval.approveTerminalAuthRequest({
        publicKey: Buffer.alloc(32, 3).toString('base64'),
        pairing: {
          secretB64Url: Buffer.alloc(32, 11).toString('base64url'),
          createdAtMs: Date.now() - 1_000,
          expiresAtMs: Date.now() + 60_000,
        },
        supportsTokenOnly: true,
        target,
      });

      if (!authorized) {
        await expect(result).rejects.toThrow();
        expect(fetchMock.mock.calls.every((call) => !new Headers((call as unknown as [string, RequestInit])[1]?.headers).has('Authorization'))).toBe(true);
        expect(mockPost).not.toHaveBeenCalled();
        return;
      }
      await result;

      expect(fetchMock).toHaveBeenCalledWith(
        'https://public-route.example.test/v1/features',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(mockPost).toHaveBeenCalledWith(
        'https://public-route.example.test/v1/auth/response',
        expect.anything(),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-loopback' }) }),
      );
    });
  });

  it('refuses a released remote public-route alias whose observed identity is not a saved Home', async () => {
    await withTempDir('happier-cli-terminal-auth-route-mismatch-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 5,
        onboardingCompleted: true,
        activeServerId: 'home-loopback',
        servers: {
          'home-loopback': {
            id: 'home-loopback',
            name: 'Loopback Home',
            serverUrl: 'http://127.0.0.1:3005',
            webappUrl: 'http://127.0.0.1:3005',
            homeConnectionDescriptor: {
              v: 1,
              homeServerIdentityId: 'srv_expected_home',
              canonicalServerUrl: 'http://127.0.0.1:3005',
              revision: 1,
              endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
            },
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      }), 'utf8');
      const profileDir = join(homeDir, 'servers', 'home-loopback');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'access.key'), JSON.stringify({ token: 'token-loopback', encryption: null }), 'utf8');
      mockGet.mockResolvedValue({ status: 200, data: currentness('plain') });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_other_home' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })));

      const { resolveCliHomeTarget } = await import('@/server/homeTarget');
      const target = await resolveCliHomeTarget({ kind: 'https_url', url: 'https://wrong-route.example.test' });
      const approval = await import('./terminalAuthApproval');
      await expect(approval.approveTerminalAuthRequest({
        publicKey: Buffer.alloc(32, 3).toString('base64'),
        pairing: {
          secretB64Url: Buffer.alloc(32, 11).toString('base64url'),
          createdAtMs: Date.now() - 1_000,
          expiresAtMs: Date.now() + 60_000,
        },
        supportsTokenOnly: true,
        target,
      })).rejects.toThrow('does not match a saved Home');
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it('does not select a bearer by URL coincidence when the explicit route profile has no stable Home identity', async () => {
    await withTempDir('happier-cli-terminal-auth-url-only-profile-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
        schemaVersion: 5,
        onboardingCompleted: true,
        activeServerId: 'url-only',
        servers: {
          'url-only': {
            id: 'url-only',
            name: 'URL-only profile',
            serverUrl: 'https://public-route.example.test',
            webappUrl: 'https://public-route.example.test',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      }), 'utf8');
      const profileDir = join(homeDir, 'servers', 'url-only');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'access.key'), JSON.stringify({ token: 'must-not-be-used', encryption: null }), 'utf8');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_observed_but_unsaved' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })));

      const { resolveCliHomeTarget } = await import('@/server/homeTarget');
      const target = await resolveCliHomeTarget({ kind: 'https_url', url: 'https://public-route.example.test' });
      const approval = await import('./terminalAuthApproval');
      await expect(approval.approveTerminalAuthRequest({
        publicKey: Buffer.alloc(32, 3).toString('base64'),
        pairing: {
          secretB64Url: Buffer.alloc(32, 11).toString('base64url'),
          createdAtMs: Date.now() - 1_000,
          expiresAtMs: Date.now() + 60_000,
        },
        supportsTokenOnly: true,
        target,
      })).rejects.toThrow('does not match a saved Home');
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it('fails closed with a typed error when no pairing context is present (token-only credentials)', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-token-only-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: 'token-only-1' });
      mockGet.mockResolvedValue({ status: 200, data: currentness('plain') });

      const approval = await import('./terminalAuthApproval');
      const terminalPublicKey = Buffer.alloc(32, 3).toString('base64');
      await expect(
        approval.approveTerminalAuthRequest({ publicKey: terminalPublicKey }),
      ).rejects.toMatchObject({
        name: 'TerminalPairingContextRequiredError',
        code: 'TERMINAL_PAIRING_CONTEXT_REQUIRED',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  function decodePostedResponse(): Uint8Array {
    expect(mockPost).toHaveBeenCalledTimes(1);
    const body = mockPost.mock.calls[0]?.[1] as { response?: unknown } | undefined;
    expect(typeof body?.response).toBe('string');
    return new Uint8Array(Buffer.from(String(body?.response), 'base64'));
  }

  it('seals an authenticated v3 token-only response for token-only credentials when the requester supports token-only', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-token-only-v3-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: 'token-only-1' });
      mockGet.mockResolvedValue({ status: 200, data: currentness('plain') });

      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      const pairingSecret = new Uint8Array(32).fill(11);
      const createdAtMs = Date.now() - 60_000;
      const expiresAtMs = Date.now() + 3_600_000;
      await approval.approveTerminalAuthRequest({
        publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
        pairing: {
          secretB64Url: Buffer.from(pairingSecret).toString('base64url'),
          createdAtMs,
          expiresAtMs,
        },
        supportsTokenOnly: true,
      });

      const opened = openTerminalProvisioningV3Response({
        payload: decodePostedResponse(),
        recipientSecretKeyOrSeed: terminalKeypair.secretKey,
        terminalEphemeralPublicKey: terminalKeypair.publicKey,
        pairingSecret,
        createdAtMs,
        expiresAtMs,
        nowMs: Date.now(),
      });
      expect(opened).toEqual({ type: 'tokenOnly' });
    });
  });

  it('requires the requester token-only capability before provisioning token-only material', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-token-only-capability-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsTokenOnly({ token: 'token-only-1' });
      mockGet.mockResolvedValue({ status: 200, data: currentness('plain') });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      await expect(
        approval.approveTerminalAuthRequest({
          publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
          pairing: {
            secretB64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
            createdAtMs: Date.now() - 60_000,
            expiresAtMs: Date.now() + 3_600_000,
          },
        }),
      ).rejects.toMatchObject({
        name: 'TokenOnlyTerminalApprovalUpgradeRequiredError',
        code: 'TOKEN_ONLY_TERMINAL_APPROVAL_UPGRADE_REQUIRED',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])('seals a v3 data-key response only for current E2EE material (obsolete=%s)', async (obsolete) => {
    await withTempDir('happier-cli-terminal-auth-approval-data-key-v3-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const machineKey = new Uint8Array(32).fill(7);
      mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee', obsolete ? new Uint8Array(32).fill(8) : machineKey) });
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsDataKey({
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        machineKey,
        token: 'token-1',
      });

      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      const pairingSecret = new Uint8Array(32).fill(11);
      const createdAtMs = Date.now() - 60_000;
      const expiresAtMs = Date.now() + 3_600_000;
      const completion = approval.approveTerminalAuthRequest({
        publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
        pairing: {
          secretB64Url: Buffer.from(pairingSecret).toString('base64url'),
          createdAtMs,
          expiresAtMs,
        },
        supportsTokenOnly: true,
      });

      if (obsolete) {
        await expect(completion).rejects.toMatchObject({ code: 'TERMINAL_PROVISIONING_MATERIAL_INVALID' });
        expect(mockPost).not.toHaveBeenCalled();
        return;
      }
      await completion;
      const opened = openTerminalProvisioningV3Response({
        payload: decodePostedResponse(),
        recipientSecretKeyOrSeed: terminalKeypair.secretKey,
        terminalEphemeralPublicKey: terminalKeypair.publicKey,
        pairingSecret,
        createdAtMs,
        expiresAtMs,
        nowMs: Date.now(),
      });
      expect(opened).toEqual({ type: 'dataKey', key: machineKey });
    });
  });

  it('fails closed with a typed error for keyed credentials when the requester sends no pairing context', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-keyed-no-context-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const machineKey = new Uint8Array(32).fill(7);
      mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee', machineKey) });
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsDataKey({
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        machineKey,
        token: 'token-1',
      });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      await expect(
        approval.approveTerminalAuthRequest({
          publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
        }),
      ).rejects.toMatchObject({
        name: 'TerminalPairingContextRequiredError',
        code: 'TERMINAL_PAIRING_CONTEXT_REQUIRED',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it('issues canonical derived data-key material for legacy recovery-secret credentials', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-legacy-derived-material-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const persistence = await import('@/persistence');
      const legacySecret = new Uint8Array(32).fill(9);
      mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee', deriveAccountMachineKeyFromRecoverySecret(legacySecret)) });
      await persistence.writeCredentialsLegacy({
        secret: legacySecret,
        token: 'token-1',
      });

      mockPost.mockResolvedValueOnce({ status: 200, data: {} });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      const pairing = {
        secretB64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
        createdAtMs: Date.now() - 60_000,
        expiresAtMs: Date.now() + 3_600_000,
      };
      await approval.approveTerminalAuthRequest({
        publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
        pairing,
        supportsTokenOnly: true,
      });

      expect(mockPost).toHaveBeenCalledOnce();
      const body = mockPost.mock.calls[0]?.[1] as { response?: string; responseKind?: string } | undefined;
      expect(body?.responseKind).toBe('dataKey');
      const opened = openTerminalProvisioningV3Response({
        payload: new Uint8Array(Buffer.from(String(body?.response), 'base64')),
        recipientSecretKeyOrSeed: terminalKeypair.secretKey,
        terminalEphemeralPublicKey: terminalKeypair.publicKey,
        pairingSecret: new Uint8Array(32).fill(11),
        createdAtMs: pairing.createdAtMs,
        expiresAtMs: pairing.expiresAtMs,
        nowMs: Date.now(),
      });
      expect(opened).toEqual({ type: 'dataKey', key: deriveAccountMachineKeyFromRecoverySecret(legacySecret) });
    });
  });

  it('fails closed when stored data-key material fails public-key consistency validation', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-material-invalid-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const machineKey = new Uint8Array(32).fill(7);
      mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee', machineKey) });
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsDataKey({
        // Deliberately unrelated public key: must not match the machine key.
        publicKey: tweetnacl.box.keyPair().publicKey,
        machineKey,
        token: 'token-1',
      });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      await expect(
        approval.approveTerminalAuthRequest({
          publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
          pairing: {
            secretB64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
            createdAtMs: Date.now() - 60_000,
            expiresAtMs: Date.now() + 3_600_000,
          },
        }),
      ).rejects.toMatchObject({
        name: 'TerminalProvisioningMaterialInvalidError',
        code: 'TERMINAL_PROVISIONING_MATERIAL_INVALID',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it('fails closed with a typed error for an expired pairing context without posting', async () => {
    await withTempDir('happier-cli-terminal-auth-approval-expired-context-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const machineKey = new Uint8Array(32).fill(7);
      mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee', machineKey) });
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsDataKey({
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        machineKey,
        token: 'token-1',
      });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      await expect(
        approval.approveTerminalAuthRequest({
          publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
          pairing: {
            secretB64Url: Buffer.from(new Uint8Array(32).fill(11)).toString('base64url'),
            createdAtMs: 1_000,
            expiresAtMs: 2_000,
          },
        }),
      ).rejects.toMatchObject({
        name: 'TerminalPairingContextExpiredError',
        code: 'TERMINAL_PAIRING_CONTEXT_EXPIRED',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['wrong secret length', Buffer.alloc(16).toString('base64url'), false],
    ['noncanonical secret encoding', `${Buffer.alloc(32, 11).toString('base64url')}=`, false],
    ['unknown field', Buffer.alloc(32, 11).toString('base64url'), true],
  ])('fails closed with a typed error for a malformed pairing context (%s) without posting', async (_case, secretB64Url, includeUnknownField) => {
    await withTempDir('happier-cli-terminal-auth-approval-malformed-context-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.happier.dev',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();
      const machineKey = new Uint8Array(32).fill(7);
      mockGet.mockResolvedValue({ status: 200, data: currentness('e2ee', machineKey) });
      const persistence = await import('@/persistence');
      await persistence.writeCredentialsDataKey({
        publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        machineKey,
        token: 'token-1',
      });

      const approval = await import('./terminalAuthApproval');
      const terminalKeypair = tweetnacl.box.keyPair();
      const pairing = {
        secretB64Url,
        createdAtMs: Date.now() - 60_000,
        expiresAtMs: Date.now() + 3_600_000,
        ...(includeUnknownField ? { smuggled: true } : {}),
      };
      await expect(
        approval.approveTerminalAuthRequest({
          publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
          pairing,
        }),
      ).rejects.toMatchObject({
        name: 'TerminalPairingContextInvalidError',
        code: 'TERMINAL_PAIRING_CONTEXT_INVALID',
      });
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  it('material decisions follow authenticated Account mode and local custody for every persisted credential shape', async () => {
    const terminalKeypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const pairing = {
      secretB64Url: Buffer.from(pairingSecret).toString('base64url'),
      createdAtMs: Date.now() - 60_000,
      expiresAtMs: Date.now() + 3_600_000,
    };

    const legacySecret = new Uint8Array(32).fill(9);
    const shapeSetups: Array<{
      label: string;
      mode: 'plain' | 'e2ee';
      historical?: boolean;
      persist: (persistence: typeof import('@/persistence')) => Promise<void>;
      // Authoritative persisted credential shape inputs for the resolver.
      encryption: null | { type: 'legacy'; secret: Uint8Array } | { type: 'dataKey'; machineKey: Uint8Array };
    }> = [
      {
        label: 'token-only', mode: 'plain',
        persist: (persistence) => persistence.writeCredentialsTokenOnly({ token: 'token-only-1' }),
        encryption: null,
      },
      {
        label: 'data-key', mode: 'e2ee',
        persist: async (persistence) => {
          const machineKey = new Uint8Array(32).fill(7);
          await persistence.writeCredentialsDataKey({
            publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
            machineKey,
            token: 'token-1',
          });
        },
        encryption: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
      },
      {
        label: 'legacy-secret', mode: 'e2ee',
        persist: (persistence) =>
          persistence.writeCredentialsLegacy({ secret: legacySecret, token: 'token-1' }),
        encryption: { type: 'legacy', secret: legacySecret },
      },
      {
        label: 'plain-retained-history', mode: 'plain',
        historical: true,
        persist: (persistence) => persistence.writeCredentialsLegacy({ secret: legacySecret, token: 'token-1' }),
        encryption: { type: 'legacy', secret: legacySecret },
      },
      {
        label: 'plain-active-keys', mode: 'plain',
        persist: (persistence) => persistence.writeCredentialsLegacy({ secret: legacySecret, token: 'token-1' }),
        encryption: { type: 'legacy', secret: legacySecret },
      },
    ];

    for (const setup of shapeSetups) {
      await withTempDir(`happier-cli-terminal-auth-approval-resolver-${setup.label}-`, async (homeDir) => {
        envScope.patch({
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_SERVER_URL: 'https://api.happier.dev',
          HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined,
          HAPPIER_WEBAPP_URL: undefined,
          HAPPIER_ACTIVE_SERVER_ID: undefined,
        });

        const configMod = await import('@/configuration');
        configMod.reloadConfiguration();
        const persistence = await import('@/persistence');
        await setup.persist(persistence);
        if (setup.historical) {
          // A′: build retained history through the canonical credential serializer.
          const credentials = await persistence.readStoredCredentialsForServerId(configMod.configuration.activeServerId);
          if (!credentials) throw new Error('Test setup invariant: retained credentials must exist');
          const historicalCredentials = { ...credentials, accountE2eeCustody: 'historical' as const };
          await persistence.writeStoredCredentialsForServerId(configMod.configuration.activeServerId, historicalCredentials);
        }
        mockGet.mockResolvedValue({ status: 200, data: currentness(setup.mode, setup.encryption?.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(setup.encryption.secret) : setup.encryption?.machineKey) });

        // The GET authenticates the reported mode; local custody admits plain.
        const expectedVariant = resolveTerminalProvisioningVariantV2({
          encryptionMode: setup.mode,
        });

        mockPost.mockResolvedValueOnce({ status: 200, data: {} });
        const approval = await import('./terminalAuthApproval');
        const result = await approval.approveTerminalAuthRequest({
          publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
          pairing,
          supportsTokenOnly: true,
        }).then(
          () => ({ posted: true }),
          (error: unknown) => ({ posted: false, error }),
        );

        if (setup.mode === 'plain' && setup.encryption && !setup.historical) {
          expect(result).toMatchObject({ posted: false, error: { code: 'account_mode_downgrade_unverified', canTryAgain: false } });
          expect(mockPost).not.toHaveBeenCalled();
          mockPost.mockReset();
          vi.resetModules();
          return;
        }
        expect(result).toEqual({ posted: true });
        const body = mockPost.mock.calls[0]?.[1] as { response?: string; responseKind?: string } | undefined;
        expect(body?.responseKind).toBe(expectedVariant);
        const opened = openTerminalProvisioningV3Response({
          payload: new Uint8Array(Buffer.from(String(body?.response), 'base64')),
          recipientSecretKeyOrSeed: terminalKeypair.secretKey,
          terminalEphemeralPublicKey: terminalKeypair.publicKey,
          pairingSecret,
          createdAtMs: pairing.createdAtMs,
          expiresAtMs: pairing.expiresAtMs,
          nowMs: Date.now(),
        });
        if (expectedVariant === 'tokenOnly') {
          expect(opened).toEqual({ type: 'tokenOnly' });
        } else {
          const encryption = setup.encryption;
          if (!encryption) throw new Error('Test setup invariant: e2ee variant requires encryption material');
          const expectedKey = encryption.type === 'legacy'
            ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret)
            : encryption.machineKey;
          expect(opened).toEqual({ type: 'dataKey', key: expectedKey });
        }
        mockPost.mockReset();
        vi.resetModules();
      });
    }
  });
});
