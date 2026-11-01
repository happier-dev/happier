import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  openConnectedServiceCredentialCiphertext,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnSpy,
  };
});

import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { computeClaudeCodeCredentialSafeTokenFingerprint } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';

const credentials = {
  token: 'happy-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
} satisfies Credentials;

function legacySecret(): Uint8Array {
  if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
  return credentials.encryption.secret;
}

describe('ConnectedServiceRefreshCoordinator.refreshClaudeSubscriptionTokensForBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    spawnSpy.mockReset();
    invalidateConnectedServiceAccountMode();
  });

  function mockMissingKeychainWithSuccessfulWrites(): void {
    spawnSpy.mockImplementation((_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        if (args[0] === 'find-generic-password') {
          child.stderr.write('not found');
          child.emit('close', 44);
          return;
        }
        child.emit('close', 0);
      });
      return child;
    });
  }

  it('returns a Claude subscription setup-token as-is (no refresh, no provider call)', async () => {
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro',
      kind: 'token',
      token: { token: 'sk-ant-oat01-setup', providerAccountId: 'anthropic-acct', providerEmail: null },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => { throw new Error('must not refresh a setup-token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-acct', expiresAt: null },
      })),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 11,
      agentId: 'claude',
      sessionId: 'sess-claude-pro',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-pro' } },
      },
      materializationKey: 'sess-claude-pro',
    });

    const request = {
      sessionId: 'sess-claude-pro',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'claude-pro' },
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(request);

    expect(result).toEqual({ accessToken: 'sk-ant-oat01-setup', anthropicAccountId: 'anthropic-acct', expiresAt: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('refreshes Claude subscription OAuth and returns only the rotated access token', async () => {
    const now = 3_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'old-claude-access',
        refreshToken: 'old-claude-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    let credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const fetchMock = vi.fn(async (input: unknown) => (
      String(input).endsWith('/api/oauth/profile')
        ? {
            ok: true,
            json: async () => ({
              account: { has_claude_max: true },
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          }
        : {
            ok: true,
            json: async () => ({ access_token: 'fresh-claude-access', refresh_token: 'rotated-claude-refresh', expires_in: 3600 }),
          }
    ));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60_000 },
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'm1:d',
        credentialRevision,
      })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
        credentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        return { success: true as const, credentialRevision };
      }),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 12,
      agentId: 'claude',
      sessionId: 'sess-claude-oauth',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-oauth' } },
      },
      materializationKey: 'sess-claude-oauth',
    });

    const request = {
      sessionId: 'sess-claude-oauth',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'claude-oauth' },
      forceRefresh: true,
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(request);

    expect(result.accessToken).toBe('fresh-claude-access');
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('rotated-claude-refresh');

    // The rotated refresh token is persisted ONLY in the daemon's sealed store, never returned.
    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: legacySecret() },
      ciphertext: sealedCiphertext,
    });
    expect(opened?.value).toMatchObject({ kind: 'oauth', oauth: expect.objectContaining({ accessToken: 'fresh-claude-access', refreshToken: 'rotated-claude-refresh' }) });
  });

  it('returns the CURRENT access token without rotating when the OAuth token is still valid and forceRefresh is not set (F6)', async () => {
    const now = 4_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      // Far from expiry relative to refreshWindowMs below — the bridge must NOT rotate the single-use
      // refresh token on a cold broker cache-miss.
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'current-valid-access',
        refreshToken: 'current-refresh-MUST-NOT-ROTATE',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => { throw new Error('must not refresh a still-valid token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const acquireLease = vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 }));
    const registerSealed = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: acquireLease,
      registerConnectedServiceCredentialSealed: registerSealed,
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 13,
      agentId: 'claude',
      sessionId: 'sess-claude-valid',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-oauth' } },
      },
      materializationKey: 'sess-claude-valid',
    });

    const request = {
      sessionId: 'sess-claude-valid',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'claude-oauth' },
      forceRefresh: false,
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(request);

    expect(result).toEqual({ accessToken: 'current-valid-access', anthropicAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 });
    // No provider refresh, no lease acquisition, no rotation/persist.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(registerSealed).not.toHaveBeenCalled();
  });

  it('adopts and distributes the current OAuth token on forced retry when the failing token is not the store token', async () => {
    const now = 5_250_000;
    mockMissingKeychainWithSuccessfulWrites();
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-bridge-adopt-server-'));
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-bridge-adopt-base-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-bridge-adopt-home-'));
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'current-store-access',
        refreshToken: 'current-store-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const fetchMock = vi.fn(async () => { throw new Error('must adopt the already-rotated store token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const registerSealed = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: registerSealed,
    } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
    });
    coordinator.registerSpawnTarget({
      pid: 13,
      agentId: 'claude',
      sessionId: 'sess-claude-adopt',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-oauth' } },
      },
      materializationKey: 'sess-claude-adopt',
    });

    const request = {
      sessionId: 'sess-claude-adopt',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'claude-oauth' },
      forceRefresh: true,
      failingAccessTokenFingerprint: computeClaudeCodeCredentialSafeTokenFingerprint('older-dead-home-access'),
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(request);

    expect(result.accessToken).toBe('current-store-access');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(registerSealed).not.toHaveBeenCalled();
    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'claude-oauth',
      'claude',
      'claude-config',
    );
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('current-store-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('rotates a still-valid OAuth token when forceRefresh proves the store token itself failed (401-retry path, F6)', async () => {
    const now = 5_500_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'anthropic-acct',
        providerEmail: 'claude@example.com',
      },
    });
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    let credentialRevision = 'csr_cccccccccccccccccccccc';
    const fetchMock = vi.fn(async (input: unknown) => (
      String(input).endsWith('/api/oauth/profile')
        ? {
            ok: true,
            json: async () => ({
              account: { has_claude_max: true },
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          }
        : {
            ok: true,
            json: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }),
          }
    ));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'claude@example.com', providerAccountId: 'anthropic-acct', expiresAt: now + 60 * 60_000 },
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'm1:d',
        credentialRevision,
      })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
        credentialRevision = 'csr_dddddddddddddddddddddd';
        return { success: true as const, credentialRevision };
      }),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      ownerIdProvider: () => 'm1:d',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 14,
      agentId: 'claude',
      sessionId: 'sess-claude-rotate',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'claude-oauth' } },
      },
      materializationKey: 'sess-claude-rotate',
    });

    const request = {
      sessionId: 'sess-claude-rotate',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'claude-oauth' },
      forceRefresh: true,
      failingAccessTokenFingerprint: computeClaudeCodeCredentialSafeTokenFingerprint('stale-access'),
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(request);

    expect(result.accessToken).toBe('rotated-access');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('serves the session-owned profile and IGNORES a caller-named foreign profile (identity-only authz)', async () => {
    // The caller no longer picks which credential is served: the daemon re-resolves the CURRENT
    // binding from the live session identity. A request naming a foreign `victim-profile` must serve
    // the session's OWN `owner-profile` credential, never the victim's (R3-3 delete-caller-trust).
    const now = 6_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'owner-profile',
      kind: 'token',
      token: { token: 'owner-access', providerAccountId: 'anthropic-owner', providerEmail: null },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const getSealed = vi.fn(async (params: { profileId: string }) => {
      if (params.profileId !== 'owner-profile') throw new Error(`unexpected profile ${params.profileId}`);
      return {
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-owner', expiresAt: null },
      };
    });
    const api = { getConnectedServiceCredentialSealed: getSealed } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 101,
      agentId: 'claude',
      sessionId: 'sess-owner',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'owner-profile' } },
      },
      materializationKey: 'sess-owner',
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      sessionId: 'sess-owner',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'victim-profile' },
    });

    expect(result).toEqual({ accessToken: 'owner-access', anthropicAccountId: 'anthropic-owner', expiresAt: null });
    expect(getSealed).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'owner-profile' }));
  });

  it('rejects Claude bridge requests whose identity maps to no live runtime target (fail-closed)', async () => {
    const now = 6_050_000;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        throw new Error('must not read credentials for an unauthorized bridge call');
      }),
    } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    // No target registered for this session id.
    await expect(coordinator.refreshClaudeSubscriptionTokensForBridge({
      sessionId: 'sess-ghost',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'any-profile' },
    })).rejects.toThrow('connected_service_bridge_selection_not_authorized');
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('accepts Claude bridge requests for the session-owned group generation', async () => {
    const now = 6_100_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'active-profile',
      kind: 'token',
      token: { token: 'active-access', providerAccountId: 'anthropic-active', providerEmail: null },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-active', expiresAt: null },
      })),
    } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const selection = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      activeProfileId: 'active-profile',
      fallbackProfileId: 'fallback-profile',
      generation: 7,
    };
    coordinator.registerSpawnTarget({
      pid: 102,
      agentId: 'claude',
      sessionId: 'sess-group',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'fallback-profile',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selection]),
      },
      materializationKey: 'sess-group',
    });

    const request = {
      sessionId: 'sess-group',
      selection,
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(request);

    expect(result).toEqual({ accessToken: 'active-access', anthropicAccountId: 'anthropic-active', expiresAt: null });
  });

  it('R3-3: authorizes a callback captured at a STALE generation and serves the CURRENT active profile after a no-restart pool swap', async () => {
    // The SDK callback captured group generation 7 (active-profile-old). A no-restart pool swap moved
    // the group to generation 8 (active-profile-new); the registry reflects the new generation. The
    // callback (still sending gen 7) must NOT strand: the daemon resolves the CURRENT selection from
    // the live target and serves active-profile-new — never the caller's captured gen-7 profile.
    const now = 6_150_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'active-profile-new',
      kind: 'token',
      token: { token: 'new-gen-access', providerAccountId: 'anthropic-new', providerEmail: null },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const getSealed = vi.fn(async (params: { profileId: string }) => {
      if (params.profileId !== 'active-profile-new') throw new Error(`stale profile ${params.profileId} must not be served`);
      return {
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-new', expiresAt: null },
      };
    });
    const api = { getConnectedServiceCredentialSealed: getSealed } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const currentSelection = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      activeProfileId: 'active-profile-new',
      fallbackProfileId: 'fallback-profile',
      generation: 8,
    };
    coordinator.registerSpawnTarget({
      pid: 103,
      agentId: 'claude',
      sessionId: 'sess-swapped',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'main', profileId: 'fallback-profile' },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([currentSelection]),
      },
      materializationKey: 'sess-swapped',
    });

    const staleCallbackRequest = {
      sessionId: 'sess-swapped',
      selection: {
        kind: 'group' as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'main',
        activeProfileId: 'active-profile-old',
        fallbackProfileId: 'fallback-profile',
        generation: 7,
      },
    };

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge(staleCallbackRequest);

    expect(result).toEqual({ accessToken: 'new-gen-access', anthropicAccountId: 'anthropic-new', expiresAt: null });
    expect(getSealed).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'active-profile-new' }));
  });

  it('R3-6: authorizes a broker bridge call by its selection identity when the sessionId is synthetic', async () => {
    // OpenCode/Pi brokers run in a SHARED managed server and cannot present a per-session id — the
    // generated plugin sends a synthetic `opencode-broker:<ver>` sessionId. Authz must resolve the
    // canonical selection from a LIVE runtime target matched by the broker's stable selection identity.
    const now = 6_300_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'broker-profile',
      kind: 'token',
      token: { token: 'broker-access', providerAccountId: 'anthropic-broker', providerEmail: null },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const getSealed = vi.fn(async (params: { profileId: string }) => {
      if (params.profileId !== 'broker-profile') throw new Error(`unexpected profile ${params.profileId}`);
      return {
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-broker', expiresAt: null },
      };
    });
    const api = { getConnectedServiceCredentialSealed: getSealed } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const brokerSelectionIdentity = 'opencode|connected|broker:1|claude-subscription:broker-profile:anthropic-broker';
    coordinator.registerSpawnTarget({
      pid: 104,
      agentId: 'opencode',
      sessionId: 'sess-real-opencode',
      brokerSelectionIdentity,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'broker-profile' } },
      },
      materializationKey: 'sess-real-opencode',
    });

    // Broker sends the synthetic sessionId (never a registry hit) + its genuine selection identity.
    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      sessionId: 'opencode-broker:anthropic:1',
      brokerSelectionIdentity,
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'broker-profile' },
    });

    expect(result).toEqual({ accessToken: 'broker-access', anthropicAccountId: 'anthropic-broker', expiresAt: null });
    expect(getSealed).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'broker-profile' }));
  });

  it('R3-6: rejects a broker bridge call whose selection identity matches no live runtime target', async () => {
    const now = 6_350_000;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        throw new Error('must not read credentials for an unmatched broker identity');
      }),
    } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshClaudeSubscriptionTokensForBridge({
      sessionId: 'opencode-broker:anthropic:1',
      brokerSelectionIdentity: 'opencode|connected|broker:1|claude-subscription:ghost:none',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'ghost' },
    })).rejects.toThrow('connected_service_bridge_selection_not_authorized');
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('SEC-F1: rejects a broker bridge call that names a live VICTIM sessionId, never returning the victim token', async () => {
    // A holder of the daemon-wide scoped broker-refresh capability presents its OWN broker selection
    // identity AND a different, live victim sessionId. Authz must key EXCLUSIVELY on the broker
    // identity when it is present — the supplied sessionId must never resolve a target and hand back
    // that session's access token (cross-account bypass inside a multi-account pool).
    const now = 6_400_000;
    const victimRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'victim-profile',
      kind: 'token',
      token: { token: 'victim-access', providerAccountId: 'anthropic-victim', providerEmail: null },
    });
    const victimSealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret() },
      payload: victimRecord,
      randomBytes: (length) => randomBytes(length),
    });
    // Returns the VICTIM credential if the buggy session-first path is exercised (so a regression
    // leaks a real token and the reject assertion fails loudly).
    const getSealed = vi.fn(async () => ({
      sealed: { format: 'account_scoped_v1', ciphertext: victimSealed },
      metadata: { kind: 'token', providerEmail: null, providerAccountId: 'anthropic-victim', expiresAt: null },
    }));
    const api = { getConnectedServiceCredentialSealed: getSealed } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    // Victim: a real per-session runtime target bound to its own account.
    coordinator.registerSpawnTarget({
      pid: 201,
      agentId: 'claude',
      sessionId: 'sess-victim',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'victim-profile' } },
      },
      materializationKey: 'sess-victim',
    });
    // Attacker's own live broker target (holds a valid broker selection identity).
    const attackerIdentity = 'opencode|connected|broker:1|claude-subscription:attacker-profile:anthropic-attacker';
    coordinator.registerSpawnTarget({
      pid: 202,
      agentId: 'opencode',
      sessionId: 'sess-attacker',
      brokerSelectionIdentity: attackerIdentity,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'attacker-profile' } },
      },
      materializationKey: 'sess-attacker',
    });

    await expect(coordinator.refreshClaudeSubscriptionTokensForBridge({
      sessionId: 'sess-victim',
      brokerSelectionIdentity: attackerIdentity,
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'victim-profile' },
    })).rejects.toThrow('connected_service_bridge_selection_not_authorized');
    // Fail-closed: no credential is ever read for the mismatched pair.
    expect(getSealed).not.toHaveBeenCalled();
  });

  it('SEC-F1: a ghost broker identity does NOT fall back to a live victim sessionId', async () => {
    // The broker identity resolves to no live target; the OLD session-first ordering would then
    // resolve the supplied victim sessionId and leak its token. When a broker identity is asserted it
    // is authoritative — an unmatched identity fails closed and never consults the sessionId.
    const now = 6_450_000;
    const getSealed = vi.fn(async () => {
      throw new Error('must not read credentials when the broker identity does not match');
    });
    const api = { getConnectedServiceCredentialSealed: getSealed } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 211,
      agentId: 'claude',
      sessionId: 'sess-victim',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'victim-profile' } },
      },
      materializationKey: 'sess-victim',
    });

    await expect(coordinator.refreshClaudeSubscriptionTokensForBridge({
      sessionId: 'sess-victim',
      brokerSelectionIdentity: 'opencode|connected|broker:1|claude-subscription:ghost:none',
      selection: { kind: 'profile' as const, serviceId: 'claude-subscription' as const, profileId: 'victim-profile' },
    })).rejects.toThrow('connected_service_bridge_selection_not_authorized');
    expect(getSealed).not.toHaveBeenCalled();
  });

  it('rejects Claude bridge requests with a stale group generation for the session', async () => {
    const now = 6_200_000;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        throw new Error('must not read credentials for stale bridge selections');
      }),
    } as unknown as ApiClient;
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'm1',
      activeServerDir: '/tmp/x',
      baseDir: '/tmp/y',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const currentSelection = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'main',
      activeProfileId: 'active-profile',
      fallbackProfileId: 'fallback-profile',
      generation: 8,
    };
    coordinator.registerSpawnTarget({
      pid: 105,
      agentId: 'claude',
      sessionId: 'sess-stale',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'fallback-profile',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([currentSelection]),
      },
      materializationKey: 'sess-stale',
    });

    // A completely UNRELATED session id (no live target) is still rejected fail-closed even though a
    // stale-generation caller for a KNOWN session now succeeds (see the R3-3 case above).
    const unauthorizedRequest = {
      sessionId: 'sess-unknown',
      selection: { ...currentSelection, generation: 7 },
    };

    await expect(coordinator.refreshClaudeSubscriptionTokensForBridge(unauthorizedRequest))
      .rejects.toThrow('connected_service_bridge_selection_not_authorized');
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });
});
