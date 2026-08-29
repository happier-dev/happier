import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import {
  ConnectedServiceBindingsV1Schema,
  FeaturesResponseSchema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceCredentialRevisionV1,
  QualifiedConnectedAccountGroupV4,
} from '@happier-dev/protocol';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { materializeConnectedServicesForSpawn } from '../materialize/materializeConnectedServicesForSpawn';
import { logger } from '@/ui/logger';
import {
  resolveQualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import {
  computeClaudeSubscriptionAccessTokenFingerprint,
} from '@happier-dev/plugins-claude/agent/auth/services/cloud/refreshBridge';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceGroupHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import {
  classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh,
  ConnectedServiceRefreshCoordinator,
  type QualifiedConnectedAccountRefreshRuntime,
} from './ConnectedServiceRefreshCoordinator';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';

const {
  materializeConnectedServicesForSpawnOverride,
  getConnectedServiceMaterializedHomeFreshnessOverride,
} = vi.hoisted(() => ({
  materializeConnectedServicesForSpawnOverride: vi.fn(),
  getConnectedServiceMaterializedHomeFreshnessOverride: vi.fn(),
}));

async function writeClaudeCodeCredentialsFile(input: Readonly<{
  claudeConfigDir: string;
  payload: unknown;
}>): Promise<void> {
  await mkdir(input.claudeConfigDir, { recursive: true });
  await writeFile(
    join(input.claudeConfigDir, '.credentials.json'),
    `${JSON.stringify(input.payload)}\n`,
    { mode: 0o600 },
  );
}

vi.mock('@/daemon/connectedServices/catalogHooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/connectedServices/catalogHooks')>();
  return {
    ...actual,
    getConnectedServiceMaterializedHomeFreshness: vi.fn(async (agentId: CatalogAgentId) => {
      const override = getConnectedServiceMaterializedHomeFreshnessOverride(agentId);
      if (override !== undefined) return override;
      return await actual.getConnectedServiceMaterializedHomeFreshness(agentId);
    }),
  };
});

vi.mock('../materialize/materializeConnectedServicesForSpawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../materialize/materializeConnectedServicesForSpawn')>();
  return {
    ...actual,
    materializeConnectedServicesForSpawn: vi.fn(async (
      params: Parameters<typeof actual.materializeConnectedServicesForSpawn>[0],
    ) => {
      const override = materializeConnectedServicesForSpawnOverride(params.agentId);
      if (override === undefined) {
        return null;
      }
      const { resolveConnectedServiceMaterializedRootDir } = await import(
        '../materialize/resolveConnectedServiceMaterializedRootDir'
      );
      return await override({
        ...params,
        rootDir: resolveConnectedServiceMaterializedRootDir(params),
      });
    }),
  };
});

afterEach(() => {
  materializeConnectedServicesForSpawnOverride.mockReset();
  getConnectedServiceMaterializedHomeFreshnessOverride.mockReset();
});

type LegacyFetchResponseFixture = Readonly<{
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: ResponseInit['headers'];
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}>;

function installGlobalFetchMock<TArgs extends readonly unknown[]>(
  fetchMock: (...args: TArgs) => Promise<LegacyFetchResponseFixture>,
): void {
  vi.stubGlobal('fetch', async (...args: TArgs) => {
    const response = await fetchMock(...args);
    if (response instanceof Response) return response;
    const body = response.ok !== false && typeof response.json === 'function'
      ? JSON.stringify(await response.json())
      : typeof response.text === 'function'
        ? await response.text()
        : JSON.stringify(typeof response.json === 'function' ? await response.json() : null);
    return new Response(body, {
      status: response.status ?? (response.ok === false ? 500 : 200),
      statusText: response.statusText,
      headers: response.headers,
    });
  });
}

const credentialAuthorityRuntimeByApi =
  new WeakMap<ApiClient, QualifiedConnectedAccountRefreshRuntime>();

function createRefreshCoordinator(
  params: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0],
): ConnectedServiceRefreshCoordinator {
  const qualifiedConnectedAccountRuntime =
    params.qualifiedConnectedAccountRuntime
    ?? credentialAuthorityRuntimeByApi.get(params.api);
  const resolveQualifiedPurposeBindingSnapshot =
    params.resolveQualifiedPurposeBindingSnapshot
    ?? (async (input: Readonly<{
      agentId: CatalogAgentId;
      connectedServicesBindingsRaw: unknown;
    }>) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
      agentId: input.agentId,
      bindings: ConnectedServiceBindingsV1Schema.parse(
        input.connectedServicesBindingsRaw,
      ),
      contributions: getResolvedContributionRegistry(),
    }));
  return new ConnectedServiceRefreshCoordinator({
    ...params,
    resolveQualifiedPurposeBindingSnapshot,
    ...(qualifiedConnectedAccountRuntime
      ? { qualifiedConnectedAccountRuntime }
      : {}),
  });
}

/** Completes API boundary fakes with the revision/lease contract returned by the real server. */
function completeCredentialAuthorityBoundaryFixture(api: ApiClient): void {
  // Boundary fixtures intentionally use dynamic method replacement so focused scenarios share one
  // realistic server contract while race tests remain free to provide explicit superseding revisions.
  const boundary = api as any;
  const revisions = new Map<string, string>();
  const persistedRepresentations = new Map<string, Record<string, unknown>>();
  let revisionSequence = 0;
  const fallbackRevision = 'csr_abcdefghijklmnopqrstuv';
  const keyOf = (params: { serviceId: string; profileId: string }) => `${params.serviceId}::${params.profileId}`;
  const mintRevision = () => `csr_${String(++revisionSequence).padStart(22, '0')}`;
  const originalCredentialReaders = {
    getConnectedServiceCredentialPlain: boundary.getConnectedServiceCredentialPlain,
    getConnectedServiceCredentialSealed: boundary.getConnectedServiceCredentialSealed,
  } as const;

  if (typeof boundary.getAccountEncryptionMode !== 'function') {
    boundary.getAccountEncryptionMode = vi.fn(async () =>
      typeof originalCredentialReaders.getConnectedServiceCredentialPlain === 'function'
        ? 'plain'
        : 'e2ee',
    );
  }

  for (const methodName of ['getConnectedServiceCredentialPlain', 'getConnectedServiceCredentialSealed'] as const) {
    const original = originalCredentialReaders[methodName];
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
      const readerName = methodName === 'registerConnectedServiceCredentialPlain'
        ? 'getConnectedServiceCredentialPlain'
        : 'getConnectedServiceCredentialSealed';
      const canonicalReader = originalCredentialReaders[readerName];
      const canonicalAfterMutation = typeof canonicalReader === 'function'
        ? await canonicalReader.call(boundary, params)
        : null;
      const credentialRevision = result && typeof result === 'object' && typeof result.credentialRevision === 'string'
        ? result.credentialRevision
        : canonicalAfterMutation
          && typeof canonicalAfterMutation === 'object'
          && typeof canonicalAfterMutation.credentialRevision === 'string'
          ? canonicalAfterMutation.credentialRevision
          : mintRevision();
      revisions.set(key, credentialRevision);
      persistedRepresentations.set(key, params.content
        ? { content: params.content }
        : { sealed: params.sealed, metadata: params.metadata });
      return { success: true, credentialRevision };
    });
  }

  // These legacy API boundary fixtures model a revisioned V2/V3 peer. The
  // canonical runtime is present in production, but its V4 methods are
  // unreachable for this peer class; keep those methods fail-closed if a test
  // accidentally crosses the compatibility boundary.
  credentialAuthorityRuntimeByApi.set(api, {
    resolvePeerClass: () => 'revisioned_v2_v3',
    establishedRuntimeOwner: {
      invokeWithReceipt: vi.fn(async () => {
        throw new Error('revisioned V2/V3 fixture cannot invoke a V4 plugin leaf');
      }),
    },
    mutateCredentialHealth: vi.fn(async () => {
      throw new Error('revisioned V2/V3 fixture cannot mutate V4 credential health');
    }),
    readCredential: vi.fn(async () => {
      throw new Error('revisioned V2/V3 fixture cannot read a V4 credential');
    }),
    acquireRefreshLease: vi.fn(async () => {
      throw new Error('revisioned V2/V3 fixture cannot acquire a V4 refresh lease');
    }),
    mutateCredential: vi.fn(async () => {
      throw new Error('revisioned V2/V3 fixture cannot mutate a V4 credential');
    }),
  } as unknown as QualifiedConnectedAccountRefreshRuntime);
}

function createNeedsReauthRefreshHarness(params: Readonly<{
  expiresAt: number | null;
  now?: number;
  onCredentialHealthNotification?: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onCredentialHealthNotification'];
}>): Readonly<{
  coordinator: ConnectedServiceRefreshCoordinator;
  api: ApiClient & Readonly<{
    acquireConnectedServiceRefreshLease: ReturnType<typeof vi.fn>;
    listConnectedServiceProfiles: ReturnType<typeof vi.fn>;
    registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
  }>;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const now = params.now ?? 1_000_000;
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
    expiresAt: params.expiresAt,
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
  let persistedExpiresAt = params.expiresAt;
  let credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
  const api = {
    listConnectedServiceProfiles: vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
    })),
    getConnectedServiceCredentialSealed: vi.fn(async () => ({
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
      metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: persistedExpiresAt },
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
    })),
    acquireConnectedServiceRefreshLease: vi.fn(async () => ({
      acquired: true,
      leaseUntil: now + 60_000,
      ownerId: 'machine-1',
      credentialRevision,
    })),
    updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    registerConnectedServiceCredentialSealed: vi.fn(async (input) => {
      sealedCiphertext = input.sealed.ciphertext;
      persistedExpiresAt = input.metadata?.expiresAt ?? null;
      credentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
      return { success: true as const, credentialRevision };
    }),
  } as unknown as ApiClient & Readonly<{
    acquireConnectedServiceRefreshLease: ReturnType<typeof vi.fn>;
    listConnectedServiceProfiles: ReturnType<typeof vi.fn>;
    registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
  }>;
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }),
  }));
  installGlobalFetchMock(fetchMock);
  completeCredentialAuthorityBoundaryFixture(api);
  return {
    api,
    fetchMock,
    coordinator: createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      ...(params.onCredentialHealthNotification
        ? { onCredentialHealthNotification: params.onCredentialHealthNotification }
        : {}),
    }),
  };
}

describe('ConnectedServiceRefreshCoordinator', () => {
  it('sanitizes qualified refresh exceptions and omits provider-defined account identity', async () => {
    const service = { pluginId: 'acme.provider', localId: 'accounts' } as const;
    const accountId = 'person@example.test';
    const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const error = Object.assign(
      new Error(`EACCES opening /Users/alice/.config/provider and C:\\Users\\Alice\\provider for ${accountId}`),
      { code: 'EACCES' },
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const coordinator = createRefreshCoordinator({
      api: {} as ApiClient,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => 1_000_000,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner: { invokeWithReceipt: vi.fn() },
        mutateCredentialHealth: vi.fn(),
        readCredential: vi.fn(async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ref: { service, accountId },
          authenticationModeId: 'oauth',
          configurationRevision: null,
          content: { t: 'plain', v: {} },
          metadata: { scopes: [] },
          revisionSemantics: 'revisioned',
          credentialRevision,
        })),
        acquireRefreshLease: vi.fn(async () => { throw error; }),
        mutateCredential: vi.fn(),
      },
    });

    await expect(coordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({
      account: { service, accountId },
      expectedCredentialRevision: credentialRevision,
    })).resolves.toBe(false);

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('acme.provider');
    expect(logged).toContain('EACCES');
    expect(logged).not.toContain(accountId);
    expect(logged).not.toContain('/Users/alice');
    expect(logged).not.toContain('C:\\\\Users\\\\Alice');
    expect(logged).not.toContain('at ');
  });

  it('does not run any refresh transport for revisioned Bitbucket when its generated peer operation set is empty', async () => {
    const now = 1_000_000;
    const service = {
      pluginId: 'happier.scm.forge.bitbucket',
      localId: 'bitbucket-account',
    } as const;
    const snapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          connectedServices: {
            credentialDelete: { revisionGuard: true },
          },
        },
      }),
    };
    const getConnectedServiceCredentialPlain = vi.fn(
      async () => null,
    );
    const acquireConnectedServiceRefreshLease = vi.fn();
    const registerConnectedServiceCredentialPlain = vi.fn();
    const updateConnectedServiceCredentialHealth = vi.fn();
    const invokeWithReceipt = vi.fn();
    const coordinator = createRefreshCoordinator({
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain,
        acquireConnectedServiceRefreshLease,
        registerConnectedServiceCredentialPlain,
        updateConnectedServiceCredentialHealth,
      } as unknown as ApiClient,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(31),
        },
      },
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'revisioned_v2_v3',
        resolveOperationTransport: ({ operation }) =>
          resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot,
            serverContract: null,
            service,
            operation,
          }),
        establishedRuntimeOwner: { invokeWithReceipt },
        mutateCredentialHealth: vi.fn(),
        readCredential: vi.fn(),
        acquireRefreshLease: vi.fn(),
        mutateCredential: vi.fn(),
      },
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'materialization-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          bitbucket: {
            source: 'connected',
            profileId: 'work',
          },
        },
      },
    });

    await coordinator.tickOnce();

    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(
      registerConnectedServiceCredentialPlain,
    ).not.toHaveBeenCalled();
    expect(
      updateConnectedServiceCredentialHealth,
    ).not.toHaveBeenCalled();
    expect(invokeWithReceipt).not.toHaveBeenCalled();
  });

  it('fails closed before lease acquisition when an exact v0.2.1 credential has no revision fence', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(31) },
    };
    const record = buildConnectedServiceCredentialRecord({
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
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'legacy_unfenced' as const,
        credentialRevision: null,
      })),
      acquireConnectedServiceRefreshLease: vi.fn(),
      registerConnectedServiceCredentialPlain: vi.fn(),
    } as unknown as ApiClient;

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });

    expect(result).toBeNull();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('classifies a revisioned GitHub PAT as non-OAuth before any lease or provider effect', async () => {
    const now = 1_000_000;
    const credentialRevision =
      'csr_0123456789ABCDEFGHJKMNPQRS';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(31),
      },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'github-pat',
        providerAccountId: 'octocat',
        providerEmail: null,
      },
    });
    const acquireConnectedServiceRefreshLease = vi.fn();
    const registerConnectedServiceCredentialPlain = vi.fn();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
      })),
      acquireConnectedServiceRefreshLease,
      registerConnectedServiceCredentialPlain,
    } as unknown as ApiClient;
    const invokeWithReceipt = vi.fn();
    const readCredential = vi.fn();
    const acquireRefreshLease = vi.fn();
    const mutateCredential = vi.fn();
    const mutateCredentialHealth = vi.fn();
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch as unknown as typeof fetch);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'revisioned_v2_v3',
        establishedRuntimeOwner: {
          invokeWithReceipt,
        } as never,
        readCredential,
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
      },
    });

    const result =
      await coordinator
        .refreshConnectedServiceCredentialForRuntimeAuthFailure({
          serviceId: 'github',
          profileId: 'work',
        });

    expect(result.status).toBe('not_oauth');
    expect(acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(invokeWithReceipt).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
    expect(acquireRefreshLease).not.toHaveBeenCalled();
    expect(mutateCredential).not.toHaveBeenCalled();
    expect(mutateCredentialHealth).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
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

  it('rejects post-persist same-token ABA when canonical revision differs from the mutation revision', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-post-persist-aba-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-post-persist-aba-'));
    const now = 1_000_000;
    const sourceRevision = 'csr_abcdefghijklmnopqrstuv';
    const mintedRevision = 'csr_bcdefghijklmnopqrstuvw';
    const supersedingRevision = 'csr_cdefghijklmnopqrstuvwx';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(31) },
    };
    let record = buildConnectedServiceCredentialRecord({
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
        providerEmail: null,
      },
    });
    let reads = 0;
    const updateConnectedServiceCredentialHealth = vi.fn(async () => undefined);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        reads += 1;
        return {
          credentialRevision: reads <= 2 ? sourceRevision : supersedingRevision,
          content: { t: 'plain' as const, v: record },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'machine-1:daemon-a',
        credentialRevision: sourceRevision,
      })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
        return { success: true as const, credentialRevision: mintedRevision };
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    installGlobalFetchMock(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })));

    const coordinator = createRefreshCoordinator({
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

    expect(result).toBeNull();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
  });

  it('refreshes an expiring openai-codex credential and re-materializes for active spawn targets', async () => {
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
    installGlobalFetchMock(fetchMock);

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
    }));
    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home');
    await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refreshes plaintext credentials for plaintext accounts', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-plain-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-plain-server-refresh-'));

    const credentials: StoredCredentials = {
      token: 'happy-token',
      encryption: null,
    };

    const now = 1_000_000;
    let record = buildConnectedServiceCredentialRecord({
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
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'plain-new-access',
        refresh_token: 'plain-new-refresh',
        id_token: 'plain-new-id',
        expires_in: 3600,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      materializationKey: 'session-plain',
    });

    await coordinator.tickOnce();

    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
    }));
    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home');
    await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('force-refreshes Codex ChatGPT bridge credentials without a finite expiry', async () => {
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
      expiresAt: null,
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

    let credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        credentialRevision,
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
        credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'bridge-new-access',
        refresh_token: 'bridge-new-refresh',
        id_token: 'bridge-new-id',
        expires_in: 3600,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'codex-refresh-attempt-force',
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      chatgptPlanType: 'plus',
      forceRefresh: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({
      accessToken: 'bridge-new-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('settles a delayed bridge refresh once and lets an admitted retry adopt its authoritative result', async () => {
    vi.useFakeTimers();
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const now = 1_000_000;
    let credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
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
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
        credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const fetchMock = vi.fn(async () => {
      markProviderStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 10_001));
      return {
        ok: true,
        json: async () => ({
          access_token: 'one-authoritative-access',
          refresh_token: 'one-authoritative-refresh',
          expires_in: 3600,
        }),
      };
    });
    installGlobalFetchMock(fetchMock);
    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const request = {
      refreshAttemptId: 'codex-refresh-attempt-delayed',
      selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' as const,
    };

    const admitted = coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);
    await providerStarted;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retryWhileAdmitted = coordinator.refreshOpenAiCodexChatGptTokensForBridge(request);
    await vi.advanceTimersByTimeAsync(10_001);
    const expected = {
      accessToken: 'one-authoritative-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
    };
    await expect(admitted).resolves.toEqual(expected);
    await expect(retryWhileAdmitted).resolves.toEqual(expected);
    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge(request)).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('allows a new refresh attempt to retry the same credential revision after the prior attempt rejects', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const now = 1_000_000;
    let credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
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
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
        credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary provider outage'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'retried-access',
          refresh_token: 'retried-refresh',
          expires_in: 3600,
        }),
      });
    installGlobalFetchMock(fetchMock);
    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });
    const request = {
      selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' as ConnectedServiceCredentialRevisionV1,
    };

    const first = coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      ...request,
      refreshAttemptId: 'attempt-a',
    });
    await expect(first).rejects.toThrow('connected_service_credential_refresh_unavailable');
    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      ...request,
      refreshAttemptId: 'attempt-a',
    })).rejects.toThrow('connected_service_credential_refresh_unavailable');

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      ...request,
      refreshAttemptId: 'attempt-b',
    })).resolves.toMatchObject({ accessToken: 'retried-access' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale old-revision attempt without waiting for or evicting a newer pending attempt', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const now = 1_000_000;
    let credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'rev3-access', refreshToken: 'rev3-refresh', idToken: null,
        scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
        credentialRevision = 'csr_23456789ABCDEFGHJKMNPQRSTV';
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const fetchMock = vi.fn(async () => {
      await providerRelease;
      return {
        ok: true,
        json: async () => ({ access_token: 'rev4-access', refresh_token: 'rev4-refresh', expires_in: 3600 }),
      };
    });
    installGlobalFetchMock(fetchMock);
    const coordinator = createRefreshCoordinator({
      api, credentials, machineIdProvider: () => 'machine-1', activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base', refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => now,
    });
    const selection = { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work' };
    const current = coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'rev3-attempt', selection, chatgptPlanType: 'plus', forceRefresh: true,
      expectedCredentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const stale = coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'rev1-attempt', selection, chatgptPlanType: 'plus', forceRefresh: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });

    await expect(Promise.race([
      stale.then(() => 'resolved', () => 'rejected'),
      new Promise<'still_pending'>((resolve) => setTimeout(() => resolve('still_pending'), 20)),
    ])).resolves.toBe('rejected');
    releaseProvider();
    await expect(current).resolves.toMatchObject({ accessToken: 'rev4-access' });
    await expect(stale).rejects.toThrow('connected_service_credential_revision_mismatch');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps a newer fulfilled settlement adoptable after a stale old-revision replay', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const now = 1_000_000;
    let credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: null,
      oauth: {
        accessToken: 'rev3-access', refreshToken: 'rev3-refresh', idToken: null,
        scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
        credentialRevision = 'csr_23456789ABCDEFGHJKMNPQRSTV';
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'rev4-access', refresh_token: 'rev4-refresh', expires_in: 3600 }),
    }));
    installGlobalFetchMock(fetchMock);
    const coordinator = createRefreshCoordinator({
      api, credentials, machineIdProvider: () => 'machine-1', activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base', refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => now,
    });
    const selection = { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work' };
    const currentRequest = {
      refreshAttemptId: 'rev3-attempt', selection, chatgptPlanType: 'plus', forceRefresh: true,
      expectedCredentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1' as ConnectedServiceCredentialRevisionV1,
    };
    const authoritative = await coordinator.refreshOpenAiCodexChatGptTokensForBridge(currentRequest);
    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'rev1-attempt', selection, chatgptPlanType: 'plus', forceRefresh: true,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).rejects.toThrow('connected_service_credential_revision_mismatch');

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge(currentRequest)).resolves.toEqual(authoritative);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledOnce();
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledOnce();
  });

  it('adopts a fresh stored Codex access token when a forced retry names a different failed token', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'store-already-rotated-access',
        refreshToken: 'current-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'codex-refresh-attempt-adopt',
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: true,
      failingAccessTokenFingerprint: 'sha256:03235bf9',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({
      accessToken: 'store-already-rotated-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('rejects a delayed Codex refresh callback authorized by a stale same-profile credential revision', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const now = 1_000_000;
    const currentCredentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
    const staleCredentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'current-rev3-access',
        refreshToken: 'current-rev3-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision: currentCredentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(),
      registerConnectedServiceCredentialPlain: vi.fn(),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'codex-refresh-attempt-stale',
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: true,
      expectedCredentialRevision: staleCredentialRevision,
      failingAccessTokenFingerprint: 'sha256:failed',
    })).rejects.toThrow('connected_service_credential_revision_mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('F6: returns the current Codex access token WITHOUT a rotation when not forced and the token is still valid', async () => {
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
      // Far from expiry (well outside the refresh window) so a non-forced refresh is not needed.
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'current-valid-access',
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

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 3_600_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      refreshAttemptId: 'codex-refresh-attempt-current',
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });

    expect(result).toEqual({
      accessToken: 'current-valid-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });
    // No provider call, no lease, no rotation when the current token is still valid.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('fails closed before plaintext credential access when the Account-mode authority is unavailable', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-plain-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-plain-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let record = buildConnectedServiceCredentialRecord({
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
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
    installGlobalFetchMock(fetchMock);

    const coordinator = createRefreshCoordinator({
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

    await expect(coordinator.tickOnce()).rejects.toThrow(
      'Connected services refresh tick failed',
    );

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed before sealed credential access when the Account-mode authority is unavailable', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-sealed-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-sealed-fallback-'));

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
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw new Error('plain read failed');
      }),
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
    installGlobalFetchMock(fetchMock);

    const coordinator = createRefreshCoordinator({
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
      pid: 789,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-sealed-fallback',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow(
      'Connected services refresh tick failed',
    );

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
    installGlobalFetchMock(fetchMock);

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
    }));
  });

  it('keeps qualified scheduled refresh free of daemon-side Claude credential materialization', async () => {
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
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 30_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-narrow-access',
        refresh_token: 'new-narrow-refresh',
        expires_in: 3600,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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

    await expect(coordinator.tickOnce()).resolves.toBeUndefined();

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'claude' })],
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: expect.objectContaining({
        v: 1,
        status: 'connected',
        reconnectRequired: false,
      }),
    }));
    const claudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    await expect(readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('narrow-refresh');
  });

  it('rematerializes a stale Claude home when the store credential is still fresh but the home token differs', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-claude-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-stale-claude-home-'));
    const materializationKey = 'session-claude-stale-home';
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'claude',
      materializationKey,
    });
    await mkdir(materializedRoot, { recursive: true });
    await writeFile(join(materializedRoot, '.credentials.json'), `${JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-home-access',
        expiresAt: 1_000_000 + 3_600_000,
        scopes: ['user:inference'],
      },
    })}\n`);

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
        accessToken: 'fresh-store-access',
        refreshToken: 'fresh-store-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const materializer = vi.fn(async () => ({
      env: { CLAUDE_CONFIG_DIR: materializedRoot },
      diagnostics: [],
      cleanupOnFailure: true,
      cleanupOnExit: true,
    }));
    materializeConnectedServicesForSpawnOverride.mockImplementation((agentId) =>
      agentId === 'claude' ? materializer : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'claude'
        ? { isMaterializedHomeStale: vi.fn(async () => true) }
        : undefined,
    );
    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      materializationKey,
      sessionId: 'happy-session-1',
    });

    await coordinator.tickOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(materializer).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: expect.any(String),
      recordsByServiceId: expect.any(Map),
      purposeBindingSessionId: 'happy-session-1',
    }));
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'claude' })],
    }));
  });

  async function buildClaudeGroupHomeOwnershipHarness() {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-group-home-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-group-home-'));

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
        providerEmail: `${profileId}@example.test`,
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
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (input: { profileId: string }) => {
        const ciphertext = sealedByProfileId.get(input.profileId);
        if (!ciphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: `${input.profileId}@example.test`,
            providerAccountId: `acct-${input.profileId}`,
            expiresAt: now + 60 * 60_000,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('store refresh should not run');
    }) as unknown as typeof fetch);

    const readGroup = vi.fn(async (): Promise<QualifiedConnectedAccountGroupV4> => ({
      v: 1,
      ref: {
        service: {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
        groupId: 'pool',
      },
      incarnation: 'qualified-group-row-pool',
      displayName: 'Pool',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: false,
      },
      activeConnectedAccountId: 'workA',
      generation: 4,
      runtimeStateRevision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 1,
      members: [{
        v: 1,
        connectedAccountId: 'workA',
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      processEnv: { HOME: sourceHomeDir },
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        readGroup,
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(async () => ({
            result: {
              status: 'connected' as const,
              displayName: 'Work A',
              scopes: [],
            },
            basis: {
              credentialRevision: 'csr_abcdefghijklmnopqrstuv',
              credentialConfigurationRevision: null,
              isCurrent: () => true,
            },
          })),
        },
        mutateCredentialHealth: vi.fn(async () => ({
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
          configurationRevision: null,
        })),
      } as unknown as QualifiedConnectedAccountRefreshRuntime,
      onAuthUpdated,
    });
    const selectionA = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'pool',
      activeProfileId: 'workA',
      fallbackProfileId: 'workB',
      generation: 4,
      policy: null,
    };
    coordinator.registerSpawnTarget({
      pid: 127,
      agentId: 'claude',
      sessionId: 'happy-group-a',
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
      materializationKey: 'session-claude-group-a',
    });
    const selectionB = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'pool',
      activeProfileId: 'workB',
      fallbackProfileId: 'workA',
      generation: 3,
      policy: null,
    };
    coordinator.registerSpawnTarget({
      pid: 128,
      agentId: 'claude',
      sessionId: 'happy-group-b',
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
      materializationKey: 'session-claude-group-b',
    });

    const groupConfigDir = join(resolveConnectedServiceGroupHomeDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'pool',
      agentId: 'claude',
    }), 'claude-config');

    return { coordinator, onAuthUpdated, groupConfigDir, now, readGroup };
  }

  it('keeps a shared Claude group home stable across divergent-snapshot member sessions', async () => {
    const harness = await buildClaudeGroupHomeOwnershipHarness();
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'active-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    await harness.coordinator.tickOnce();
    await harness.coordinator.tickOnce();

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('active-access');
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('fails closed when canonical Claude group state is unreadable during stale-home repair', async () => {
    const harness = await buildClaudeGroupHomeOwnershipHarness();
    harness.readGroup.mockRejectedValue(new Error('group reader unavailable'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'dead-old-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    await harness.coordinator.tickOnce();

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('dead-old-access');
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('uses provider-owned materialized-home freshness checks instead of daemon service-specific logic', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-contributed-stale-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-contributed-stale-home-'));
    const materializationKey = 'session-codex-stale-home';

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
        accessToken: 'fresh-store-access',
        refreshToken: 'fresh-store-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const materializer = vi.fn(async () => ({
      env: { CODEX_HOME: join(baseDir, 'materialized') },
      diagnostics: [],
      cleanupOnFailure: true,
      cleanupOnExit: true,
    }));
    const isMaterializedHomeStale = vi.fn(async () => true);
    materializeConnectedServicesForSpawnOverride.mockImplementation((agentId) =>
      agentId === 'codex' ? materializer : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'codex'
        ? { isMaterializedHomeStale }
        : undefined,
    );
    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      materializationKey,
      sessionId: 'happy-session-1',
    });

    await coordinator.tickOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(isMaterializedHomeStale).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      materializedRootDir: resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'codex',
        materializationKey,
      }),
      record: expect.objectContaining({
        kind: 'oauth',
        oauth: expect.objectContaining({ accessToken: 'fresh-store-access' }),
      }),
      now,
      refreshWindowMs: 60_000,
    });
    expect(materializer).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: expect.any(String),
      recordsByServiceId: expect.any(Map),
    }));
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
    }));
  });

  it('repairs a stale materialized home once during spawn preflight when the store credential is fresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-stale-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-preflight-stale-home-'));
    const materializationKey = 'session-codex-preflight-stale-home';

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
        accessToken: 'fresh-store-access',
        refreshToken: 'fresh-store-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    vi.stubGlobal('fetch', vi.fn() as unknown as typeof fetch);
    const materializer = vi.fn(async () => ({
      env: { CODEX_HOME: join(baseDir, 'materialized') },
      diagnostics: [],
      cleanupOnFailure: true,
      cleanupOnExit: true,
    }));
    materializeConnectedServicesForSpawnOverride.mockImplementation((agentId) =>
      agentId === 'codex' ? materializer : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'codex'
        ? { isMaterializedHomeStale: vi.fn(async () => true) }
        : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'codex'
        ? { isMaterializedHomeStale: vi.fn(async () => true) }
        : undefined,
    );
    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      pid: 124,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey,
      sessionId: 'happy-session-preflight',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('not_needed');
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(materializer).toHaveBeenCalledTimes(1);
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 124, agentId: 'codex' })],
    }));
  });

  it('fails closed when a tracked target names a service outside its qualified Agent purposes', async () => {
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
      expiresAt: now + 30_000,
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
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-codex-access',
        refresh_token: 'new-codex-refresh',
        expires_in: 3600,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await expect(coordinator.tickOnce()).rejects.toThrow(
        'Connected services refresh tick failed',
      );
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        providerErrorCode: 'connected_service_qualified_purpose_authority_unavailable',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('claude-narrow-refresh');
  });

  it('preserves tracked V4 group selections when a fresh record rematerializes an active spawn target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'old-primary-access',
        refreshToken: 'old-primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedPrimaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { profileId: string }) => (
        params.profileId === 'primary'
          ? {
            sealed: { format: 'account_scoped_v1', ciphertext: sealedPrimaryCiphertext },
            metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 3_600_000 },
          }
          : null
      )),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedPrimaryCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const materializer = vi.fn(async (
      params: Parameters<typeof materializeConnectedServicesForSpawn>[0] & Readonly<{ rootDir: string }>,
    ) => ({
      env: { CODEX_HOME: params.rootDir },
      diagnostics: [],
      cleanupOnFailure: null,
      cleanupOnExit: null,
    }));
    materializeConnectedServicesForSpawnOverride.mockImplementation((agentId) =>
      agentId === 'codex' ? materializer : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'codex'
        ? { isMaterializedHomeStale: vi.fn(async () => true) }
        : undefined,
    );

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-primary-access',
        refresh_token: 'new-primary-refresh',
        id_token: 'new-primary-id',
        expires_in: 3600,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    const readGroup = vi.fn(async (): Promise<QualifiedConnectedAccountGroupV4> => ({
      v: 1,
      ref: {
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        groupId: 'team',
      },
      incarnation: 'qualified-group-row-team',
      displayName: 'Team',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        autoSwitch: false,
      },
      activeConnectedAccountId: 'primary',
      generation: 2,
      runtimeStateRevision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 1,
      members: [{
        v: 1,
        connectedAccountId: 'primary',
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    }));
    const qualifiedStatusRevision = 'csr_abcdefghijklmnopqrstuv';

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        readGroup,
        establishedRuntimeOwner: {
          invokeWithReceipt: vi.fn(async () => ({
            result: { status: 'connected' as const, displayName: 'primary', scopes: [] },
            basis: {
              credentialRevision: qualifiedStatusRevision,
              credentialConfigurationRevision: null,
              isCurrent: () => true,
            },
          })),
        },
        mutateCredentialHealth: vi.fn(async () => ({
          credentialRevision: qualifiedStatusRevision,
          configurationRevision: null,
        })),
      } as unknown as QualifiedConnectedAccountRefreshRuntime,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
            profileId: 'backup',
          },
        },
      },
      connectedServiceSelectionsEnvRaw: JSON.stringify([
        {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 2,
          policy: null,
        },
      ]),
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(materializer).toHaveBeenCalledTimes(1);
    const selection = materializer.mock.calls[0]?.[0].selectionsByServiceId?.get('happier.agent.codex/openai-codex');
    expect(selection).toMatchObject({
      kind: 'group',
      groupId: 'team',
      activeProfileId: 'primary',
      generation: 2,
    });
    expect(selection).not.toHaveProperty('record');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies invalid refresh tokens during spawn preflight refresh', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
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

    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
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
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'secret-refresh-token' }),
    }));
    installGlobalFetchMock(fetchMock);

    const onCredentialHealthNotification = vi.fn();
    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onCredentialHealthNotification,
    } as unknown as ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]);

    const preflight = coordinator as unknown as Readonly<{
      refreshConnectedServiceCredentialForSpawnPreflight?: (params: Readonly<{
        serviceId: 'openai-codex';
        profileId: string;
      }>) => Promise<Readonly<{
        status: string;
        diagnostic: Readonly<{ category?: string }>;
      }>>;
    }>;
    expect(preflight.refreshConnectedServiceCredentialForSpawnPreflight).toEqual(expect.any(Function));

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

    const result = await preflight.refreshConnectedServiceCredentialForSpawnPreflight!({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refresh_failed');
    expect(result.diagnostic.category).toBe('invalid_grant');
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: expect.objectContaining({
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'invalid_grant',
        providerHttpStatus: 400,
        providerErrorCode: 'invalid_grant',
      }),
    });
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
    expect(JSON.stringify(onCredentialHealthNotification.mock.calls)).not.toContain('secret-refresh-token');
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
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {
      throw new AxiosError('credential revision mismatch', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 409,
        statusText: 'Conflict',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { error: 'revision_mismatch' },
      });
    });
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
    const coordinator = createRefreshCoordinator({
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

  it('warns with a redacted diagnostic when credential health notification dispatch fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_030_000,
      onCredentialHealthNotification: vi.fn(async () => {
        throw new Error('notify failed Authorization: Bearer NOTIFY_SECRET');
      }),
    });
    api.listConnectedServiceProfiles.mockResolvedValueOnce({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({
      status: 'refresh_failed',
    }));

    expect(warnSpy).toHaveBeenCalledWith(
      '[DAEMON RUN] Failed to dispatch connected-service credential health notification',
      expect.objectContaining({
        serviceId: 'openai-codex',
        status: 'refresh_failed',
        category: 'invalid_grant',
      }),
    );
    expect(warnSpy.mock.calls.at(-1)?.[1]).not.toHaveProperty('profileId');
    expect(JSON.stringify(warnSpy.mock.calls.at(-1)?.[1])).not.toContain('NOTIFY_SECRET');
  });

  it('returns an honest cached-health block from spawn preflight before the expiry-window shortcut', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('blocked_by_credential_health');
    expect(result.diagnostic).toMatchObject({
      reason: 'spawn_preflight',
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    expect(result.diagnostic.category).toBeUndefined();
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts profile-health read failures before refresh', async () => {
    const { coordinator, api } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    api.listConnectedServiceProfiles.mockRejectedValueOnce(
      new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
        method: 'get',
        url: 'https://api.example.test/v3/connect/openai-codex/profiles?token=QUERY_SECRET',
        headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
        data: { access_token: 'BODY_SECRET' },
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({ status: 'not_needed' }));

    const payload = JSON.stringify(warnSpy.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('ERR_BAD_RESPONSE');
    expect(payload).not.toContain('https://api.example.test');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });

  it('reprobes scheduled reconnect-required credentials through the current credential', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 30_000,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-health',
    });

    await coordinator.tickOnce();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows one forced quota-bridge reprobe for cached reconnect-required credentials', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    type QuotaRefreshCoordinator = Readonly<{
      refreshConnectedServiceCredentialForQuota?: (input: Readonly<{
        serviceId: 'openai-codex';
        profileId: string;
        force?: boolean;
        expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
      }>) => Promise<unknown>;
    }>;
    const quota = coordinator as unknown as QuotaRefreshCoordinator;
    expect(quota.refreshConnectedServiceCredentialForQuota).toEqual(expect.any(Function));

    const refreshed = await quota.refreshConnectedServiceCredentialForQuota!({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
      expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(refreshed, JSON.stringify({
      credentialReadCalls: (
        api.getConnectedServiceCredentialSealed as ReturnType<typeof vi.fn>
      ).mock.calls.length,
      healthReadCalls: api.listConnectedServiceProfiles.mock.calls.length,
      leaseCalls: api.acquireConnectedServiceRefreshLease.mock.calls.length,
      providerCalls: fetchMock.mock.calls.length,
      persistCalls: api.registerConnectedServiceCredentialSealed.mock.calls.length,
    })).toEqual(expect.objectContaining({
      kind: 'oauth',
      oauth: expect.objectContaining({ accessToken: 'new-access' }),
    }));

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fences a stale request-auth quota-bridge revision before provider refresh or store mutation', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
      expectedCredentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
    })).rejects.toThrow('connected_service_credential_revision_mismatch');

    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('allows one forced runtime-auth reprobe for cached reconnect-required credentials', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    type RuntimeAuthRefreshCoordinator = Readonly<{
      refreshConnectedServiceCredentialForRuntimeAuthFailure?: (input: Readonly<{
        serviceId: 'openai-codex';
        profileId: string;
      }>) => Promise<ConnectedServiceRefreshResultShape>;
    }>;
    type ConnectedServiceRefreshResultShape = Readonly<{
      status: string;
      diagnostic: Readonly<{
        reason: string;
        category?: string;
        providerErrorCode?: string | null;
      }>;
    }>;
    const runtimeAuth = coordinator as unknown as RuntimeAuthRefreshCoordinator;
    expect(runtimeAuth.refreshConnectedServiceCredentialForRuntimeAuthFailure).toEqual(expect.any(Function));

    const result = await runtimeAuth.refreshConnectedServiceCredentialForRuntimeAuthFailure!({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    expect(result.diagnostic).toMatchObject({
      reason: 'runtime_auth_failure',
    });
    expect(result.diagnostic.category).toBeUndefined();
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rematerializes active Claude homes after a runtime-auth forced refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-'));

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
      // Far outside the scheduled refresh window: provider 401 proof must override source expiry.
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

    installGlobalFetchMock(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access',
        refresh_token: 'runtime-refresh',
        expires_in: 3600,
      }),
    })));

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
    await expect(readFile(join(stableConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 125, agentId: 'claude' })],
      trigger: 'refresh_triggered_restart',
      executionAuthority: 'runtime_recovery',
    });
  });

  it('distributes a spawn-preflight rotation to registered targets by construction (RR-1)', async () => {
    // A spawn-preflight refresh that ROTATES (the store credential is near expiry) must distribute the
    // fresh token to every already-registered target for the binding — not only when the caller
    // remembers to. This is the 13:27 murder-window shape: a sibling session holding the superseded
    // token after another entry point rotated it. Distribution belongs to the single 'refreshed'
    // completion path, so no rotation entry can leave a materialized target behind.
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-rotate-distribute-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-preflight-rotate-distribute-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-rotate-source-home-'));

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
      // Within the refresh window: a NON-forced spawn-preflight refresh rotates the single-use token.
      expiresAt: now + 30_000,
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
          expiresAt: now + 30_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    installGlobalFetchMock(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }),
    })));

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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

    // A sibling session already registered for the same binding — it must receive the rotated token
    // even though the spawn-preflight caller is a DIFFERENT (not-yet-registered) session.
    coordinator.registerSpawnTarget({
      pid: 321,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-preflight-sibling',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
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
    await expect(readFile(join(stableConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 321, agentId: 'claude' })],
      trigger: 'refresh_triggered_restart',
      executionAuthority: 'runtime_recovery',
    });
  });

  it('lets a respawn preflight adopt an already-persisted rotation while its distribution is waiting for that respawn', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-respawn-preflight-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-respawn-preflight-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-respawn-preflight-source-home-'));
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
      expiresAt: now + 30_000,
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
          expiresAt: now + 30_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);
    installGlobalFetchMock(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }),
    })));

    let releaseDistribution!: () => void;
    const distributionReleased = new Promise<void>((resolve) => {
      releaseDistribution = resolve;
    });
    let observeDistributionStarted!: () => void;
    const distributionStarted = new Promise<void>((resolve) => {
      observeDistributionStarted = resolve;
    });
    const onAuthUpdated = vi.fn(async () => {
      observeDistributionStarted();
      await distributionReleased;
    });
    const coordinator = createRefreshCoordinator({
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
      pid: 322,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-respawn-preflight-sibling',
    });

    const distributionOwner = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    try {
      await distributionStarted;
      let respawnPreflightResult: Awaited<ReturnType<
        typeof coordinator.refreshConnectedServiceCredentialForSpawnPreflight
      >> | null = null;
      void coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
        serviceId: 'claude-subscription',
        profileId: 'work',
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

    expect(onAuthUpdated).toHaveBeenCalledTimes(1);
  });

  it('does not let daemon qualified rematerialization reinterpret a refreshed Claude credential', async () => {
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

    installGlobalFetchMock(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access-without-claude-code',
        refresh_token: 'runtime-refresh',
        scope: 'user:inference user:profile',
        expires_in: 3600,
      }),
    })));

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
      status: 'refreshed',
      diagnostic: expect.objectContaining({
        serviceId: 'claude-subscription',
        profileId: 'work',
        reason: 'runtime_auth_failure',
        status: 'refreshed',
      }),
    }));
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 125, agentId: 'claude' })],
      trigger: 'refresh_triggered_restart',
      executionAuthority: 'runtime_recovery',
    });
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'work',
      expectedCredentialRevision: expect.any(String),
      health: expect.objectContaining({
        v: 1,
        status: 'connected',
        reconnectRequired: false,
      }),
    }));
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
    await expect(readFile(join(stableConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
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

    installGlobalFetchMock(vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })));

    const onAuthUpdated = vi.fn();
    const coordinator = createRefreshCoordinator({
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
    // RR-1: the requested session (sess_missing) has no registered target, so its runtime-auth refresh
    // still reports failure — but the rotation is a single by-construction transaction, so the OTHER
    // registered sibling (sess_other) is rematerialized AND notified. It must not be left holding the
    // superseded token just because a different session's target was absent.
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'primary' },
      affectedTargets: [expect.objectContaining({ pid: 125, sessionId: 'sess_other' })],
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
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'backup-old-access',
        refreshToken: 'backup-old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const sealedByServiceId = new Map<string, string>();
    const credentialKey = (serviceId: string, profileId: string) => `${serviceId}/${profileId}`;
    sealedByServiceId.set(credentialKey('openai-codex', 'work'), sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: openaiRecord,
      randomBytes: (length) => randomBytes(length),
    }));
    sealedByServiceId.set(credentialKey('openai-codex', 'backup'), sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    }));

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedByServiceId.get(credentialKey(params.serviceId, params.profileId))! },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: null, expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string; sealed: { ciphertext: string } }) => {
        sealedByServiceId.set(credentialKey(params.serviceId, params.profileId), params.sealed.ciphertext);
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async (input: any, init?: { body?: unknown }) => {
      const url = String(input);
      const refreshToken = init?.body instanceof URLSearchParams
        ? init.body.get('refresh_token')
        : init?.body instanceof Uint8Array
          ? new URLSearchParams(new TextDecoder().decode(init.body)).get('refresh_token')
          : typeof init?.body === 'string'
            ? new URLSearchParams(init.body).get('refresh_token')
            : null;
      if (url.includes('auth.openai.com') && refreshToken === 'old-refresh') {
        return { ok: false, status: 500, statusText: 'fail', text: async () => 'boom' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'backup-new-access',
          refresh_token: 'backup-new-refresh',
          expires_in: 3600,
        }),
        text: async () => '',
      } as any;
    });
    installGlobalFetchMock(fetchMock);

    const coordinator = createRefreshCoordinator({
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
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'backup' } },
      },
      materializationKey: 'session-openai-backup',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow();

    // Even though one binding refresh failed, the other binding should still have been refreshed and registered.
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'backup',
    }));
  });

  it('singleflights concurrent refreshes for one credential and uses the daemon owner id for the lease', async () => {
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

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
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
      await fetchGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      } as any;
    });
    installGlobalFetchMock(fetchMock);

    const coordinator = createRefreshCoordinator({
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

    const first = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    const second = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFetch();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual(['refreshed', 'refreshed']);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
    }));
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('keeps a joining spawn preflight behind completion when the shared result failed to rotate a credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-join-failed-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-join-failed-'));
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
    installGlobalFetchMock(vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    })));
    const coordinator = createRefreshCoordinator({
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
        content: { t: 'plain' as const, v: storedRecord },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async (params: { machineId: string }) => {
        leaseEntrants += 1;
        if (leaseEntrants === 2) resolveBothAtLease();
        if (params.machineId === 'machine-a') {
          await bothAtLease;
          return { acquired: true, leaseUntil: now + 60_000 };
        }
        await firstPersistence;
        return { acquired: true, leaseUntil: now + 60_000 };
      }),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof storedRecord } }) => {
        storedRecord = params.content.v;
        resolveFirstPersistence();
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const submittedRefreshTokens: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      const refreshToken = body instanceof URLSearchParams
        ? body.get('refresh_token')
        : body instanceof Uint8Array
          ? new URLSearchParams(new TextDecoder().decode(body)).get('refresh_token')
          : new URLSearchParams(String(body ?? '')).get('refresh_token');
      submittedRefreshTokens.push(refreshToken ?? '');
      if (submittedRefreshTokens.length > 1) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({ error: 'invalid_grant' }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }),
      } as Response;
    });
    installGlobalFetchMock(fetchMock);

    const createCoordinator = (machineId: string) => createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => machineId,
      ownerIdProvider: () => `${machineId}:daemon`,
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
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

    expect(resultA?.oauth?.accessToken).toBe('rotated-access');
    expect(resultB?.oauth?.accessToken).toBe('rotated-access');
    expect(submittedRefreshTokens).toEqual(['predecessor-refresh']);
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(2);
    for (const [healthUpdate] of updateConnectedServiceCredentialHealth.mock.calls) {
      expect(healthUpdate).toEqual(expect.objectContaining({
        expectedCredentialRevision: expect.any(String),
      }));
    }
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
    } as unknown as Response));
    installGlobalFetchMock(fetchMock);

    const coordinator = createRefreshCoordinator({
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
    expect(forcedResult?.oauth?.accessToken).toBe('forced-access');
  });

  it.each(['opencode', 'pi'] as const)(
    'preserves the applied %s request-auth purpose during external-credential rematerialization',
    async (agentId) => {
      const baseDir = await mkdtemp(join(tmpdir(), `happier-${agentId}-request-auth-remat-`));
      const activeServerDir = await mkdtemp(join(tmpdir(), `happier-${agentId}-request-auth-server-remat-`));
      const now = 1_000_000;
      const record = buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: now + 10 * 60_000,
        oauth: {
          accessToken: 'connected-access',
          refreshToken: 'connected-refresh',
          idToken: null,
          scope: null,
          tokenType: 'Bearer',
          providerAccountId: 'acct',
          providerEmail: null,
        },
      });
      const api = {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        })),
      } as unknown as ApiClient;
      const contributions = getResolvedContributionRegistry();
      const onAuthUpdated = vi.fn();
      const resolveQualifiedPurposeBindingSnapshot = vi.fn(async (input: Readonly<{
        agentId: CatalogAgentId;
        connectedServicesBindingsRaw: unknown;
      }>) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: input.agentId,
        bindings: ConnectedServiceBindingsV1Schema.parse(
          input.connectedServicesBindingsRaw,
        ),
        contributions,
      }));
      const coordinator = createRefreshCoordinator({
        api,
        credentials: { token: 'happy-token', encryption: null },
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
        resolveQualifiedPurposeBindingSnapshot,
        onAuthUpdated,
      });
      const connectedServicesBindingsRaw = {
        v: 1 as const,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'work',
          },
        },
      };
      coordinator.registerSpawnTarget({
        pid: agentId === 'opencode' ? 321 : 322,
        agentId,
        connectedServicesBindingsRaw,
        materializationKey: `session-${agentId}-request-auth-remat`,
      });

      await coordinator.handleExternalCredentialUpdate({
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialPresence: {
          status: 'present',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
        executionAuthority: 'fresh_user_action',
      });

      expect(resolveQualifiedPurposeBindingSnapshot).toHaveBeenCalledWith({
        agentId,
        connectedServicesBindingsRaw,
      });
      expect(onAuthUpdated).toHaveBeenCalledWith({
        binding: { serviceId: 'openai-codex', profileId: 'work' },
        affectedTargets: [
          expect.objectContaining({ agentId, materializationKey: `session-${agentId}-request-auth-remat` }),
        ],
        trigger: 'reconnect_propagation',
        credentialPresence: {
          status: 'present',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
        executionAuthority: 'fresh_user_action',
      });

      onAuthUpdated.mockClear();
      await coordinator.handleExternalCredentialUpdate({
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialPresence: {
          status: 'present',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
        executionAuthority: 'passive_projection',
      });

      expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
        binding: { serviceId: 'openai-codex', profileId: 'work' },
        executionAuthority: 'passive_projection',
      }));
    },
  );

  it.each(['missing', 'incomplete', 'valid'] as const)(
    '%s qualified purpose authority controls external-credential rematerialization',
    async (authorityState) => {
      const baseDir = await mkdtemp(join(tmpdir(), `happier-refresh-${authorityState}-purpose-authority-`));
      const activeServerDir = await mkdtemp(join(tmpdir(), `happier-refresh-${authorityState}-purpose-server-`));
      const now = 1_000_000;
      const record = buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: now + 10 * 60_000,
        oauth: {
          accessToken: 'connected-access',
          refreshToken: 'connected-refresh',
          idToken: null,
          scope: null,
          tokenType: 'Bearer',
          providerAccountId: 'acct',
          providerEmail: null,
        },
      });
      const api = {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        })),
      } as unknown as ApiClient;
      const connectedServicesBindingsRaw = {
        v: 1 as const,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'work',
          },
        },
      };
      const contributions = getResolvedContributionRegistry();
      const validSnapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: 'codex',
        bindings: ConnectedServiceBindingsV1Schema.parse(connectedServicesBindingsRaw),
        contributions,
      });
      expect(validSnapshot).not.toBeNull();
      const resolveQualifiedPurposeBindingSnapshot = vi.fn(async () => {
        if (authorityState === 'missing') return null;
        if (authorityState === 'incomplete') {
          return {
            purposes: validSnapshot?.purposes ?? Object.freeze([]),
            bindings: Object.freeze([]),
            requestAuthUses: validSnapshot?.requestAuthUses ?? Object.freeze([]),
          };
        }
        return validSnapshot;
      });
      const materializer = vi.fn(async (params: Readonly<{ rootDir: string }>) => ({
        env: { CODEX_HOME: params.rootDir },
        targetMaterializedRoot: params.rootDir,
        cleanupOnFailure: null,
        cleanupOnExit: null,
      }));
      materializeConnectedServicesForSpawnOverride.mockImplementation((agentId) =>
        agentId === 'codex' ? materializer : undefined,
      );
      const onAuthUpdated = vi.fn();
      const coordinator = createRefreshCoordinator({
        api,
        credentials: { token: 'happy-token', encryption: null },
        machineIdProvider: () => 'machine-1',
        activeServerDir,
        baseDir,
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => now,
        resolveQualifiedPurposeBindingSnapshot,
        onAuthUpdated,
      });
      coordinator.registerSpawnTarget({
        pid: 323,
        agentId: 'codex',
        connectedServicesBindingsRaw,
        materializationKey: `session-${authorityState}-purpose-authority`,
      });

      await coordinator.handleExternalCredentialUpdate({
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialPresence: {
          status: 'present',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
        executionAuthority: 'fresh_user_action',
      });

      expect(resolveQualifiedPurposeBindingSnapshot).toHaveBeenCalledOnce();
      if (authorityState === 'valid') {
        expect(materializer).toHaveBeenCalledOnce();
        expect(onAuthUpdated).toHaveBeenCalledOnce();
      } else {
        expect(materializer).not.toHaveBeenCalled();
        expect(onAuthUpdated).not.toHaveBeenCalled();
      }
    },
  );

  it('coalesces post-refresh rematerialization and auth-updated restart notification per binding', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-coalesce-remat-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-coalesce-remat-'));

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
        refreshToken: 'old-refresh',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          scope: 'user:inference user:profile user:sessions:claude_code',
          expires_in: 3600,
        }),
      };
    });
    installGlobalFetchMock(fetchMock);

    let materializerCalls = 0;
    let releaseFirstMaterialization: () => void = () => {};
    const firstMaterializationStarted = new Promise<void>((resolve) => {
      materializeConnectedServicesForSpawnOverride.mockImplementation(() => async (params: Readonly<{ rootDir: string }>) => {
        materializerCalls += 1;
        const callNumber = materializerCalls;
        await mkdir(params.rootDir, { recursive: true });
        if (callNumber === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirstMaterialization = release;
          });
        }
        await writeFile(join(params.rootDir, 'materialized.txt'), `${callNumber}\n`, 'utf8');
        return {
          env: { MATERIALIZED_ROOT: params.rootDir },
          targetMaterializedRoot: params.rootDir,
          cleanupOnFailure: null,
          cleanupOnExit: null,
        };
      });
    });
    let releaseAuthNotification: () => void = () => {};
    const authNotificationReleased = new Promise<void>((resolve) => {
      releaseAuthNotification = resolve;
    });
    const onAuthUpdated = vi.fn(async () => {
      await authNotificationReleased;
    });
    const coordinator = createRefreshCoordinator({
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
      sessionId: 'sess_1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-refresh-race',
    });

    const scheduled = coordinator.tickOnce();
    const forced = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      sessionId: 'sess_1',
    });

    await firstMaterializationStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstMaterialization();
    await vi.waitFor(() => expect(onAuthUpdated).toHaveBeenCalledTimes(1));
    releaseAuthNotification();

    const [, forcedResult] = await Promise.all([scheduled, forced]);

    expect(forcedResult.status).toBe('refreshed');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(materializerCalls).toBe(1);
    expect(onAuthUpdated).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectedServiceRefreshCoordinator Claude subscription bridge', () => {
  it('returns a setup-token credential as-is without refreshing (access-only, no rotation)', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: { token: 'sk-ant-oat01-setup-secret', providerAccountId: 'anthropic-acct', providerEmail: null },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-setup',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'setup' },
      expectedCredentialRevision: 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
    })).rejects.toThrow('connected_service_credential_revision_mismatch');
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'setup' },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(result).toEqual({
      accessToken: 'sk-ant-oat01-setup-secret',
      anthropicAccountId: 'anthropic-acct',
      expiresAt: null,
    });
    // Setup-tokens are non-rotating: no refresh request is made.
    expect(fetchMock).not.toHaveBeenCalled();
    // Access-only response carries no refresh token.
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('refreshes an OAuth credential and returns the rotated access token only (refresh stays in the store)', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: now + 1_000,
      oauth: {
        accessToken: 'old-claude-access',
        refreshToken: 'old-claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-claude-access',
        refresh_token: 'rotated-claude-refresh',
        expires_in: 3600,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
      }),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(result.accessToken).toBe('rotated-claude-access');
    expect(result.anthropicAccountId).toBe('claude-acct');
    // No refresh token in the bridge response.
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('rotated-claude-refresh');
    expect(JSON.stringify(result)).not.toContain('old-claude-refresh');
    // The rotated refresh token is persisted in the store (never returned).
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(record.oauth?.refreshToken).toBe('rotated-claude-refresh');
  });

  it('adopts a fresh stored Claude OAuth access token before forced bridge rotation when the failed token differs', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'store-already-rotated-access',
        refreshToken: 'store-current-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const failingAccessTokenFingerprint = computeClaudeSubscriptionAccessTokenFingerprint('old-failed-access');
    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      forceRefresh: true,
      shouldAdoptCurrentAccessToken: (accessToken) =>
        computeClaudeSubscriptionAccessTokenFingerprint(accessToken) !== failingAccessTokenFingerprint,
    });

    expect(result.accessToken).toBe('store-already-rotated-access');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  // Invariant guard (CLOSE-18 adopt-fresh-first): pins the BEHAVIOR, not a file path — a forced
  // reactive refresh whose store token differs from the failing token must ADOPT the store token
  // (no rotation, no refresh-token burn) even when that store token sits INSIDE the refresh-expiry
  // window. If a future migration drops adopt-fresh-first or re-over-gates it on the expiry window,
  // this test fails.
  it('INVARIANT: adopts a near-expiry (within refresh window) fresh Claude OAuth token before forced bridge rotation when the failed token differs', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      // Inside the 60s refresh window (near expiry) but NOT past expiry: the store already rotated
      // to this token, so a concurrent 401 retry must adopt it instead of burning the refresh token.
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'store-already-rotated-access',
        refreshToken: 'store-current-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const failingAccessTokenFingerprint = computeClaudeSubscriptionAccessTokenFingerprint('old-failed-access');
    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      forceRefresh: true,
      shouldAdoptCurrentAccessToken: (accessToken) =>
        computeClaudeSubscriptionAccessTokenFingerprint(accessToken) !== failingAccessTokenFingerprint,
    });

    expect(result.accessToken).toBe('store-already-rotated-access');
    // Adopted, not rotated: no provider call, no lease, no re-persist — the refresh token is preserved.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('F6: returns the current Claude OAuth access token WITHOUT a rotation when not forced and the token is still valid', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      // Far from expiry so a non-forced refresh returns the current token without rotating.
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'current-valid-claude-access',
        refreshToken: 'current-claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;
    completeCredentialAuthorityBoundaryFixture(api);

    const coordinator = createRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      forceRefresh: false,
    });

    expect(result.accessToken).toBe('current-valid-claude-access');
    expect(result.anthropicAccountId).toBe('claude-acct');
    expect(result.expiresAt).toBe(now + 3_600_000);
    // No provider call, no lease, no rotation when the current token is still valid.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    // No refresh token in the bridge response.
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('current-claude-refresh');
  });
});
