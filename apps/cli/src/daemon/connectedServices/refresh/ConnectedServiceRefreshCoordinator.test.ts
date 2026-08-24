import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { openConnectedServiceCredentialCiphertext } from '@happier-dev/protocol';
import { ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { writeClaudeCodeCredentialsFile } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';
import { resolveClaudeConnectedServiceStableConfigDir } from '@/backends/claude/connectedServices/resolveClaudeConnectedServiceStableAuthDir';
import {
  classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh,
  ConnectedServiceRefreshCoordinator,
} from './ConnectedServiceRefreshCoordinator';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';
import { buildDefaultConnectedServiceCredentialLifecycleDescriptor } from '../credentials/lifecycleTypes';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { computeConnectedServiceAccessTokenFingerprint } from './credentialFreshness/tokenFingerprint';

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

function resolveCodexHomeForMaterialization(baseDir: string, materializationKey: string): string {
  return join(baseDir, normalizeMaterializationKeyForPath(materializationKey), 'codex', 'codex-home');
}

type ExternalCredentialUpdateInput = Parameters<
  ConnectedServiceRefreshCoordinator['handleExternalCredentialUpdate']
>[0];

function revisionedExternalCredentialUpdate<
  const ServiceId extends ExternalCredentialUpdateInput['serviceId'],
>(
  serviceId: ServiceId,
  profileId: string,
): ExternalCredentialUpdateInput & Readonly<{ serviceId: ServiceId }> {
  return {
    serviceId,
    profileId,
    credentialBoundary: {
      status: 'present',
      revisionSemantics: 'revisioned',
      credentialRevision: `csr_${'a'.repeat(22)}`,
    },
    executionAuthority: 'passive_projection',
  };
}

describe('ConnectedServiceRefreshCoordinator', () => {
  beforeEach(() => {
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
  });

afterEach(() => {
    spawnSpy.mockReset();
  });

  it('keeps provider-specific materialization diagnostic codes out of the generic refresh coordinator', async () => {
    const source = await readFile(new URL('./ConnectedServiceRefreshCoordinator.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('claude_subscription_');
    expect(source).not.toContain('resolveMissingClaude');
    expect(source).not.toContain('missing_claude_code_scope');
  });

  it('classifies materialization diagnostics without turning local runtime-home failures into provider 403', () => {
    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_missing_claude_code_scope',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_required_scope',
      credentialRefreshFailure: {
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      },
    })).toEqual({
      category: 'provider_403',
      providerStatus: 403,
      providerErrorCode: 'claude_subscription_missing_claude_code_scope',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'credential_file_write_failed',
    })).toEqual({
      category: 'unknown',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_access_token',
      credentialRefreshFailure: {
        category: 'missing_access_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      },
    })).toEqual({
      category: 'missing_access_token',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_refresh_token',
      credentialRefreshFailure: {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      },
    })).toEqual({
      category: 'missing_refresh_token',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_keychain_write_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'keychain_write_failed',
    })).toEqual({
      category: 'unknown',
      providerErrorCode: 'claude_subscription_native_auth_keychain_write_failed',
    });
  });

  it('refreshes an expiring openai-codex credential and re-materializes for active spawn targets', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

	    const api = {
	      getConnectedServiceCredentialSealed: vi.fn(async () => ({
	        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
	        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
	      })),
	      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
	      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
	        sealedCiphertext = params.sealed.ciphertext;
	      }),
	      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
	    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

	    const fetchMock = vi.fn(async () => ({
	      ok: true,
	      json: async () => ({
	        access_token: 'new-access',
	        refresh_token: 'new-refresh',
	        id_token: 'new-id',
	        expires_in: 3600,
	      }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      logRefreshDiagnostic: vi.fn(),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-1');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: {
        v: 1,
        status: 'connected',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshSuccessAt: now,
      },
    });
  });

  it('refreshes plaintext credentials through the plaintext credential endpoint', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-plain-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-plain-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    let credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ credentialRevision, content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000, ownerId: 'machine-scope-preserve', credentialRevision: 'csr_abcdefghijklmnopqrstuv' })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
        credentialRevision = 'csr_1234567890123456789012';
        return { success: true as const, credentialRevision };
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-plain',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-plain',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(storedRecord.oauth?.accessToken).toBe('new-access');

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-plain');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('fails closed before lease or provider I/O when a legacy-unfenced credential needs refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-legacy-unfenced-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-legacy-unfenced-'));
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const acquireConnectedServiceRefreshLease = vi.fn();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'legacy_unfenced' as const,
        credentialRevision: null,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease,
    } as unknown as ApiClient;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      machineIdProvider: () => 'machine-legacy-unfenced',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toMatchObject({
      status: 'lease_not_acquired',
      credential: null,
      diagnostic: { status: 'lease_not_acquired' },
    });
    expect(acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to plaintext credentials when the account-mode probe errors', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-plain-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-plain-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-plain-fallback',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-plain-fallback',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(storedRecord.oauth?.accessToken).toBe('new-access');

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-plain-fallback');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('falls back to sealed credentials when the account-mode probe errors and plaintext read fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-sealed-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-sealed-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload: storedRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw new Error('plain read failed');
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
        const opened = openConnectedServiceCredentialCiphertext({
          material: { type: 'legacy', secret: legacySecret },
          ciphertext: params.sealed.ciphertext,
        });
        if (!opened?.value) throw new Error('expected opened record');
        storedRecord = ConnectedServiceCredentialRecordV1Schema.parse(opened.value);
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-sealed-fallback',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-sealed-fallback',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
    expect(storedRecord.oauth?.accessToken).toBe('new-access');

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-sealed-fallback');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('uses active account settings when refresh re-materializes Codex auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-refresh-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      // Canonical group state matches the target's snapshot (active 'backup' at generation 7).
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 7,
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sourceCodexHome;
    try {
      const coordinatorParams = {
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
        accountSettingsProvider: () => ({
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1,
            defaults: {
              configMode: 'isolated',
              stateMode: 'isolated',
            },
            byAgentId: {},
            acknowledgedRisksByAgentId: {},
          },
        }),
        processEnv: process.env,
      };
      const coordinator = new ConnectedServiceRefreshCoordinator(coordinatorParams);

      coordinator.registerSpawnTarget({
        pid: 123,
        agentId: 'codex',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
        },
        materializationKey: 'session-1',
      });

      await coordinator.tickOnce();

      const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-1');
      const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
      expect(auth.access_token).toBe('new-access');
      await expect(lstat(join(codexHome, 'config.toml'))).rejects.toThrow();
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it('invokes onAuthUpdated callback with affected targets after refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

	    const api = {
	      getConnectedServiceCredentialSealed: vi.fn(async () => ({
	        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
	        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
	      })),
	      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
	      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
	        sealedCiphertext = params.sealed.ciphertext;
	      }),
	    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

	    const fetchMock = vi.fn(async () => ({
	      ok: true,
	      json: async () => ({
	        access_token: 'new-access',
	        refresh_token: 'new-refresh',
	        id_token: 'new-id',
	        expires_in: 3600,
	      }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'pi',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'pi' })],
    }));
  });

  it('rematerializes affected local targets when an external credential update is observed', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'reconnected-access',
        refreshToken: 'reconnected-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'openai-codex'; profileId: string }>) => Promise<void>;
    };
    expect(externalUpdate.handleExternalCredentialUpdate).toBeTypeOf('function');

    await externalUpdate.handleExternalCredentialUpdate!(
      revisionedExternalCredentialUpdate('openai-codex', 'work'),
    );

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-openai');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('reconnected-access');
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
      mutation: 'replaced',
    }));
  });

  it('routes credential deletion directly to lifecycle invalidation without resolving the deleted credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-delete-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-delete-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        throw new Error('deleted credential must not be resolved');
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => 1_000_000,
      onAuthUpdated,
    });
    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });

    await coordinator.handleExternalCredentialUpdate({
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialBoundary: { status: 'absent' },
      executionAuthority: 'passive_projection',
    });

    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 456, agentId: 'codex' })],
      credentialRevision: null,
      mutation: 'deleted',
      trigger: 'reconnect_propagation',
    });
  });

  it('applies replacement lifecycle policy even for passive projection reconciliation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-passive-replace-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-passive-replace-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'passive-replacement',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        credentialRevision: `csr_${'a'.repeat(22)}`,
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });
    coordinator.registerSpawnTarget({
      pid: 457,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });

    await coordinator.handleExternalCredentialUpdate(
      revisionedExternalCredentialUpdate('openai-codex', 'work'),
    );

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      mutation: 'replaced',
      affectedTargets: [expect.objectContaining({ pid: 457 })],
    }));
  });

  it('rematerializes into the live identity root instead of an orphan sha256 root for identity-keyed targets (RD-MAT-6)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-identity-root-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-identity-root-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    // The spawn registers `materializationKey = identity.id` (csm_*). The session reads
    // `<baseDir>/<identity.id>/codex/...`; a rematerialization that drops the identity falls back
    // to sha256(key) and writes fresh credentials into an orphan root no session ever reads.
    const identityId = `csm_${'a'.repeat(32)}`;
    coordinator.registerSpawnTarget({
      pid: 124,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: identityId,
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'openai-codex'; profileId: string }>) => Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate!(
      revisionedExternalCredentialUpdate('openai-codex', 'work'),
    );

    const liveIdentityHome = join(baseDir, identityId, 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(liveIdentityHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('rotated-access');
    // No orphan sha256(csm_*) root may be created for an identity-keyed target.
    const orphanHome = resolveCodexHomeForMaterialization(baseDir, identityId);
    await expect(lstat(orphanHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rematerializes with the tracked session directory so Claude workspace trust targets the session cwd (RD-MAT-6)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-session-dir-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-session-dir-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-'));

    // The user's own home carries the trust grant for the session directory; the refresh-driven
    // rematerialization must project it into the target home FOR THAT DIRECTORY — not for the
    // daemon's cwd, which is what a sessionDirectory-less rematerialization falls back to.
    await writeFile(join(sourceHomeDir, '.claude.json'), JSON.stringify({
      projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
    }));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'trusted-access',
        refreshToken: 'trusted-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-trust',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>) => Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate!(
      revisionedExternalCredentialUpdate('claude-subscription', 'work'),
    );

    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    const rootConfig = JSON.parse(await readFile(join(stableConfigDir, '.claude.json'), 'utf8'));
    expect(rootConfig.projects?.[sessionDirectory]).toMatchObject({ hasTrustDialogAccepted: true });
  });

  it('rematerializes active Claude homes after a runtime-auth forced refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      // Far outside the scheduled refresh window: this must still rotate and rematerialize because
      // provider 401 proof is stronger than source-side expiry metadata.
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access',
        refresh_token: 'runtime-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('runtime-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(credential.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile', 'user:sessions:claude_code']);
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 125, agentId: 'claude' })],
      credentialRevision: 'csr_0000000000000000000001',
      trigger: 'refresh_triggered_restart',
    });
  });

  it('repairs a stale live Claude home even when the store credential is outside the refresh window', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-home-freshness-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-home-freshness-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-freshness-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-home-freshness-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'store-fresh-access',
        refreshToken: 'store-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('store refresh should not run');
    }) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });
    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-home-freshness',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate(input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>): Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate(
      revisionedExternalCredentialUpdate('claude-subscription', 'work'),
    );
    onAuthUpdated.mockClear();

    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: stableConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'stale-home-access',
          expiresAt: now + 30_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    await coordinator.tickOnce();

    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('store-fresh-access');
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 125, agentId: 'claude' })],
      credentialRevision: null,
      trigger: 'refresh_triggered_restart',
    });
  });

  it('consults the injected lifecycle descriptor materializedHomeMaintenance hook, not a hardcoded provider (RR-9)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-home-hook-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-home-hook-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-hook-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-home-hook-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'store-fresh-access',
        refreshToken: 'store-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('store refresh should not run'); }) as unknown as typeof fetch);

    // A descriptor whose home-maintenance hook reports NOT stale. If the coordinator still hardcoded
    // the Claude freshness path it would detect the stale home below and distribute; consuming the
    // injected hook instead suppresses that.
    const hasStaleMaterializedHomeForBinding = vi.fn(async () => false);
    const resolveLifecycleDescriptor = vi.fn(async (agentId: 'claude') => ({
      ...buildDefaultConnectedServiceCredentialLifecycleDescriptor(agentId),
      serviceIds: ['claude-subscription'] as const,
      materializedHomeMaintenance: { hasStaleMaterializedHomeForBinding },
    }));

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
      resolveLifecycleDescriptor: resolveLifecycleDescriptor as never,
    });
    coordinator.registerSpawnTarget({
      pid: 127,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-home-hook',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate(input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>): Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate(
      revisionedExternalCredentialUpdate('claude-subscription', 'work'),
    );
    onAuthUpdated.mockClear();

    const stableConfigDir = join(
      activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', 'work', 'claude', 'claude-config',
    );
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: stableConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'stale-home-access',
          expiresAt: now + 30_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    await coordinator.tickOnce();

    expect(hasStaleMaterializedHomeForBinding).toHaveBeenCalledWith(
      expect.objectContaining({ binding: { serviceId: 'claude-subscription', profileId: 'work' } }),
    );
    expect(onAuthUpdated).not.toHaveBeenCalled();
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('stale-home-access');
  });

  it('redistributes a clock-valid Claude home when its access token differs from the store credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-home-fingerprint-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-home-fingerprint-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-fingerprint-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-home-fingerprint-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'store-fresh-access',
        refreshToken: 'store-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('store refresh should not run');
    }) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });
    coordinator.registerSpawnTarget({
      pid: 126,
      agentId: 'claude',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-home-fingerprint',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate(input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>): Promise<void>;
    };
    await externalUpdate.handleExternalCredentialUpdate(
      revisionedExternalCredentialUpdate('claude-subscription', 'work'),
    );
    onAuthUpdated.mockClear();

    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: stableConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'old-home-access',
          expiresAt: now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    await coordinator.tickOnce();

    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('store-fresh-access');
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 126, agentId: 'claude' })],
      credentialRevision: null,
      trigger: 'refresh_triggered_restart',
    });
  });

  // The shared group home is OWNED by the group's active profile. A refresh cycle for any other
  // member binding must neither treat the active token as stale nor write its own credential into
  // the shared home (live incident 2026-07-08: member-vs-active fingerprint confusion caused a
  // cross-account clobber of the pool home plus a 30s restart loop).
  async function buildGroupHomeOwnershipHarness() {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-owner-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-group-owner-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-group-owner-'));
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'happier-connected-services-project-group-owner-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const buildProfileRecord = (profileId: string, accessToken: string) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId,
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken,
        refreshToken: `${profileId}-refresh`,
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: `acct-${profileId}`,
        providerEmail: `${profileId}@example.com`,
      },
    });
    const sealedByProfileId = new Map<string, string>([
      ['workA', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: buildProfileRecord('workA', 'active-access'),
        randomBytes: (length) => randomBytes(length),
      })],
      ['workB', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: buildProfileRecord('workB', 'member-access'),
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    let canonicalActiveProfileId = 'workA';
    let canonicalGeneration = 4;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (input: { profileId: string }) => {
        const ciphertext = sealedByProfileId.get(input.profileId);
        if (!ciphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: `${input.profileId}@example.com`,
            providerAccountId: `acct-${input.profileId}`,
            expiresAt: now + 60 * 60_000,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      // Round-trip: rotations persist back into the sealed store so redistribution reads the
      // FRESH record (the live daemon's store behaves this way).
      registerConnectedServiceCredentialSealed: vi.fn(async (input: { profileId: string; sealed: { ciphertext: string } }) => {
        sealedByProfileId.set(input.profileId, input.sealed.ciphertext);
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
      // Canonical group state (server truth): active profile is workA at generation 4.
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'claude-subscription',
        groupId: 'pool',
        activeProfileId: canonicalActiveProfileId,
        generation: canonicalGeneration,
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('store refresh should not run');
    }) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });
    // Target A: session spawned when the canonical active (workA) matched its snapshot.
    const selectionA = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'pool',
      activeProfileId: 'workA',
      fallbackProfileId: 'workB',
      generation: 4,
    };
    coordinator.registerSpawnTarget({
      pid: 127,
      agentId: 'claude',
      sessionId: 'session-group-owner-a',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'workA',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selectionA]),
      },
      materializationKey: 'session-claude-group-owner-a',
    });
    // Target B: session respawned with a STALE snapshot claiming workB is active at an older
    // generation — the divergent-snapshot shape from the 2026-07-08 live restart-loop incident.
    const selectionB = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'pool',
      activeProfileId: 'workB',
      fallbackProfileId: 'workA',
      generation: 3,
    };
    coordinator.registerSpawnTarget({
      pid: 128,
      agentId: 'claude',
      sessionId: 'session-group-owner-b',
      sessionDirectory,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'workB',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selectionB]),
      },
      materializationKey: 'session-claude-group-owner-b',
    });

    const groupConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'workB',
      selection: { ...selectionA, record: null as never, policy: null },
    });
    if (!groupConfigDir) throw new Error('fixture: group config dir must resolve');

    return {
      coordinator,
      onAuthUpdated,
      groupConfigDir,
      now,
      api,
      setCanonicalGroupState(activeProfileId: string, generation: number) {
        canonicalActiveProfileId = activeProfileId;
        canonicalGeneration = generation;
      },
    };
  }

  it('distributes a spawn-preflight rotation to registered targets (RR-1: rotate+distribute is one transaction)', async () => {
    const harness = await buildGroupHomeOwnershipHarness();

    // Group home holds the current active token; the ACTIVE profile then rotates via a
    // spawn-preflight forced refresh. Distribution must be BY CONSTRUCTION on the single
    // 'refreshed' completion path — a preflight rotation that skipped distribution left group
    // siblings holding the superseded (murdered) token until the next scheduler tick.
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'active-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const result = await harness.coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'claude-subscription',
      profileId: 'workA',
      force: true,
    });

    expect(result.status).toBe('refreshed');
    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('rotated-access');
    expect(harness.onAuthUpdated).toHaveBeenCalled();
  });

  it('lets a respawn preflight adopt an already-persisted rotation while its distribution is waiting for that respawn', async () => {
    const harness = await buildGroupHomeOwnershipHarness();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    let releaseDistribution!: () => void;
    const distributionReleased = new Promise<void>((resolve) => {
      releaseDistribution = resolve;
    });
    let observeDistributionStarted!: () => void;
    const distributionStarted = new Promise<void>((resolve) => {
      observeDistributionStarted = resolve;
    });
    harness.onAuthUpdated.mockImplementation(async () => {
      observeDistributionStarted();
      await distributionReleased;
    });

    const distributionOwner = harness.coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'claude-subscription',
      profileId: 'workA',
      force: true,
    });

    try {
      await distributionStarted;
      let respawnPreflightResult: Awaited<ReturnType<
        typeof harness.coordinator.refreshConnectedServiceCredentialForSpawnPreflight
      >> | null = null;
      void harness.coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
        serviceId: 'claude-subscription',
        profileId: 'workA',
        force: true,
      }).then((result) => {
        respawnPreflightResult = result;
      });

      await expect.poll(() => respawnPreflightResult, { timeout: 2_000 }).toMatchObject({
        status: 'refreshed',
        credential: expect.objectContaining({
          oauth: expect.objectContaining({ accessToken: 'rotated-access' }),
        }),
      });
    } finally {
      releaseDistribution();
      await distributionOwner;
    }

    expect(harness.onAuthUpdated).toHaveBeenCalledTimes(1);
  });

  it('reports a successful old-member refresh as superseded when the session materializes current group truth', async () => {
    const harness = await buildGroupHomeOwnershipHarness();
    harness.setCanonicalGroupState('workB', 5);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-old-member-access',
        refresh_token: 'rotated-old-member-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const result = await harness.coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'workA',
      sessionId: 'session-group-owner-a',
    });
    expect(result).toMatchObject({
      status: 'refreshed',
      runtimeAuthDisposition: 'superseded_by_current_group',
    });
  });

  it('keeps a shared group home stable across divergent-snapshot member sessions (no clobber, no restart loop)', async () => {
    const harness = await buildGroupHomeOwnershipHarness();

    // Group home holds the CANONICAL active profile's current token — correct content.
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'active-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    // Two refresh cycles: with a stale-snapshot session (claiming workB is active) present, the
    // pre-fix corridor rewrote the home to the snapshot account and requested a restart EVERY
    // cycle — the 2026-07-08 live restart loop. Canonical ownership must keep it untouched.
    await harness.coordinator.tickOnce();
    await harness.coordinator.tickOnce();

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('active-access');
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('repairs a stale shared group home with the CANONICAL active credential exactly once', async () => {
    const harness = await buildGroupHomeOwnershipHarness();

    // Group home holds a dead token matching NEITHER canonical active nor any snapshot.
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'dead-old-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    await harness.coordinator.tickOnce();

    // The repair must write the group's CANONICAL active credential — never a snapshot's — and
    // must converge in ONE repair (no ping-pong between divergent-snapshot sessions).
    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('active-access');
    expect(harness.onAuthUpdated).toHaveBeenCalledTimes(1);

    // A subsequent cycle must see the repaired home as fresh — no further writes or restarts.
    harness.onAuthUpdated.mockClear();
    await harness.coordinator.tickOnce();
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('uses the canonical active credential when distributing from a stale member binding', async () => {
    const harness = await buildGroupHomeOwnershipHarness();

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'dead-old-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    const rematerialize = harness.coordinator as unknown as {
      rematerializeTargetsForBindingDetailed(binding: Readonly<{
        serviceId: 'claude-subscription';
        profileId: string;
      }>): Promise<unknown>;
    };
    await rematerialize.rematerializeTargetsForBindingDetailed({
      serviceId: 'claude-subscription',
      profileId: 'workB',
    });

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('active-access');
    expect(harness.api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'workA',
    });
  });

  it('re-reads canonical group truth before a shared-home mutation', async () => {
    const harness = await buildGroupHomeOwnershipHarness();
    const coordinatorInternals = harness.coordinator as unknown as {
      resolveCanonicalGroupStateForRefresh(
        input: Readonly<{ serviceId: 'claude-subscription'; groupId: string }>,
        now: number,
      ): Promise<unknown>;
      rematerializeTargetsForBindingDetailed(binding: Readonly<{
        serviceId: 'claude-subscription';
        profileId: string;
      }>): Promise<unknown>;
    };

    await coordinatorInternals.resolveCanonicalGroupStateForRefresh({
      serviceId: 'claude-subscription',
      groupId: 'pool',
    }, harness.now);
    harness.setCanonicalGroupState('workB', 5);
    vi.mocked(harness.api.getConnectedServiceCredentialSealed).mockClear();

    await coordinatorInternals.rematerializeTargetsForBindingDetailed({
      serviceId: 'claude-subscription',
      profileId: 'workA',
    });

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('member-access');
    expect(harness.api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'workB',
    });
  });

  it('reports runtime-auth refresh as failed when the failing active Claude home cannot be rematerialized', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-blocked-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access-without-claude-code',
        refresh_token: 'runtime-refresh',
        // Missing user:sessions:claude_code must block active-home rematerialization.
        scope: 'user:inference user:profile',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const adoptCredentialRevision = vi.spyOn(runtimeRegistry, 'adoptCredentialRevisionForProfile');
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
      runtimeRegistry,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionId: 'sess_1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      sessionId: 'sess_1',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'refresh_failed',
      diagnostic: expect.objectContaining({
        serviceId: 'claude-subscription',
        profileId: 'work',
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(adoptCredentialRevision).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
  });

  it('reports runtime-auth refresh as failed when the requested live session has no registered rematerialization target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-missing-target-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-missing-target-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now - 1_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'codex',
      sessionId: 'sess_other',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'primary' } },
      },
      materializationKey: 'session-codex-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_missing',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'refresh_failed',
      diagnostic: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'primary',
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
      }),
    }));
    // RR-1: the rotation itself distributes BY CONSTRUCTION, so the OTHER registered target for
    // this binding is redistributed + notified even though the REQUESTED session (which has no
    // registered target) still gets the failure result above.
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ serviceId: 'openai-codex', profileId: 'primary' }),
      trigger: 'refresh_triggered_restart',
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      health: expect.objectContaining({
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshFailureKind: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
      }),
    });
  });

  it('does not restart affected Claude targets when external credential rematerialization is blocking', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'claude-subscription'; profileId: string }>) => Promise<void>;
    };
    expect(externalUpdate.handleExternalCredentialUpdate).toBeTypeOf('function');

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await externalUpdate.handleExternalCredentialUpdate!(
        revisionedExternalCredentialUpdate('claude-subscription', 'work'),
      );
      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart',
        expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'work',
          agentId: 'claude',
          materializationCode: 'claude_subscription_missing_claude_code_scope',
        }),
      );
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('narrow-refresh');
  });

  it('does not restart a multi-service target when any rematerialized binding is blocking', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-multi-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-multi-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    const codexRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'codex-acct',
        providerEmail: null,
      },
    });
    const claudeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'claude-narrow-access',
        refreshToken: 'claude-narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });
    const seal = (payload: typeof codexRecord | typeof claudeRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByKey = new Map([
      ['openai-codex/work', seal(codexRecord)],
      ['claude-subscription/claude-work', seal(claudeRecord)],
    ]);
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = ciphertextByKey.get(`${params.serviceId}/${params.profileId}`);
        if (!ciphertext) return null;
        const record = params.serviceId === 'openai-codex' ? codexRecord : claudeRecord;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: null,
            providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
            expiresAt: record.expiresAt,
          },
        };
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
          'claude-subscription': { source: 'connected', profileId: 'claude-work' },
        },
      },
      materializationKey: 'session-claude',
    });

    const externalUpdate = coordinator as unknown as {
      handleExternalCredentialUpdate?: (input: Readonly<{ serviceId: 'openai-codex'; profileId: string }>) => Promise<void>;
    };
    expect(externalUpdate.handleExternalCredentialUpdate).toBeTypeOf('function');

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await externalUpdate.handleExternalCredentialUpdate!(
        revisionedExternalCredentialUpdate('openai-codex', 'work'),
      );
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('claude-narrow-refresh');
  });

  it('clears a stale id token but preserves friendly account email when the refresh response omits id_token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'stale-id-token',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'known-user@example.test',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'known-user@example.test', providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: sealedCiphertext,
    });
    expect(opened?.value).toMatchObject({
      kind: 'oauth',
      oauth: expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: null,
        providerEmail: 'known-user@example.test',
      }),
    });
  });

  it('directly refreshes a Codex group active profile and updates only the group-home bridge response', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 90_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 90_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      // Canonical group state matches the bridge request and registered target.
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 7,
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const selection = {
      kind: 'group' as const,
      serviceId: 'openai-codex' as const,
      groupId: 'main',
      activeProfileId: 'backup',
      fallbackProfileId: 'work',
      generation: 7,
      credentialRevision: 'csr_0000000000000000000000',
    };
    coordinator.registerSpawnTarget({
      pid: 122,
      agentId: 'codex',
      sessionId: 'happy-session-bridge-group',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'work',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selection]),
      },
      materializationKey: 'openai-codex-refresh-backup',
    });
    const request = {
      sessionId: 'happy-session-bridge-group',
      selection,
      chatgptPlanType: 'plus',
      // Exercise the rotation path explicitly (F6: rotation now requires near-expiry OR force).
      forceRefresh: true,
    };
    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);

    expect(result).toEqual({
      accessToken: 'new-access',
      chatgptAccountId: 'chatgpt-account',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_0000000000000000000001',
    });
    expect(result).not.toHaveProperty('refreshToken');
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
      leaseMs: 30_000,
      expectedCredentialRevision: expect.any(String),
    });

    const opened = openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: sealedCiphertext,
    });
    expect(opened?.value).toMatchObject({
      kind: 'oauth',
      oauth: expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'rotated-refresh',
      }),
    });

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'openai-codex-refresh-backup');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
    expect(auth.refresh_token).toBe('rotated-refresh');
  });

  it('refreshes Codex bridge tokens into the registered target materialized home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-target-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-bridge-target-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 90_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 90_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'happy-session-bridge',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-bridge',
    });

    const request = {
      sessionId: 'happy-session-bridge',
      selection: {
        kind: 'profile' as const,
        serviceId: 'openai-codex' as const,
        profileId: 'work',
      },
      chatgptPlanType: 'team',
      forceRefresh: true,
    };

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);

    expect(result).toEqual({
      accessToken: 'new-access',
      chatgptAccountId: 'chatgpt-account',
      chatgptPlanType: 'team',
      credentialRevision: 'csr_0000000000000000000001',
    });
    const activeCodexHome = resolveCodexHomeForMaterialization(baseDir, 'session-bridge');
    const activeAuth = JSON.parse(await readFile(join(activeCodexHome, 'auth.json'), 'utf8'));
    expect(activeAuth.access_token).toBe('new-access');
    expect(activeAuth.refresh_token).toBe('rotated-refresh');
    await expect(lstat(resolveCodexHomeForMaterialization(baseDir, 'openai-codex-refresh-work'))).rejects.toThrow();
  });

  it('returns the CURRENT Codex access token without rotating when valid and forceRefresh is not set (F6)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-noforce-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-bridge-noforce-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      // Far from expiry vs refreshWindowMs below — must NOT rotate the single-use refresh token.
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'current-codex-access',
        refreshToken: 'current-codex-refresh-MUST-NOT-ROTATE',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const acquireLease = vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 }));
    const registerSealed = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: acquireLease,
      registerConnectedServiceCredentialSealed: registerSealed,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => { throw new Error('must not refresh a still-valid token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 124,
      agentId: 'codex',
      sessionId: 'happy-session-bridge-noforce',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'happy-session-bridge-noforce',
    });

    const request = {
      sessionId: 'happy-session-bridge-noforce',
      selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    };

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);

    expect(result).toEqual({
      accessToken: 'current-codex-access',
      chatgptAccountId: 'chatgpt-account',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
    // No provider refresh, no lease, no rotation/persist when the token is still valid.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(registerSealed).not.toHaveBeenCalled();
  });

  it('does not cold-cache adopt a future-dated Codex token contradicted by canonical credential health', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-health-gate-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-bridge-health-gate-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'known-invalid-access',
        refreshToken: 'recoverable-refresh',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 60 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'provider-proven-access',
        refresh_token: 'provider-proven-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'codex',
      sessionId: 'happy-session-bridge-health-gate',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'happy-session-bridge-health-gate',
    });

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      sessionId: 'happy-session-bridge-health-gate',
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    });

    expect(result.accessToken).toBe('provider-proven-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: expect.objectContaining({ status: 'connected', reconnectRequired: false }),
    });
  });

  it('adopts a newer current Codex token despite stale predecessor reauth health', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-newer-token-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-bridge-newer-token-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(20) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const now = 1_000_000;
    const currentAccessToken = 'newer-current-access';
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: currentAccessToken,
        refreshToken: 'newer-current-refresh',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'alice@example.com',
      },
    });
    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: 'alice@example.com', providerAccountId: 'chatgpt-account', expiresAt: now + 60 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => {
      throw new Error('a newer canonical token must be adopted without rotating its refresh token');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 126,
      agentId: 'codex',
      sessionId: 'happy-session-bridge-newer-token',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'happy-session-bridge-newer-token',
    });

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      sessionId: 'happy-session-bridge-newer-token',
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: true,
      failingAccessTokenFingerprint: computeConnectedServiceAccessTokenFingerprint('predecessor-access'),
    })).resolves.toEqual(expect.objectContaining({ accessToken: currentAccessToken }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('serves the session-owned Codex profile and IGNORES a caller-named foreign profile (identity-only authz)', async () => {
    // Identity-only authz: the caller cannot pick which credential is served. A request naming a
    // foreign `victim-profile` serves the session's OWN `owner-profile` token, never the victim's.
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-authz-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-bridge-authz-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(12) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'owner-profile',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'owner-codex-access',
        refreshToken: 'owner-codex-refresh',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-owner',
        providerEmail: 'owner@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const getSealed = vi.fn(async (params: { profileId: string }) => {
      if (params.profileId !== 'owner-profile') throw new Error(`foreign profile ${params.profileId} must not be read`);
      return {
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'owner@example.com', providerAccountId: 'chatgpt-owner', expiresAt: now + 60 * 60_000 },
      };
    });
    const api = {
      getConnectedServiceCredentialSealed: getSealed,
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => { throw new Error('must not rotate a valid owner token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 231,
      agentId: 'codex',
      sessionId: 'sess-owner',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'owner-profile' } },
      },
      materializationKey: 'sess-owner',
    });

    const request = {
      sessionId: 'sess-owner',
      selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'victim-profile' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    };

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);

    expect(result).toEqual({
      accessToken: 'owner-codex-access',
      chatgptAccountId: 'chatgpt-owner',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
    expect(getSealed).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'owner-profile' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('accepts Codex bridge requests for the session-owned profile binding', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-authz-ok-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-bridge-authz-ok-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(13) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'owner-profile',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'owner-codex-access',
        refreshToken: 'owner-codex-refresh',
        idToken: 'id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-owner',
        providerEmail: 'owner@example.com',
      },
    });
    const sealed = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealed },
        metadata: { kind: 'oauth', providerEmail: 'owner@example.com', providerAccountId: 'chatgpt-owner', expiresAt: now + 60 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => { throw new Error('must not rotate a valid owner token'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    coordinator.registerSpawnTarget({
      pid: 232,
      agentId: 'codex',
      sessionId: 'sess-owner',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'owner-profile' } },
      },
      materializationKey: 'sess-owner',
    });

    const request = {
      sessionId: 'sess-owner',
      selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'owner-profile' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    };
    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);

    expect(result).toEqual({
      accessToken: 'owner-codex-access',
      chatgptAccountId: 'chatgpt-owner',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('rejects Codex bridge requests from unknown sessions', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-bridge-authz-unknown-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-bridge-authz-unknown-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(14) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const now = 1_000_000;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        throw new Error('must not read credentials for unknown bridge sessions');
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 5 * 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const request = {
      sessionId: 'missing-session',
      selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'owner-profile' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    };

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge(request))
      .rejects.toThrow('connected_service_bridge_selection_not_authorized');
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('waits and re-reads credentials when another daemon owns the refresh lease for spawn preflight', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-lease-wait-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-lease-wait-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(15) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const refreshedRecord = buildConnectedServiceCredentialRecord({
      now: now + 50,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'other-daemon-access',
        refreshToken: 'other-daemon-refresh',
        idToken: 'other-daemon-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const staleCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: staleRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const refreshedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: refreshedRecord,
      randomBytes: (length) => randomBytes(length),
    });

    let credentialReads = 0;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        credentialReads += 1;
        const ciphertext = credentialReads === 1 ? staleCiphertext : refreshedCiphertext;
        const expiresAt = credentialReads === 1 ? staleRecord.expiresAt : refreshedRecord.expiresAt;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: 'user@example.com', providerAccountId: 'acct', expiresAt },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: false, leaseUntil: now + 50 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const sleepMs = vi.fn(async () => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      leaseContentionWaitMaxMs: 100,
      sleepMs,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    expect(result.credential).toMatchObject({
      kind: 'oauth',
      oauth: expect.objectContaining({ accessToken: 'other-daemon-access' }),
    });
    expect(sleepMs).toHaveBeenCalledWith(50);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(2);
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['expired', 'empty_token', 'non_oauth'] as const)(
    'does not adopt a changed but unusable %s credential after losing the refresh lease',
    async (candidateKind) => {
      const baseDir = await mkdtemp(join(tmpdir(), `happier-connected-services-refresh-lease-unusable-${candidateKind}-`));
      const activeServerDir = await mkdtemp(join(tmpdir(), `happier-connected-services-server-lease-unusable-${candidateKind}-`));
      const credentials: Credentials = {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(17) },
      };
      if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
      const now = 1_000_000;
      const staleRecord = buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: now + 10_000,
        oauth: {
          accessToken: 'stale-access',
          refreshToken: 'stale-refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: 'user@example.com',
        },
      });
      const candidateRecord = candidateKind === 'non_oauth'
        ? buildConnectedServiceCredentialRecord({
          now: now + 50,
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'token',
          token: {
            token: 'setup-token',
            providerAccountId: 'acct',
            providerEmail: 'user@example.com',
          },
        })
        : buildConnectedServiceCredentialRecord({
          now: now + 50,
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'oauth',
          expiresAt: candidateKind === 'expired' ? now - 1 : now + 3_600_000,
          oauth: {
            accessToken: candidateKind === 'empty_token' ? ' ' : 'other-daemon-access',
            refreshToken: 'other-daemon-refresh',
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: 'acct',
            providerEmail: 'user@example.com',
          },
        });
      const staleCiphertext = sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: staleRecord,
        randomBytes: (length) => randomBytes(length),
      });
      const candidateCiphertext = sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: candidateRecord,
        randomBytes: (length) => randomBytes(length),
      });
      let credentialReads = 0;
      const api = {
        getConnectedServiceCredentialSealed: vi.fn(async () => {
          credentialReads += 1;
          const record = credentialReads === 1 ? staleRecord : candidateRecord;
          return {
            sealed: {
              format: 'account_scoped_v1' as const,
              ciphertext: credentialReads === 1 ? staleCiphertext : candidateCiphertext,
            },
            metadata: {
              kind: record.kind,
              providerEmail: 'user@example.com',
              providerAccountId: 'acct',
              expiresAt: record.expiresAt,
            },
          };
        }),
        acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: false, leaseUntil: now + 50 })),
        updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
      } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      const coordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        ownerIdProvider: () => 'machine-1:daemon-a',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        leaseContentionWaitMaxMs: 100,
        sleepMs: async () => {},
        now: () => now,
      });

      const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
        serviceId: 'openai-codex',
        profileId: 'work',
      });

      expect(result.status).toBe('lease_not_acquired');
      expect(result.credential).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(api.updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
    },
  );

  it('re-reads the canonical credential after a two-controller lease handoff and never submits the consumed predecessor', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-two-controller-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-two-controller-'));
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(16) },
    };
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'predecessor-access',
        refreshToken: 'predecessor-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    let credentialRevision = 'csr_abcdefghijklmnopqrstuv';

    let resolveBothAtLease: () => void = () => {};
    const bothAtLease = new Promise<void>((resolve) => {
      resolveBothAtLease = resolve;
    });
    let leaseEntrants = 0;
    let resolveFirstPersistence: () => void = () => {};
    const firstPersistence = new Promise<void>((resolve) => {
      resolveFirstPersistence = resolve;
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async (_params: unknown) => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision,
        content: { t: 'plain' as const, v: storedRecord },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async (params: { machineId: string }) => {
        leaseEntrants += 1;
        if (leaseEntrants === 2) resolveBothAtLease();
        if (params.machineId === 'machine-a') {
          await bothAtLease;
          return {
            acquired: true,
            leaseUntil: now + 60_000,
            ownerId: 'machine-a:daemon',
            credentialRevision,
          };
        }
        await firstPersistence;
        return {
          acquired: false,
          leaseUntil: now,
          ownerId: 'machine-a:daemon',
          credentialRevision,
        };
      }),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
        credentialRevision = 'csr_bcdefghijklmnopqrstuvw';
        resolveFirstPersistence();
        return { success: true as const, credentialRevision };
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const submittedRefreshTokens: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      const refreshToken = body instanceof URLSearchParams
        ? body.get('refresh_token')
        : new URLSearchParams(String(body ?? '')).get('refresh_token');
      submittedRefreshTokens.push(refreshToken ?? '');
      if (submittedRefreshTokens.length > 1) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({ error: 'invalid_grant' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const createCoordinator = (machineId: string) => new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => machineId,
      ownerIdProvider: () => `${machineId}:daemon`,
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      leaseContentionWaitMaxMs: 100,
      sleepMs: async () => {},
      now: () => now,
    });
    const controllerA = createCoordinator('machine-a');
    const controllerB = createCoordinator('machine-b');

    const [resultA, resultB] = await Promise.all([
      controllerA.refreshConnectedServiceCredentialForQuota({
        serviceId: 'openai-codex',
        profileId: 'work',
        force: true,
      }),
      controllerB.refreshConnectedServiceCredentialForQuota({
        serviceId: 'openai-codex',
        profileId: 'work',
        force: true,
      }),
    ]);

    expect(resultA?.record?.oauth?.accessToken).toBe('rotated-access');
    expect(resultB?.record?.oauth?.accessToken).toBe('rotated-access');
    expect(submittedRefreshTokens).toEqual(['predecessor-refresh']);
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(2);
    for (const [healthUpdate] of updateConnectedServiceCredentialHealth.mock.calls) {
      expect(healthUpdate).toEqual(expect.objectContaining({
        expectedCredentialRevision: credentialRevision,
      }));
    }
  });

  it('rejects a post-persist same-token credential that moved beyond the minted revision', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-post-persist-aba-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-post-persist-aba-'));
    const now = 1_000_000;
    const sourceRevision = 'csr_abcdefghijklmnopqrstuv';
    const mintedRevision = 'csr_bcdefghijklmnopqrstuvw';
    const supersedingRevision = 'csr_cdefghijklmnopqrstuvwx';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(21) },
    };
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    let credentialReads = 0;
    const updateConnectedServiceCredentialHealth = vi.fn(async () => ({ success: true as const, credentialRevision: supersedingRevision }));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        credentialReads += 1;
        return {
          credentialRevision: credentialReads <= 2 ? sourceRevision : supersedingRevision,
          content: { t: 'plain' as const, v: storedRecord },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'machine-1:daemon-a',
        credentialRevision: sourceRevision,
      })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
        return { success: true as const, credentialRevision: mintedRevision };
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });

    expect(result.record).toBeNull();
    expect(credentialReads).toBeGreaterThanOrEqual(3);
    expect(updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
  });

  it('does not adopt a changed credential that expires while the lease is being acquired', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-lease-clock-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-lease-clock-'));
    let clock = 1_000_000;
    const initialNow = clock;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(18) },
    };
    const predecessor = buildConnectedServiceCredentialRecord({
      now: initialNow,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: initialNow + 10_000,
      oauth: {
        accessToken: 'predecessor-access',
        refreshToken: 'predecessor-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const expiredDuringLease = buildConnectedServiceCredentialRecord({
      now: initialNow + 5_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: initialNow + 15_000,
      oauth: {
        accessToken: 'intermediate-access',
        refreshToken: 'intermediate-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    let credentialReads = 0;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        credentialReads += 1;
        return {
          content: {
            t: 'plain' as const,
            v: credentialReads === 1 ? predecessor : expiredDuringLease,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => {
        clock = initialNow + 20_000;
        return { acquired: true, leaseUntil: clock + 30_000 };
      }),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const submittedRefreshTokens: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      submittedRefreshTokens.push(body instanceof URLSearchParams
        ? body.get('refresh_token') ?? ''
        : new URLSearchParams(String(body ?? '')).get('refresh_token') ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'final-access',
          refresh_token: 'final-refresh',
          expires_in: 3600,
        }),
      };
    }) as unknown as typeof fetch);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => clock,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });

    expect(result?.record?.oauth?.accessToken).toBe('final-access');
    expect(submittedRefreshTokens).toEqual(['intermediate-refresh']);
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledOnce();
  });

  it('serializes forced refreshes for the same binding inside one daemon process', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-singleflight-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-singleflight-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });
    const second = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(firstResult?.record?.oauth?.accessToken).toBe('new-access');
    expect(secondResult?.record?.oauth?.accessToken).toBe('new-access');
  });

  it('shares a forced refresh result with joiners while leaf I/O owns timeout behavior', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-singleflight-timeout-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-singleflight-timeout-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    let resolveFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let releaseFetch: () => void = () => {};
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      resolveFetchStarted();
      await fetchRelease;
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });
    await fetchStarted;
    const second = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });

    releaseFetch();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ record: expect.objectContaining({ oauth: expect.objectContaining({ accessToken: 'new-access' }) }) }),
      expect.objectContaining({ record: expect.objectContaining({ oauth: expect.objectContaining({ accessToken: 'new-access' }) }) }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a joining spawn preflight behind completion when the shared result failed to rotate a credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-join-not-needed-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-join-not-needed-'));
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'current-access',
        refreshToken: 'current-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    let releaseHealthSettlement!: () => void;
    const healthSettlementReleased = new Promise<void>((resolve) => {
      releaseHealthSettlement = resolve;
    });
    let observeHealthSettlementStarted!: () => void;
    const healthSettlementStarted = new Promise<void>((resolve) => {
      observeHealthSettlementStarted = resolve;
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {
        observeHealthSettlementStarted();
        await healthSettlementReleased;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    })) as unknown as typeof fetch);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const owner = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    await healthSettlementStarted;
    let joinerSettled = false;
    const joiner = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    }).then((result) => {
      joinerSettled = true;
      return result;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(joinerSettled).toBe(false);
    } finally {
      releaseHealthSettlement();
      await Promise.all([owner, joiner]);
    }
    await expect(Promise.all([owner, joiner])).resolves.toEqual([
      expect.objectContaining({ status: 'refresh_failed' }),
      expect.objectContaining({ status: 'refresh_failed' }),
    ]);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(1);
  });

  it('does not satisfy a forced refresh from an in-flight non-forced not-needed refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-force-class-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-force-class-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    let releaseCredentialRead: () => void = () => {};
    const credentialReadReleased = new Promise<void>((resolve) => {
      releaseCredentialRead = resolve;
    });
    let resolveCredentialReadStarted: () => void = () => {};
    const credentialReadStarted = new Promise<void>((resolve) => {
      resolveCredentialReadStarted = resolve;
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        resolveCredentialReadStarted();
        await credentialReadReleased;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'forced-access',
        refresh_token: 'forced-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    const nonForced = coordinator.tickOnce();
    await credentialReadStarted;
    const forced = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });
    releaseCredentialRead();

    const [, forcedResult] = await Promise.all([nonForced, forced]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(forcedResult?.record?.oauth?.accessToken).toBe('forced-access');
  });

  it('coalesces a concurrent forced and non-forced refresh of the same near-expiry binding into one rotation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-coalesce-rotation-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-coalesce-rotation-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    // Near-expiry inside the refresh window so the NON-forced refresh actually performs a network rotation.
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    // Each refresh-token POST rotates: rt0 -> rt1 (only the FIRST POST is honored). A second concurrent
    // POST presenting the already-consumed rt0 would mint a superseded token. We assert it never happens.
    const issuedRefreshTokens = new Set<string>();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      const tokenSuffix = issuedRefreshTokens.size + 1;
      issuedRefreshTokens.add(`rt${tokenSuffix}`);
      return {
        ok: true,
        json: async () => ({
          access_token: `access-${tokenSuffix}`,
          refresh_token: `rt${tokenSuffix}`,
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    const nonForced = coordinator.tickOnce();
    const forced = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    const [, forcedResult] = await Promise.all([nonForced, forced]);

    // Exactly ONE network rotation and ONE lease acquisition for the shared binding.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
    // The forced caller adopts the single coalesced rotation rather than racing a second one.
    expect(forcedResult.status).toBe('refreshed');
    expect(forcedResult.credential?.kind).toBe('oauth');
    expect(forcedResult.credential?.oauth?.accessToken).toBe('access-1');
  });

  it('runs a forced refresh after an in-flight forced refresh adopts the first rotation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-forced-join-forced-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-forced-join-forced-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      // Far-future expiry: a non-forced refresh would early-return not_needed; both callers here are forced.
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({ access_token: 'access-1', refresh_token: 'rt1', expires_in: 3600 }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    const second = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(firstResult.credential?.oauth?.accessToken).toBe('access-1');
    expect(secondResult.credential?.oauth?.accessToken).toBe('access-1');
  });

  it('still allows a sequential forced refresh after a prior refresh completes', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-sequential-forced-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-sequential-forced-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    let rotation = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      }
      rotation += 1;
      const current = rotation;
      return {
        ok: true,
        json: async () => ({ access_token: `access-${current}`, refresh_token: `rt${current}`, expires_in: 3600 }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const firstResult = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    const secondResult = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    // Two fully sequential forced refreshes (no overlap) each perform their own rotation.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(firstResult.credential?.oauth?.accessToken).toBe('access-1');
    expect(secondResult.credential?.oauth?.accessToken).toBe('access-2');
  });

  it('refreshes distinct bindings concurrently without cross-binding serialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-distinct-bindings-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-distinct-bindings-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const recordFor = (profileId: string) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId,
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: `old-access-${profileId}`,
        refreshToken: `rt0-${profileId}`,
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const sealedByProfile = new Map<string, string>([
      ['work', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: recordFor('work'),
        randomBytes: (length) => randomBytes(length),
      })],
      ['home', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: recordFor('home'),
        randomBytes: (length) => randomBytes(length),
      })],
    ]);

    let concurrentReads = 0;
    let maxConcurrentReads = 0;
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { profileId: string }) => {
        concurrentReads += 1;
        maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentReads -= 1;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedByProfile.get(params.profileId)! },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { profileId: string; sealed: { ciphertext: string } }) => {
        sealedByProfile.set(params.profileId, params.sealed.ciphertext);
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const [resultWork, resultHome] = await Promise.all([
      coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'work' }),
      coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'home' }),
    ]);

    expect(resultWork.status).toBe('refreshed');
    expect(resultHome.status).toBe('refreshed');
    expect(maxConcurrentReads).toBe(2);
  });

  it('propagates a refresh rejection to every coalesced joiner of the same binding', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-error-propagation-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-error-propagation-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'rt0',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('credential read exploded');
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    void sealedCiphertext;

    vi.stubGlobal('fetch', vi.fn() as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'work' });
    const second = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({ serviceId: 'claude-subscription', profileId: 'work' });

    await expect(first).rejects.toThrow('credential read exploded');
    await expect(second).rejects.toThrow('credential read exploded');
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('revision-guards missing-refresh-token health against a superseding credential', async () => {
    const now = 1_000_000;
    const leasedRevision = 'csr_abcdefghijklmnopqrstuv';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(17) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'old-access',
        refreshToken: ' ',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => ({
      error: 'connect_credential_mutation_superseded' as const,
      reason: 'revision_mismatch' as const,
      credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
    }));
    const onCredentialHealthNotification = vi.fn(async () => {});
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision: leasedRevision,
        content: { t: 'plain' as const, v: record },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'machine-1:daemon-a',
        credentialRevision: leasedRevision,
      })),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onCredentialHealthNotification,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refresh_failed');
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      expectedCredentialRevision: leasedRevision,
      health: expect.objectContaining({
        status: 'needs_reauth',
        lastRefreshFailureKind: 'missing_refresh_token',
      }),
    }));
    expect(onCredentialHealthNotification).not.toHaveBeenCalled();
  });

  it('persists reauth-required credential health for invalid provider refresh grants without raw provider bodies', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-invalid-grant-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-invalid-grant-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'secret-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'bad request',
      text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'secret-refresh-token' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const logRefreshDiagnostic = vi.fn();
    const onCredentialHealthNotification = vi.fn(async () => {
      throw new AxiosError('notification unavailable Authorization: Bearer SECRET', 'ECONNRESET', {
        method: 'post',
        url: 'https://api.example.test/health?token=SECRET',
        headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
        data: { refresh_token: 'secret-refresh-token' },
      });
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    let result: Awaited<ReturnType<ConnectedServiceRefreshCoordinator['refreshConnectedServiceCredentialForQuota']>> | undefined;
    try {
      const coordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
        logRefreshDiagnostic,
        onCredentialHealthNotification,
      } as unknown as ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]);

      const targetRegistration = {
        pid: 123,
        agentId: 'codex',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
        },
        materializationKey: 'materialization-identity-1',
        sessionId: 'happy-session-1',
      } as Parameters<ConnectedServiceRefreshCoordinator['registerSpawnTarget']>[0] & {
        sessionId: string;
      };
      coordinator.registerSpawnTarget(targetRegistration);

      result = await coordinator.refreshConnectedServiceCredentialForQuota({
        serviceId: 'openai-codex',
        profileId: 'work',
        force: true,
      });

      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to dispatch connected-service credential health notification',
        expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'work',
          status: 'refresh_failed',
          category: 'invalid_grant',
        }),
      );
      expect(debug).not.toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to dispatch connected-service credential health notification',
        expect.anything(),
      );
      const warned = JSON.stringify(warn.mock.calls);
      expect(warned).not.toContain('Bearer SECRET');
      expect(warned).not.toContain('secret-refresh-token');
      expect(warned).not.toContain('"headers"');
      expect(warned).not.toContain('"data"');
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }

    expect(result).toEqual({ record: null, reauthRequired: true });
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'invalid_grant',
        providerHttpStatus: 400,
        providerErrorCode: 'invalid_grant',
      },
    });
    expect(logRefreshDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'quota_bridge',
      status: 'refresh_failed',
      category: 'invalid_grant',
      providerStatus: 400,
      providerErrorCode: 'invalid_grant',
      expiryAgeMs: -600_000,
      refreshWindowMs: 60_000,
    }));
    expect(onCredentialHealthNotification).toHaveBeenCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        status: 'refresh_failed',
        category: 'invalid_grant',
        providerStatus: 400,
        providerErrorCode: 'invalid_grant',
      }),
      healthStatus: 'reconnect_required',
      affectedTargets: [expect.objectContaining({
        pid: 123,
        agentId: 'codex',
        sessionId: 'happy-session-1',
      })],
    }));
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('secret-refresh-token');
    expect(JSON.stringify(logRefreshDiagnostic.mock.calls)).not.toContain('secret-refresh-token');
    expect(JSON.stringify(onCredentialHealthNotification.mock.calls)).not.toContain('secret-refresh-token');
  });

  it('does not harvest a Claude Code refresh token from a materialized profile home before persisting invalid-grant health', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-claude-harvest-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-claude-harvest-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'stale-daemon-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'claude@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'work',
      selection: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'work',
        record,
      },
    });
    if (!profileClaudeConfigDir) throw new Error('expected profile config dir');
    await mkdir(profileClaudeConfigDir, { recursive: true });
    await writeFile(
      join(profileClaudeConfigDir, '.credentials.json'),
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'rotated-materialized-access',
          refreshToken: 'rotated-materialized-refresh',
          expiresAt: now + 20 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      })}\n`,
    );

    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'claude@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const refreshTokensSeen: string[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { refresh_token?: string } : {};
      refreshTokensSeen.push(body.refresh_token ?? '');
      if (body.refresh_token === 'stale-daemon-refresh') {
        return {
          ok: false,
          status: 400,
          statusText: 'bad request',
          text: async () => JSON.stringify({ error: 'invalid_grant' }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          access_token: 'recovered-claude-access',
          refresh_token: 'recovered-claude-refresh',
          expires_in: 3600,
          scope: 'user:inference user:profile user:sessions:claude_code',
          token_type: 'Bearer',
          account: { uuid: 'acct', email_address: 'claude@example.com' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const logRefreshDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      logRefreshDiagnostic,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    })).resolves.toEqual({ record: null, reauthRequired: true });

    expect(refreshTokensSeen).toEqual(['stale-daemon-refresh']);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'invalid_grant',
        providerHttpStatus: 400,
        providerErrorCode: 'invalid_grant',
      },
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('rotated-materialized-refresh');
    expect(JSON.stringify(logRefreshDiagnostic.mock.calls)).not.toContain('rotated-materialized-refresh');
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('warns when credential health persistence fails after refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-health-warn-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-health-warn-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'secret-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {
        throw new AxiosError('health write unavailable Authorization: Bearer SECRET', 'ECONNRESET', {
          method: 'post',
          url: 'https://api.example.test/health?token=SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }),
          data: { refresh_token: 'secret-refresh-token' },
        });
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'bad request',
      text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'secret-refresh-token' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const coordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
      } as unknown as ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]);

      await expect(coordinator.refreshConnectedServiceCredentialForQuota({
        serviceId: 'openai-codex',
        profileId: 'work',
        force: true,
      })).resolves.toEqual({ record: null, reauthRequired: true });

      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to update connected-service credential health after refresh',
        expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'work',
          status: 'refresh_failed',
          category: 'invalid_grant',
        }),
      );
      expect(debug).not.toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to update connected-service credential health after refresh',
        expect.anything(),
      );
      const warned = JSON.stringify(warn.mock.calls);
      expect(warned).not.toContain('Bearer SECRET');
      expect(warned).not.toContain('secret-refresh-token');
      expect(warned).not.toContain('"headers"');
      expect(warned).not.toContain('"data"');
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it('reprobes scheduled reconnect-required credentials and clears health after a successful refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-needs-reauth-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-needs-reauth-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'recoverable-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 30_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'recovered-access',
        refresh_token: 'recovered-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await expect(coordinator.tickOnce()).resolves.toBeUndefined();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: {
        v: 1,
        status: 'connected',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshSuccessAt: now,
      },
    });
  });

  it('backs off scheduled reconnect-required reprobes after a failed probe', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-needs-reauth-backoff-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-needs-reauth-backoff-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    let now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 30_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'bad request',
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const logRefreshDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      logRefreshDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow(AggregateError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 30_000;
    await expect(coordinator.tickOnce()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logRefreshDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'blocked_by_credential_health',
      reason: 'scheduled',
    }));

    now += 30_000;
    await expect(coordinator.tickOnce()).rejects.toThrow(AggregateError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an honest blocked-health spawn preflight result before the expiry-window shortcut', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-spawn-health-gate-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-spawn-health-gate-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => {
      throw new Error('spawn preflight should not reach provider for reconnect-required credentials');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('blocked_by_credential_health');
    expect(result.diagnostic).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'spawn_preflight',
      expiresAt: now + 10 * 60_000,
    }));
    expect(result.diagnostic.category).toBeUndefined();
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
  });

  it('honors forced Claude spawn preflight refresh for future-dated OAuth credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-forced-claude-spawn-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-forced-claude-spawn-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'claude-subscription',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: now + 10 * 60_000,
        oauth: {
          accessToken: 'future-access',
          refreshToken: 'future-refresh',
          idToken: null,
          scope: 'user:inference user:profile user:sessions:claude_code',
          tokenType: 'Bearer',
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        json: async () => ({
          access_token: 'forced-access',
          refresh_token: 'forced-refresh',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });

    expect(result.status).toBe('refreshed');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(result.credential?.kind).toBe('oauth');
    if (!result.credential || result.credential.kind !== 'oauth') {
      throw new Error('expected oauth credential');
    }
    expect(result.credential.oauth.accessToken).toBe('forced-access');
  });

  it('redacts profile-health read failures before refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-spawn-health-read-redaction-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-spawn-health-read-redaction-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => {
        throw new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
          method: 'get',
          url: 'https://api.example.test/v3/connect/openai-codex/profiles?token=QUERY_SECRET',
          headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
          data: { access_token: 'BODY_SECRET' },
        });
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({ status: 'not_needed' }));

    const payload = JSON.stringify(warnSpy.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('https://api.example.test/v3/connect/openai-codex/profiles');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });

  it('lets forced quota-bridge refresh bypass reconnect-required backoff and clear health', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-quota-health-gate-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-quota-health-gate-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'recoverable-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        }],
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'quota-recovered-access',
        refresh_token: 'quota-recovered-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toEqual(expect.objectContaining({
      record: expect.objectContaining({ kind: 'oauth' }),
      reauthRequired: false,
    }));

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: {
        v: 1,
        status: 'connected',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshSuccessAt: now,
      },
    });
  });

  it('refreshes the active group profile and re-materializes the selected group home for tracked group spawn targets', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'alice@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        if (params.serviceId !== 'openai-codex' || params.profileId !== 'backup') {
          return null;
        }
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: 'alice@example.com',
            providerAccountId: 'acct',
            expiresAt: now + 30_000,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      // Canonical group state matches the target's snapshot (active 'backup' at generation 7).
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 7,
      })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const targetRegistration = {
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            profileId: 'work',
            groupId: 'main',
          },
        },
      },
      materializationKey: 'session-1',
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'work',
          generation: 7,
        }]),
      },
    } as Parameters<ConnectedServiceRefreshCoordinator['registerSpawnTarget']>[0] & {
      connectedServiceSelectionsEnv: Record<string, string>;
    };

    coordinator.registerSpawnTarget(targetRegistration);

    await coordinator.tickOnce();

    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });

    const codexHome = resolveCodexHomeForMaterialization(baseDir, 'session-1');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
    expect(auth.refresh_token).toBe('new-refresh');
  });

  it('continues refreshing other bindings when one binding refresh fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const openaiRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const geminiRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'g-old-access',
        refreshToken: 'g-old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const sealedByServiceId = new Map<string, string>();
    sealedByServiceId.set('openai-codex', sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: openaiRecord,
      randomBytes: (length) => randomBytes(length),
    }));
    sealedByServiceId.set('gemini', sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: geminiRecord,
      randomBytes: (length) => randomBytes(length),
    }));

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string }) => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedByServiceId.get(params.serviceId)! },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: null, expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; sealed: { ciphertext: string } }) => {
        sealedByServiceId.set(params.serviceId, params.sealed.ciphertext);
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('auth.openai.com')) {
        return { ok: false, status: 500, statusText: 'fail', text: async () => 'boom' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'g-new-access',
          refresh_token: 'g-new-refresh',
          expires_in: 3600,
        }),
        text: async () => '',
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const logRefreshDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      logRefreshDiagnostic,
    });

    coordinator.registerSpawnTarget({
      pid: 1,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });
    coordinator.registerSpawnTarget({
      pid: 2,
      agentId: 'gemini',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { gemini: { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-gemini',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow();

    // Even though OpenAI refresh failed, Gemini should still have been refreshed and registered.
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'gemini' }));
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: {
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'unknown',
        providerHttpStatus: 500,
      },
    });
    expect(logRefreshDiagnostic).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'scheduled',
      status: 'refresh_failed',
      category: 'unknown',
      providerStatus: 500,
      providerErrorCode: null,
      expiresAt: now + 30_000,
      expiryAgeMs: -30_000,
      refreshWindowMs: 60_000,
    });
    expect(JSON.stringify(logRefreshDiagnostic.mock.calls)).not.toContain('old-refresh');
  });

  it('preserves stored OAuth scope and token type when refresh omits them', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-scope-preserve-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-scope-preserve-'));
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    let credentialRevision = 'csr_abcdefghijklmnopqrstuv';
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision,
        content: { t: 'plain' as const, v: storedRecord },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'machine-scope-preserve',
        credentialRevision,
      })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
        credentialRevision = 'csr_bcdefghijklmnopqrstuvw';
        return { success: true as const, credentialRevision };
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-scope-preserve',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });

    expect(result?.record?.kind).toBe('oauth');
    expect(result?.record?.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code');
    expect(result?.record?.oauth?.tokenType).toBe('Bearer');
    expect(storedRecord.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code');
    expect(storedRecord.oauth?.tokenType).toBe('Bearer');
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledWith(expect.objectContaining({
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
    }));
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledWith(expect.objectContaining({
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      refreshLeaseOwnerId: 'machine-scope-preserve',
    }));
  });

  it('updates stored OAuth scope and token type when refresh returns replacements', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-scope-update-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-scope-update-'));
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    let storedRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: storedRecord } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
        token_type: 'Bearer',
      }),
    })) as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-scope-update',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'claude-subscription',
      profileId: 'work',
      force: true,
    });

    expect(result?.record?.kind).toBe('oauth');
    expect(result?.record?.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload');
    expect(result?.record?.oauth?.tokenType).toBe('Bearer');
    expect(storedRecord.oauth?.scope).toBe('user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload');
    expect(storedRecord.oauth?.tokenType).toBe('Bearer');
  });
});

/**
 * Completes narrow API boundary fakes with the revision/lease facts the real server always returns.
 * Individual race tests can still return explicit revisions; those values take precedence and
 * advance the fake's canonical revision for subsequent reads.
 */
function completeCredentialAuthorityBoundaryFixture(api: ApiClient): void {
  // Boundary fixtures intentionally use dynamic method replacement so the 50+ focused scenarios
  // exercise one canonical server contract instead of reimplementing revision minting in each test.
  const boundary = api as any;
  const revisions = new Map<string, string>();
  const persistedRepresentations = new Map<string, Record<string, unknown>>();
  let revisionSequence = 0;
  const fallbackRevision = 'csr_abcdefghijklmnopqrstuv';
  const keyOf = (params: { serviceId: string; profileId: string }) => `${params.serviceId}::${params.profileId}`;
  const mintRevision = () => {
    revisionSequence += 1;
    return `csr_${String(revisionSequence).padStart(22, '0')}`;
  };

  for (const methodName of ['getConnectedServiceCredentialPlain', 'getConnectedServiceCredentialSealed'] as const) {
    const original = boundary[methodName];
    if (typeof original !== 'function') continue;
    boundary[methodName] = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      const result = await original.call(boundary, params);
      if (!result) return result;
      const key = keyOf(params);
      const persistedRepresentation = persistedRepresentations.get(key);
      const credentialRevision = typeof result.credentialRevision === 'string'
        ? result.credentialRevision
        : revisions.get(key) ?? fallbackRevision;
      revisions.set(key, credentialRevision);
      return {
        ...result,
        ...(typeof result.credentialRevision !== 'string' && persistedRepresentation
          ? persistedRepresentation
          : {}),
        revisionSemantics: 'revisioned',
        credentialRevision,
      };
    });
  }

  const originalLease = boundary.acquireConnectedServiceRefreshLease;
  if (typeof originalLease === 'function') {
    boundary.acquireConnectedServiceRefreshLease = vi.fn(async (params: {
      serviceId: string;
      profileId: string;
      machineId: string;
      ownerId?: string;
      expectedCredentialRevision?: string;
    }) => {
      const result = await originalLease.call(boundary, params);
      const key = keyOf(params);
      const credentialRevision = typeof result.credentialRevision === 'string'
        ? result.credentialRevision
        : revisions.get(key) ?? params.expectedCredentialRevision ?? fallbackRevision;
      revisions.set(key, credentialRevision);
      return {
        ...result,
        ownerId: typeof result.ownerId === 'string' ? result.ownerId : params.ownerId ?? params.machineId,
        credentialRevision,
      };
    });
  }

  for (const methodName of ['registerConnectedServiceCredentialPlain', 'registerConnectedServiceCredentialSealed'] as const) {
    const original = boundary[methodName];
    if (typeof original !== 'function') continue;
    boundary[methodName] = vi.fn(async (params: {
      serviceId: string;
      profileId: string;
      content?: unknown;
      sealed?: unknown;
      metadata?: unknown;
    }) => {
      const result = await original.call(boundary, params);
      if (result && typeof result === 'object' && 'error' in result) return result;
      const key = keyOf(params);
      const credentialRevision = result && typeof result === 'object' && typeof result.credentialRevision === 'string'
        ? result.credentialRevision
        : mintRevision();
      revisions.set(key, credentialRevision);
      persistedRepresentations.set(key, params.content
        ? { content: params.content }
        : { sealed: params.sealed, metadata: params.metadata });
      return { success: true, credentialRevision };
    });
  }
}
