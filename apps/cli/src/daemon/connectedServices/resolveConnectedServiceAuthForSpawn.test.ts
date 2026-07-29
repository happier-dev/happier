import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceAuthGroupV1Schema,
  buildProviderAccountUsageRecordId,
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
} from './accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { buildConnectedServiceAuthGroupSwitchState } from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  ConnectedServiceLegacyUnfencedAuthorityError,
  persistMaterializationFailureCredentialHealthForSpawn,
  resolveConnectedServiceAuthForSpawn,
} from './resolveConnectedServiceAuthForSpawn';
import type { ConnectedServicesMaterializationDiagnostic } from './materialization/materializer';
import type { ConnectedServiceCredentialRefreshResult } from './refresh/ConnectedServiceRefreshCoordinator';
import {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
} from '@happier-dev/plugins-claude/agent';
import {
  PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-codex';
import {
  CODEX_AGENT_RUNTIME_CONTRIBUTION,
} from '@happier-dev/plugins-codex/agent/contributions/runtime';
import {
  resolveQualifiedPurposeBindingsForAgentSpawn,
  resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn,
} from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';

type SpawnPreflightRefreshService = Readonly<{
  refreshConnectedServiceCredentialForSpawnPreflight(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
  }>): Promise<ConnectedServiceCredentialRefreshResult>;
}>;

type SpawnAuthGroupSwitchCoordinator = NonNullable<
  Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator']
> & Readonly<{
  switchAfterClassifiedFailure(params: Readonly<{
    sessionId?: string;
    serviceId: string;
    groupId: string;
    reason: 'refresh_failed';
    observedProfileId?: string | null;
  }>): Promise<Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
  }>>;
}>;

const exactOldServerContract = {
  mode: 'released_server_v0_2_1' as const,
  sessionConnectionEpoch: 9,
  socket: { connected: true },
};

async function readClaudeCodeNativeCredential(claudeConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
}

async function createIsolatedClaudeSourceEnv(): Promise<NodeJS.ProcessEnv> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-home-'));
  const claudeConfigDir = join(homeDir, '.claude');
  await mkdir(join(claudeConfigDir, 'projects'), { recursive: true });
  return {
    HOME: homeDir,
    USER: 'happier-test-user',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}

function createProviderAccountUsageSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'openai-codex',
    accountSubjectId: `acct-${profileId}`,
    subjectKind: 'subscription',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'openai-codex',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 100 - remainingPct,
      limit: 100,
      remaining: remainingPct,
      remainingPct,
      usedPct: 100 - remainingPct,
      utilizationPct: 100 - remainingPct,
      resetsAt: null,
      resetAtMs: null,
      unit: 'credits',
      status: 'ok',
      limitScope: 'account',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

async function createSpawnPreTurnSwitchScenario(input: Readonly<{
  switchResult: Readonly<{
    status: string;
    activeProfileId?: string | null;
    generation?: number;
    errorCode?: string;
  }>;
  rereadGroup?: Readonly<Record<string, unknown>> | null;
  rereadError?: Error;
}>) {
  const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-single-spawn-switch-test-'));
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-single-spawn-switch-server-test-'));
  const credentials: Credentials = {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
  };
  const recordsByProfileId = new Map([
    ['primary', buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    })],
    ['backup', buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    })],
  ]);
  const group = {
    v: 1 as const,
    serviceId: 'openai-codex' as const,
    groupId: 'codex-main',
    displayName: 'Codex main',
    policy: {
      v: 1 as const,
      strategy: 'priority' as const,
      autoSwitch: true,
      softSwitchRemainingPercent: 15,
      preTurnProbeMode: 'when_stale' as const,
      preTurnProbeOrder: 'current_first_then_candidates' as const,
    },
    activeProfileId: 'primary',
    generation: 5,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 2,
    members: [
      {
        v: 1 as const,
        serviceId: 'openai-codex' as const,
        groupId: 'codex-main',
        profileId: 'primary',
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 2,
      },
      {
        v: 1 as const,
        serviceId: 'openai-codex' as const,
        groupId: 'codex-main',
        profileId: 'backup',
        priority: 2,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };
  let groupReadCount = 0;
  const getConnectedServiceAuthGroup = vi.fn(async () => {
    groupReadCount += 1;
    if (groupReadCount === 1) return group;
    if (input.rereadError) throw input.rereadError;
    return input.rereadGroup === undefined ? group : input.rereadGroup;
  });
  const getConnectedServiceCredentialPlain = vi.fn(async (params: {
    serviceId: string;
    profileId: string;
  }) => {
    const record = params.serviceId === 'openai-codex'
      ? recordsByProfileId.get(params.profileId)
      : null;
    return record
      ? {
          revisionSemantics: 'revisioned' as const,
          credentialRevision: params.profileId === 'primary'
            ? 'csr_0123456789ABCDEFGHJKMNPQRS'
            : 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
          content: { t: 'plain' as const, v: record },
        }
      : null;
  });
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceAuthGroup,
    listConnectedServiceProfiles: vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profiles: [
        { profileId: 'primary', status: 'connected' as const },
        { profileId: 'backup', status: 'connected' as const },
      ],
    })),
    getConnectedServiceCredentialPlain,
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
  } as unknown as ApiClient;
  const accountUsageStore = {
    resolveBySource: vi.fn((source: {
      serviceId: string;
      profileId: string;
      groupId?: string | null;
      groupGeneration?: number | null;
    }) => {
      if (
        source.serviceId !== 'openai-codex'
        || source.groupId !== 'codex-main'
        || source.groupGeneration !== 5
      ) {
        return null;
      }
      if (source.profileId === 'primary') return createProviderAccountUsageSnapshot('primary', 5);
      if (source.profileId === 'backup') return createProviderAccountUsageSnapshot('backup', 60);
      return null;
    }),
  };
  const switchBeforeTurn = vi.fn(async () => input.switchResult);

  return {
    getConnectedServiceAuthGroup,
    getConnectedServiceCredentialPlain,
    switchBeforeTurn,
    run: async () => await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
          },
        },
      },
      materializationKey: 'session-single-spawn-switch',
      activeServerDir,
      baseDir,
      credentials,
      api,
      accountUsageStore,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      sessionId: 'session-single-spawn-switch',
      authGroupSwitchCoordinator: { switchBeforeTurn },
    } as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
      accountUsageStore: typeof accountUsageStore;
    }),
  };
}

describe('resolveConnectedServiceAuthForSpawn', () => {
  it('fetches, decrypts, and materializes auth for a spawn', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 1_700_000_000_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'work') return null;
        return {
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
        };
      },
    } as unknown as ApiClient;
    const actualCodexRequestAuthUses = (
      CODEX_AGENT_RUNTIME_CONTRIBUTION.connectedServices as Readonly<{
        requestAuthUses?: unknown;
      }>
    ).requestAuthUses;
    expect(actualCodexRequestAuthUses).toBeUndefined();
    const codexContributions = {
      agentDefinitionsById: new Map([['codex', {
        identity: {
          pluginId: CODEX_PLUGIN_MANIFEST.id,
          localId: CODEX_PLUGIN_MANIFEST.contributes.agents[0]!.id,
        },
        richDefinition: {
          definition: CODEX_PLUGIN_MANIFEST.contributes.agents[0]!,
        },
        catalogEntry: actualCodexRequestAuthUses === undefined
          ? {}
          : {
              connectedAccountRequestAuthUses:
                actualCodexRequestAuthUses,
            },
      }]]),
    };

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1 as const,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'work',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      resolveRequestAuthPurposeBindings: (resolvedBindings) =>
        resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn({
          agentId: 'codex',
          bindings: resolvedBindings,
          contributions: codexContributions,
        }),
    });

    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth!.requestAuthPurposeBindings).toEqual([]);
    expect(resolveQualifiedPurposeBindingsForAgentSpawn({
      agentId: 'codex',
      bindings: connectedServiceAuth!.connectedServicesBindings,
      contributions: codexContributions,
    })).toHaveLength(1);
    expect(connectedServiceAuth!.env.CODEX_HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home'),
    );
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('access');
  });

  it('materializes the real built-in Codex legacy path once but refuses qualified request-auth authority', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-legacy-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-legacy-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 1_700_000_000_000,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        idToken: 'legacy-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'legacy-account',
        providerEmail: null,
      },
    });
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const forbiddenProviderEffects = {
      registerConnectedServiceCredentialPlain: vi.fn(),
      registerConnectedServiceCredentialSealed: vi.fn(),
      acquireConnectedServiceRefreshLease: vi.fn(),
      updateConnectedServiceAuthGroupActiveProfile: vi.fn(),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(),
    };
    const switchBeforeTurn = vi.fn();
    const switchAfterClassifiedFailure = vi.fn();
    const api = {
      getServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'ready' as const,
        features: {
          features: {
            sharing: {
              pendingQueueV2: { enabled: true },
            },
          },
          capabilities: {},
        },
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{
          profileId: 'work',
          status: 'connected' as const,
          kind: 'oauth' as const,
        }],
      })),
      getConnectedServiceCredentialSealed: async () => ({
        // Released server-v0.2.1 shape: no revisionSemantics or credentialRevision.
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth' as const,
          providerEmail: null,
          providerAccountId: 'legacy-account',
          expiresAt: null,
        },
      }),
      updateConnectedServiceCredentialHealth: vi.fn(),
      ...forbiddenProviderEffects,
    } as unknown as ApiClient;
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn();
    const common = {
      agentId: 'codex' as const,
      connectedServicesBindingsRaw: {
        v: 1 as const,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'work',
          },
        },
      },
      activeServerDir,
      baseDir,
      credentials,
      api,
      serverContract: exactOldServerContract,
      authGroupSwitchCoordinator: {
        switchBeforeTurn,
        switchAfterClassifiedFailure,
      },
    };
    const codexContributions = {
      agentDefinitionsById: new Map([['codex', {
        identity: {
          pluginId: CODEX_PLUGIN_MANIFEST.id,
          localId: CODEX_PLUGIN_MANIFEST.contributes.agents[0]!.id,
        },
        richDefinition: {
          definition: CODEX_PLUGIN_MANIFEST.contributes.agents[0]!,
        },
      }]]),
    };

    await expect(resolveConnectedServiceAuthForSpawn({
      ...common,
      materializationKey: 'legacy-direct',
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
      resolveRequestAuthPurposeBindings: (bindings) =>
        resolveQualifiedPurposeBindingsForAgentSpawn({
          agentId: 'codex',
          bindings,
          contributions: codexContributions,
        }),
      allowLegacyUnfencedOneShotMaterialization: true,
    })).resolves.toMatchObject({
      ongoingRuntimeRegistrationAllowed: false,
      requestAuthPurposeBindings: [],
      connectedServicesBindings: {
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight)
      .not.toHaveBeenCalled();
    expect(
      (api as unknown as {
        updateConnectedServiceCredentialHealth: ReturnType<typeof vi.fn>;
      }).updateConnectedServiceCredentialHealth,
    ).not.toHaveBeenCalled();
    for (const effect of Object.values(forbiddenProviderEffects)) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    expect(resolveQualifiedPurposeBindingsForAgentSpawn({
      agentId: 'codex',
      bindings: common.connectedServicesBindingsRaw,
      contributions: codexContributions,
    })).toHaveLength(1);
    const materializedAuth = JSON.parse(
      await readFile(
        join(activeServerDir, 'daemon', 'connected-services', 'homes',
          'openai-codex', 'work', 'codex', 'codex-home', 'auth.json'),
        'utf8',
      ),
    ) as Readonly<Record<string, unknown>>;
    expect(materializedAuth.access_token).toBe('legacy-access');

    await expect(resolveConnectedServiceAuthForSpawn({
      ...common,
      materializationKey: 'legacy-request-auth',
      resolveRequestAuthPurposeBindings: () => [{
        purpose: {
          consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
          purpose: 'model-request',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            accountId: 'work',
          },
        },
      }],
    })).rejects.toBeInstanceOf(
      ConnectedServiceLegacyUnfencedAuthorityError,
    );

    const indeterminateActiveServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-indeterminate-legacy-server-test-',
    ));
    await expect(resolveConnectedServiceAuthForSpawn({
      ...common,
      api: {
        ...api,
        getServerFeaturesSnapshot: vi.fn(async () => ({
          status: 'error' as const,
          reason: 'network',
        })),
      } as unknown as ApiClient,
      serverContract: null,
      activeServerDir: indeterminateActiveServerDir,
      materializationKey: 'indeterminate-legacy-direct',
      resolveRequestAuthPurposeBindings: (bindings) =>
        resolveQualifiedPurposeBindingsForAgentSpawn({
          agentId: 'codex',
          bindings,
          contributions: codexContributions,
        }),
      allowLegacyUnfencedOneShotMaterialization: true,
    })).rejects.toMatchObject({
      code: 'connected_service_legacy_unfenced_authority_unsupported',
      operation: 'materialization',
    });
    await expect(readFile(
      join(indeterminateActiveServerDir, 'daemon', 'connected-services',
        'homes', 'openai-codex', 'work', 'codex', 'codex-home', 'auth.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses exact-old Claude multi-mode one-shot before materialization', async () => {
    const baseDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-exact-old-claude-test-',
    ));
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-exact-old-claude-server-test-',
    ));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'legacy-claude-access',
        refreshToken: 'legacy-claude-refresh',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'legacy-claude-account',
        providerEmail: null,
      },
    });
    const getConnectedServiceCredentialPlain = vi.fn(async () => ({
      revisionSemantics: 'legacy_unfenced' as const,
      credentialRevision: null,
      content: { t: 'plain' as const, v: record },
    }));
    const api = {
      getServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'ready' as const,
        features: {
          features: {
            sharing: {
              pendingQueueV2: { enabled: true },
            },
          },
          capabilities: {},
        },
      })),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [{
          profileId: 'work',
          status: 'connected' as const,
          kind: 'oauth' as const,
        }],
      })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      },
      materializationKey: 'legacy-claude',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(7),
        },
      },
      api,
      serverContract: exactOldServerContract,
      allowLegacyUnfencedOneShotMaterialization: true,
      processEnv: await createIsolatedClaudeSourceEnv(),
    })).rejects.toMatchObject({
      code: 'connected_service_legacy_unfenced_authority_unsupported',
      operation: 'materialization',
    });
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledOnce();
  });

  it('fails closed when a guarded spawn refresh reread loses credential revision authority', async () => {
    const baseDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-refresh-reread-fence-test-',
    ));
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-refresh-reread-fence-server-test-',
    ));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 100,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'account',
        providerEmail: null,
      },
    });
    const getConnectedServiceCredentialPlain = vi.fn()
      .mockResolvedValueOnce({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        content: { t: 'plain' as const, v: record },
      })
      .mockResolvedValueOnce({
        revisionSemantics: 'legacy_unfenced' as const,
        credentialRevision: null,
        content: { t: 'plain' as const, v: record },
      });
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn(
      async (): Promise<ConnectedServiceCredentialRefreshResult> => ({
        status: 'not_needed',
        credential: record,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        diagnostic: {
          serviceId: 'openai-codex',
          profileId: 'work',
          reason: 'spawn_preflight',
          status: 'not_needed',
          expiresAt: 100,
          expiryAgeMs: null,
          refreshWindowMs: 60_000,
        },
      }),
    );

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      },
      materializationKey: 'refresh-reread-fence',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(7),
        },
      },
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'openai-codex' as const,
          profiles: [{
            profileId: 'work',
            status: 'connected' as const,
            kind: 'oauth' as const,
          }],
        })),
        getConnectedServiceCredentialPlain,
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      } as unknown as ApiClient,
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      code: 'connected_service_legacy_unfenced_authority_unsupported',
      operation: 'materialization',
    });
    expect(refreshConnectedServiceCredentialForSpawnPreflight)
      .toHaveBeenCalledOnce();
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(2);
    await expect(readFile(
      join(activeServerDir, 'daemon', 'connected-services', 'homes',
        'openai-codex', 'work', 'codex', 'codex-home', 'auth.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an exact-old group before list, group, credential, switch, refresh, or health effects', async () => {
    const baseDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-exact-old-group-test-',
    ));
    const activeServerDir = await mkdtemp(join(
      tmpdir(),
      'happier-connected-services-exact-old-group-server-test-',
    ));
    const getConnectedServiceAuthGroup = vi.fn();
    const listConnectedServiceProfiles = vi.fn();
    const getConnectedServiceCredentialPlain = vi.fn();
    const switchBeforeTurn = vi.fn();
    const refreshConnectedServiceCredentialForSpawnPreflight = vi.fn();
    const updateConnectedServiceCredentialHealth = vi.fn();
    const api = {
      getServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'ready' as const,
        features: {
          features: {
            sharing: {
              pendingQueueV2: { enabled: true },
            },
          },
          capabilities: {},
        },
      })),
      getConnectedServiceAuthGroup,
      listConnectedServiceProfiles,
      getConnectedServiceCredentialPlain,
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
          },
        },
      },
      materializationKey: 'legacy-group',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(7),
        },
      },
      api,
      serverContract: exactOldServerContract,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      credentialRefreshService: {
        refreshConnectedServiceCredentialForSpawnPreflight,
      },
    })).rejects.toMatchObject({
      code: 'connected_service_legacy_unfenced_authority_unsupported',
      operation: 'group',
    });
    expect(listConnectedServiceProfiles).not.toHaveBeenCalled();
    expect(getConnectedServiceAuthGroup).not.toHaveBeenCalled();
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(refreshConnectedServiceCredentialForSpawnPreflight)
      .not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).not.toHaveBeenCalled();
  });

  it('resolves group bindings through the active auth-group profile and materializes a stable group home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-group-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceAuthGroup: async (params: { serviceId: string; groupId: string }) => {
        if (params.serviceId !== 'openai-codex' || params.groupId !== 'codex-main') return null;
        return {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          displayName: 'Codex main',
          policy: { v: 1 },
          activeProfileId: 'backup',
          generation: 5,
          state: { status: 'ready', lastSwitchAt: 12 },
          createdAt: 1,
          updatedAt: 2,
          members: [
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'codex-main',
              profileId: 'work',
              priority: 1,
              enabled: true,
              state: { cooldownUntilMs: null },
              createdAt: 1,
              updatedAt: 2,
            },
            {
              v: 1,
              serviceId: 'openai-codex',
              groupId: 'codex-main',
              profileId: 'backup',
              priority: 2,
              enabled: true,
              state: { cooldownUntilMs: null },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      },
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'backup') return null;
        return {
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct-backup', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    });

    expect(connectedServiceAuth).not.toBeNull();
    expect(connectedServiceAuth!.env.CODEX_HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'codex-main', 'codex', 'codex-home'),
    );
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
    expect(connectedServiceAuth!.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON).toContain('"kind":"group"');
  });

  it('rejects group bindings when the server group has no active profile', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-missing-active-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-missing-active-test-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
    };

    const api = {
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        displayName: 'Codex main',
        policy: { v: 1 },
        activeProfileId: null,
        generation: 5,
        state: { status: 'ready', lastSwitchAt: 12 },
        createdAt: 1,
        updatedAt: 2,
        members: [],
      }),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
    })).rejects.toThrow(/no active profile/);
  });

  it('fails typed without performing raw CAS when an exhausted group needs the canonical switch owner', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-switch-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-switch-test-'));

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
    };

    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const group = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: { v: 1 as const, strategy: 'least_limited' as const, autoSwitch: true },
      activeProfileId: 'primary',
      generation: 5,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: { quotaExhaustedUntilMs: 5_000 },
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async () => ({
      ...group,
      activeProfileId: 'backup',
      generation: 6,
    }));
    const api = {
      getConnectedServiceAuthGroup: async () => group,
      updateConnectedServiceAuthGroupActiveProfile,
      getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
        const { serviceId, profileId } = params;
        if (serviceId !== 'openai-codex' || profileId !== 'backup') return null;
        return {
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct-backup', expiresAt: null },
        };
      },
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceAuthGroupSwitchCoordinatorUnavailableError',
      kind: 'switch_coordinator_unavailable',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      activeProfileId: 'primary',
      selectedProfileId: 'backup',
      reason: 'usage_limit',
    });

    expect(updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
  });

  it('does not perform spawn-time soft switching without source-backed provider account usage', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-probe-switch-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-probe-server-switch-test-'));
    const now = 1_000;
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const ciphertextByProfileId = new Map([
      ['primary', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: primaryRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['backup', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: backupRecord,
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    const group = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: {
        v: 1 as const,
        strategy: 'priority' as const,
        autoSwitch: true,
        softSwitchRemainingPercent: 15,
        preTurnProbeMode: 'when_stale' as const,
        preTurnProbeOrder: 'current_first_then_candidates' as const,
      },
      activeProfileId: 'primary',
      generation: 5,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = params.serviceId === 'openai-codex'
          ? ciphertextByProfileId.get(params.profileId)
          : null;
        return ciphertext
          ? {
              revisionSemantics: 'revisioned' as const,
              credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
              sealed: { format: 'account_scoped_v1' as const, ciphertext },
              metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `acct-${params.profileId}`, expiresAt: null },
            }
          : null;
      }),
    } as unknown as ApiClient;
    const authGroupSwitchCoordinator = {
      switchBeforeTurn: vi.fn(async () => ({
        status: 'switched',
        activeProfileId: 'backup',
        generation: 6,
      })),
    };
    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-stale-probe',
      activeServerDir,
      baseDir,
      credentials,
      api,
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator,
    });

    expect(authGroupSwitchCoordinator.switchBeforeTurn).not.toHaveBeenCalled();
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('primary-access');
  });

  it('uses source-backed provider account usage for spawn-time group switching without runtime quota snapshots', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-probe-account-usage-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-probe-account-usage-server-test-'));
    const now = 1_000;
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const ciphertextByProfileId = new Map([
      ['primary', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: primaryRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['backup', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: backupRecord,
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    const group = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: {
        v: 1 as const,
        strategy: 'priority' as const,
        autoSwitch: true,
        softSwitchRemainingPercent: 15,
        preTurnProbeMode: 'when_stale' as const,
        preTurnProbeOrder: 'current_first_then_candidates' as const,
      },
      activeProfileId: 'primary',
      generation: 5,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const accountUsageStore = {
      resolveBySource: vi.fn((source: { serviceId: string; profileId: string; groupId?: string | null; groupGeneration?: number | null }) => {
        if (
          source.serviceId !== 'openai-codex'
          || source.groupId !== 'codex-main'
          || source.groupGeneration !== 5
        ) {
          return null;
        }
        if (source.profileId === 'primary') return createProviderAccountUsageSnapshot('primary', 5);
        if (source.profileId === 'backup') return createProviderAccountUsageSnapshot('backup', 60);
        return null;
      }),
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = params.serviceId === 'openai-codex'
          ? ciphertextByProfileId.get(params.profileId)
          : null;
        return ciphertext
          ? {
              revisionSemantics: 'revisioned' as const,
              credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
              sealed: { format: 'account_scoped_v1' as const, ciphertext },
              metadata: { kind: 'oauth', providerEmail: null, providerAccountId: `acct-${params.profileId}`, expiresAt: null },
            }
          : null;
      }),
    } as unknown as ApiClient;
    const authGroupSwitchCoordinator = {
      switchBeforeTurn: vi.fn(async () => ({
        status: 'superseded_after_apply',
        activeProfileId: 'backup',
        generation: 6,
        credentialRevision: null,
        adoptedProfileId: 'primary',
        adoptedGeneration: 5,
        adoptedCredentialRevision: null,
        reconciliationDisposition: 'superseded_after_apply',
      })),
    };

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-stale-probe-account-usage',
      activeServerDir,
      baseDir,
      credentials,
      api,
      accountUsageStore,
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator,
    } as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & { accountUsageStore: typeof accountUsageStore });

    expect(accountUsageStore.resolveBySource).toHaveBeenCalled();
    expect(authGroupSwitchCoordinator.switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      reason: 'soft_threshold',
    });
    expect(authGroupSwitchCoordinator.switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceAuthGroup).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('rereads authoritative group truth after one ambiguous spawn switch result without local reselection', async () => {
    const scenario = await createSpawnPreTurnSwitchScenario({
      switchResult: {
        status: 'generation_apply_failed',
        activeProfileId: 'backup',
        generation: 6,
        errorCode: 'provider_apply_failed',
      },
      rereadGroup: {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        displayName: 'Codex main',
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          softSwitchRemainingPercent: 15,
          preTurnProbeMode: 'when_stale',
          preTurnProbeOrder: 'current_first_then_candidates',
        },
        activeProfileId: 'backup',
        generation: 6,
        runtimeStateRevision: 1,
        state: {},
        createdAt: 1,
        updatedAt: 3,
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: 'primary',
            priority: 1,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 2,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            profileId: 'backup',
            priority: 2,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    });

    const connectedServiceAuth = await scenario.run();

    expect(scenario.switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(scenario.getConnectedServiceAuthGroup).toHaveBeenCalledTimes(2);
    expect(scenario.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('fails closed after one ambiguous spawn switch result when authoritative group truth is missing', async () => {
    const scenario = await createSpawnPreTurnSwitchScenario({
      switchResult: {
        status: 'predictive_apply_unavailable',
        activeProfileId: 'backup',
        generation: 6,
        errorCode: 'restart_required',
      },
      rereadGroup: null,
    });

    await expect(scenario.run()).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnAuthGroupAuthorityError',
      kind: 'group_missing',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
    });
    expect(scenario.switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(scenario.getConnectedServiceAuthGroup).toHaveBeenCalledTimes(2);
    expect(scenario.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('keeps server group truth when real coordinator preflight rejects the proposed spawn switch', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-authority-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-authority-server-test-'));
    const now = 1_000;
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });
    const group = ConnectedServiceAuthGroupV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: {
        v: 1,
        strategy: 'least_limited',
        autoSwitch: true,
        softSwitchRemainingPercent: 15,
        preTurnProbeMode: 'when_stale',
        preTurnProbeOrder: 'current_first_then_candidates',
      },
      activeProfileId: 'primary',
      generation: 1,
      runtimeStateRevision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    const accountUsageStore = {
      resolveBySource: vi.fn((source: { serviceId: string; profileId: string; groupId?: string | null; groupGeneration?: number | null }) => {
        if (
          source.serviceId !== 'openai-codex'
          || source.groupId !== 'codex-main'
          || source.groupGeneration !== 1
        ) {
          return null;
        }
        if (source.profileId === 'primary') return createProviderAccountUsageSnapshot('primary', 5);
        if (source.profileId === 'backup') return createProviderAccountUsageSnapshot('backup', 80);
        return null;
      }),
    };
    const serverState = {
      ...buildConnectedServiceAuthGroupSwitchState({
        group,
        runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
        nowMs: now,
      }),
      memberStatesByProfileId: new Map([
        ['primary', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 5 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: now, effectiveRemainingPercent: 80 } }],
      ]),
    };
    const commitSwitch = vi.fn(async () => ({ ...serverState, activeProfileId: 'backup', generation: 2 }));
    const applyGeneration = vi.fn(async () => ({ ok: true as const }));
    const preflightApplyGeneration = vi.fn(async () => ({
      ok: true as const,
      mode: 'restart_resume' as const,
    }));
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => now,
      quotaFreshnessMs: 60_000,
      loadState: async () => serverState,
      commitSwitch,
      applyGeneration,
      preflightApplyGeneration,
    });
    const getConnectedServiceCredentialPlain = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex') return null;
      const record = params.profileId === 'primary'
        ? primaryRecord
        : params.profileId === 'backup'
          ? backupRecord
          : null;
      return record ? {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: params.profileId === 'primary'
          ? 'csr_0123456789ABCDEFGHJKMNPQRS'
          : 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
        content: { t: 'plain' as const, v: record },
      } : null;
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-preflight-authority',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
      },
      api,
      accountUsageStore,
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      sessionId: 'session-preflight-authority',
      authGroupSwitchCoordinator: coordinator,
    } as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & { accountUsageStore: typeof accountUsageStore });

    expect(preflightApplyGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-preflight-authority',
      activeProfileId: 'backup',
      generation: 2,
      reason: 'soft_threshold',
    }));
    expect(commitSwitch).not.toHaveBeenCalled();
    expect(applyGeneration).not.toHaveBeenCalled();
    expect(group).toMatchObject({ activeProfileId: 'primary', generation: 1 });
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
    });
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(connectedServiceAuth?.connectedServicesBindings.bindingsByServiceId['openai-codex']).toEqual({
      source: 'connected',
      selection: 'group',
      groupId: 'codex-main',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('primary-access');
  });

  it('does not consult recovery suppression when no source-backed spawn switch is eligible', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-probe-suppressed-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-probe-suppressed-server-test-'));
    const now = 1_000;
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }
    const primaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });
    const group = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: {
        v: 1 as const,
        strategy: 'priority' as const,
        autoSwitch: true,
        softSwitchRemainingPercent: 15,
        preTurnProbeMode: 'when_stale' as const,
        preTurnProbeOrder: 'current_first_then_candidates' as const,
      },
      activeProfileId: 'primary',
      generation: 5,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        sealed: { format: 'account_scoped_v1' as const, ciphertext: primaryCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct-primary', expiresAt: null },
      })),
    } as unknown as ApiClient;
    const authGroupSwitchCoordinator = {
      switchBeforeTurn: vi.fn(async () => ({
        status: 'switched',
        activeProfileId: 'backup',
        generation: 6,
      })),
    };

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-stale-probe-suppressed',
      activeServerDir,
      baseDir,
      credentials,
      api,
      quotaFreshnessMs: 60_000,
      nowMs: () => now,
      sessionId: 'session-1',
      authGroupSwitchCoordinator,
    });

    expect(authGroupSwitchCoordinator.switchBeforeTurn).not.toHaveBeenCalled();
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('primary-access');
  });

  it('rejects explicit spawn profile selections that need reauth with a typed action requirement', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-profile-health-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-profile-health-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const getConnectedServiceCredentialPlain = vi.fn(async () => ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      content: { t: 'plain' as const, v: record },
    }));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'needs_reauth' as const },
        ],
      })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'primary' },
        },
      },
      materializationKey: 'session-profile-health',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
      },
      api,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnProfileActionRequiredError',
      kind: 'profile_action_required',
      action: 'reconnect_connected_service_profile',
      serviceId: 'openai-codex',
      profileId: 'primary',
      status: 'needs_reauth',
    });
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('lets a server-classified unsupported legacy credential reach provider materialization diagnostics', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-legacy-unsupported-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-legacy-unsupported-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'gemini',
      profileId: 'legacy-oauth',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'legacy-account',
        providerEmail: null,
      },
    });
    const getConnectedServiceCredentialPlain = vi.fn(async () => ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      content: { t: 'plain' as const, v: record },
    }));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'gemini' as const,
        profiles: [{
          profileId: 'legacy-oauth',
          status: 'needs_reauth' as const,
          kind: 'oauth' as const,
        }],
      })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'gemini',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          gemini: { source: 'connected', profileId: 'legacy-oauth' },
        },
      },
      materializationKey: 'session-legacy-unsupported',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
      },
      api,
    })).rejects.toMatchObject({
      code: 'connected_service_materialization_blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'gemini_oauth_deferred_api_key_or_vertex_required',
          serviceId: 'gemini',
          severity: 'blocking',
        }),
      ]),
    });
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'gemini',
      profileId: 'legacy-oauth',
    });
  });

  it('fails typed without raw CAS when profile health requires the canonical switch owner', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-health-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-health-server-test-'));
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });
    const group = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: { v: 1 as const, strategy: 'priority' as const, autoSwitch: true },
      activeProfileId: 'primary',
      generation: 5,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn(async () => ({
      ...group,
      activeProfileId: 'backup',
      generation: 6,
    }));
    const getConnectedServiceCredentialPlain = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex') return null;
      const record = params.profileId === 'primary'
        ? primaryRecord
        : params.profileId === 'backup'
          ? backupRecord
          : null;
      return record ? {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: params.profileId === 'primary'
          ? 'csr_0123456789ABCDEFGHJKMNPQRS'
          : 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
        content: { t: 'plain' as const, v: record },
      } : null;
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      updateConnectedServiceAuthGroupActiveProfile,
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'needs_reauth' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-group-health',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
      },
      api,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceAuthGroupSwitchCoordinatorUnavailableError',
      kind: 'switch_coordinator_unavailable',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      activeProfileId: 'primary',
      selectedProfileId: 'backup',
      reason: 'auth_expired',
    });

    expect(updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('carries profile health into coordinator-backed group switching before materializing spawn auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-coordinator-health-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-coordinator-health-server-test-'));
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'primary-access',
        refreshToken: 'primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });
    const group = ConnectedServiceAuthGroupV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: { v: 1, strategy: 'priority', autoSwitch: true },
      activeProfileId: 'primary',
      generation: 5,
      runtimeStateRevision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    const committedProfileIds: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => buildConnectedServiceAuthGroupSwitchState({
        group,
        runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
        nowMs: 1_000,
      }),
      commitSwitch: async (input) => {
        committedProfileIds.push(input.toProfileId);
        return {
          ...buildConnectedServiceAuthGroupSwitchState({
            group,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            nowMs: 1_000,
          }),
          activeProfileId: input.toProfileId,
          generation: 6,
        };
      },
      applyGeneration: async () => ({ ok: true }),
    });
    const getConnectedServiceCredentialPlain = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex') return null;
      const record = params.profileId === 'primary'
        ? primaryRecord
        : params.profileId === 'backup'
          ? backupRecord
          : null;
      return record ? {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: params.profileId === 'primary'
          ? 'csr_0123456789ABCDEFGHJKMNPQRS'
          : 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1',
        content: { t: 'plain' as const, v: record },
      } : null;
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [
          { profileId: 'primary', status: 'needs_reauth' as const },
          { profileId: 'backup', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;

    const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-group-coordinator-health',
      activeServerDir,
      baseDir,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(4) },
      },
      api,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
      sessionId: 'sess-coordinator-health',
      authGroupSwitchCoordinator: coordinator,
    });

    expect(committedProfileIds).toEqual(['backup']);
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
    expect(connectedServiceAuth).not.toBeNull();
    const auth = JSON.parse(await readFile(join(connectedServiceAuth!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
  });

  it('continues from the canonical coordinator result after active-profile spawn preflight refresh requires reconnect', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-switch-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-switch-test-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: 11,
      oauth: {
        accessToken: 'primary-stale-access',
        refreshToken: 'primary-invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });
    const ciphertextByProfileId = new Map([
      ['primary', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: primaryRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['backup', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: backupRecord,
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    let backupRevisionSemantics:
      'revisioned' | 'legacy_unfenced' = 'revisioned';
    const group = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: { v: 1 as const, strategy: 'least_limited' as const, autoSwitch: true },
      activeProfileId: 'primary',
      generation: 5,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => group),
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        if (params.serviceId !== 'openai-codex') return null;
        const ciphertext = ciphertextByProfileId.get(params.profileId);
        if (!ciphertext) return null;
        const record = params.profileId === 'primary' ? primaryRecord : backupRecord;
        return {
          ...(params.profileId === 'backup'
            && backupRevisionSemantics === 'legacy_unfenced'
            ? {
                revisionSemantics: 'legacy_unfenced' as const,
                credentialRevision: null,
              }
            : {
                revisionSemantics: 'revisioned' as const,
                credentialRevision:
                  'csr_0123456789ABCDEFGHJKMNPQRS',
              }),
          sealed: { format: 'account_scoped_v1', ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: null,
            providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
            expiresAt: record.expiresAt,
          },
        };
      }),
    } as unknown as ApiClient;
    class BoundSwitchCoordinator {
      readonly marker = 'bound';
      readonly switchBeforeTurn = vi.fn(async () => ({
        status: 'not_switched',
        activeProfileId: 'primary',
        generation: 5,
      }));
      readonly switchAfterCalls: Array<Readonly<{
        sessionId?: string;
        serviceId: string;
        groupId: string;
        reason: 'refresh_failed';
        observedProfileId?: string | null;
      }>> = [];

      async switchAfterClassifiedFailure(params: Readonly<{
        sessionId?: string;
        serviceId: string;
        groupId: string;
        reason: 'refresh_failed';
        observedProfileId?: string | null;
      }>) {
        if (this.marker !== 'bound') {
          throw new Error('switch coordinator receiver was not preserved');
        }
        this.switchAfterCalls.push(params);
        return {
          status: 'switched',
          activeProfileId: 'backup',
          generation: 6,
        };
      }
    }
    const authGroupSwitchCoordinator = new BoundSwitchCoordinator();
    const refreshService: SpawnPreflightRefreshService = {
      refreshConnectedServiceCredentialForSpawnPreflight: vi.fn(async (
        params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
      ): Promise<ConnectedServiceCredentialRefreshResult> => ({
        status: 'refresh_failed',
        credential: null,
        diagnostic: {
          serviceId: params.serviceId,
          profileId: params.profileId,
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'invalid_grant',
          providerStatus: 400,
          providerErrorCode: 'invalid_grant',
          expiresAt: 11,
          expiryAgeMs: 0,
          refreshWindowMs: 60_000,
        },
      })),
    };
    const params: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0] & {
      credentialRefreshService: SpawnPreflightRefreshService;
      authGroupSwitchCoordinator: SpawnAuthGroupSwitchCoordinator;
    } = {
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: authGroupSwitchCoordinator as SpawnAuthGroupSwitchCoordinator,
      credentialRefreshService: refreshService,
    };

    await expect(resolveConnectedServiceAuthForSpawn(params)).resolves.not.toBeNull();

    expect(refreshService.refreshConnectedServiceCredentialForSpawnPreflight).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
    });
    expect(authGroupSwitchCoordinator.switchAfterCalls).toEqual([{
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      reason: 'refresh_failed',
      observedProfileId: 'primary',
    }]);
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });

    backupRevisionSemantics = 'legacy_unfenced';
    await expect(resolveConnectedServiceAuthForSpawn({
      ...params,
      materializationKey: 'session-legacy-backup',
    })).rejects.toMatchObject({
      code: 'connected_service_legacy_unfenced_authority_unsupported',
      operation: 'materialization',
    });
  });

  it('does not reapply an authoritative active profile after spawn preflight refresh requires reconnect', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-switch-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-stale-switch-test-'));
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(6) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: 11,
      oauth: {
        accessToken: 'primary-stale-access',
        refreshToken: 'primary-invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const backupRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-backup',
        providerEmail: null,
      },
    });
    const ciphertextByProfileId = new Map([
      ['primary', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: primaryRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['backup', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: backupRecord,
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    const buildGroup = (activeProfileId: 'primary' | 'backup', generation: number) => ({
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'codex-main',
      displayName: 'Codex main',
      policy: { v: 1 as const, strategy: 'least_limited' as const, autoSwitch: true },
      activeProfileId,
      generation,
      state: {},
      createdAt: 1,
      updatedAt: generation,
      members: [
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
        {
          v: 1 as const,
          serviceId: 'openai-codex' as const,
          groupId: 'codex-main',
          profileId: 'backup',
          priority: 2,
          enabled: true,
          state: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn()
        .mockResolvedValueOnce(buildGroup('primary', 5))
        .mockResolvedValueOnce(buildGroup('backup', 6)),
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        if (params.serviceId !== 'openai-codex') return null;
        const ciphertext = ciphertextByProfileId.get(params.profileId);
        if (!ciphertext) return null;
        const record = params.profileId === 'primary' ? primaryRecord : backupRecord;
        return {
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: null,
            providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
            expiresAt: record.expiresAt,
          },
        };
      }),
    } as unknown as ApiClient;
    const switchAfterClassifiedFailure = vi.fn(async () => ({
      status: 'no_eligible_member',
      activeProfileId: null,
      generation: 5,
    }));
    const refreshService: SpawnPreflightRefreshService = {
      refreshConnectedServiceCredentialForSpawnPreflight: vi.fn(async (
        params: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>,
      ): Promise<ConnectedServiceCredentialRefreshResult> => ({
        status: 'refresh_failed',
        credential: null,
        diagnostic: {
          serviceId: params.serviceId,
          profileId: params.profileId,
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'invalid_grant',
          providerStatus: 400,
          providerErrorCode: 'invalid_grant',
          expiresAt: 11,
          expiryAgeMs: 0,
          refreshWindowMs: 60_000,
        },
      })),
    };

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
          },
        },
      },
      materializationKey: 'session-stale-switch',
      activeServerDir,
      baseDir,
      credentials,
      api,
      sessionId: 'session-stale-switch',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({
          status: 'not_switched',
          activeProfileId: 'primary',
          generation: 5,
        })),
        switchAfterClassifiedFailure,
      },
      credentialRefreshService: refreshService,
      quotaFreshnessMs: 60_000,
      nowMs: () => 1_000,
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'openai-codex',
      profileId: 'primary',
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceAuthGroup).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
  });

  it('consults the canonical coordinator when Claude materialization reports an unusable credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-claude-materialization-switch-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-claude-materialization-switch-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const primaryRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: 11,
      oauth: {
        accessToken: 'primary-stale-access',
        refreshToken: 'primary-invalid-refresh',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct-primary',
        providerEmail: null,
      },
    });
    const narrowRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct-narrow',
        providerEmail: null,
      },
    });
    const healthyRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'healthy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct-healthy',
        providerEmail: null,
      },
    });
    const ciphertextByProfileId = new Map([
      ['primary', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: primaryRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['narrow', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: narrowRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['healthy', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: healthyRecord,
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'claude-subscription') return null;
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (!ciphertext) return null;
      const record = params.profileId === 'primary'
        ? primaryRecord
        : params.profileId === 'narrow'
          ? narrowRecord
          : healthyRecord;
      return {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
          expiresAt: record.expiresAt,
        },
      };
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'claude-main',
        displayName: 'Claude main',
        policy: { v: 1 as const, strategy: 'priority' as const, autoSwitch: true },
        activeProfileId: 'narrow',
        generation: 5,
        state: {},
        createdAt: 1,
        updatedAt: 2,
        members: [
          { v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'claude-main', profileId: 'primary', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 2 },
          { v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'claude-main', profileId: 'narrow', priority: 2, enabled: true, state: {}, createdAt: 1, updatedAt: 2 },
          { v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'claude-main', profileId: 'healthy', priority: 3, enabled: true, state: {}, createdAt: 1, updatedAt: 2 },
        ],
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [
          { profileId: 'primary', status: 'connected' as const },
          { profileId: 'narrow', status: 'connected' as const },
          { profileId: 'healthy', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialSealed,
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    const switchAfterClassifiedFailure = vi.fn()
      .mockResolvedValueOnce({
        status: 'switched' as const,
        activeProfileId: 'narrow',
        generation: 6,
      })
      .mockResolvedValueOnce({
        status: 'switched' as const,
        activeProfileId: 'healthy',
        generation: 7,
      });
    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude-main',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      processEnv,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({
          status: 'not_switched',
          activeProfileId: 'narrow',
          generation: 5,
        })),
        switchAfterClassifiedFailure,
      },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceMaterializationBlockedError',
    });

    expect(switchAfterClassifiedFailure).toHaveBeenCalledTimes(1);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'narrow',
      health: expect.objectContaining({
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
  });

  it('continues canonical group materialization fallback through multiple blocked Claude profiles', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-claude-multi-materialization-switch-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-claude-multi-materialization-switch-test-'));
    const processEnv = await createIsolatedClaudeSourceEnv();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(6) },
    };
    if (credentials.encryption.type !== 'legacy') {
      throw new Error('test fixture expected legacy encryption');
    }

    const narrowOneRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'narrow-one',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-one-access',
        refreshToken: 'narrow-one-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct-narrow-one',
        providerEmail: null,
      },
    });
    const narrowTwoRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'narrow-two',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'narrow-two-access',
        refreshToken: 'narrow-two-refresh',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct-narrow-two',
        providerEmail: null,
      },
    });
    const healthyRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'healthy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'healthy-access',
        refreshToken: 'healthy-refresh',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct-healthy',
        providerEmail: null,
      },
    });
    const ciphertextByProfileId = new Map([
      ['narrow-one', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: narrowOneRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['narrow-two', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: narrowTwoRecord,
        randomBytes: (length) => randomBytes(length),
      })],
      ['healthy', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: healthyRecord,
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'claude-subscription') return null;
      const ciphertext = ciphertextByProfileId.get(params.profileId);
      if (!ciphertext) return null;
      const record = params.profileId === 'narrow-one'
        ? narrowOneRecord
        : params.profileId === 'narrow-two'
          ? narrowTwoRecord
          : healthyRecord;
      return {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
          expiresAt: record.expiresAt,
        },
      };
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1 as const,
        serviceId: 'claude-subscription' as const,
        groupId: 'claude-main',
        displayName: 'Claude main',
        policy: { v: 1 as const, strategy: 'priority' as const, autoSwitch: true },
        activeProfileId: 'narrow-one',
        generation: 5,
        state: {},
        createdAt: 1,
        updatedAt: 2,
        members: [
          { v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'claude-main', profileId: 'narrow-one', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 2 },
          { v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'claude-main', profileId: 'narrow-two', priority: 2, enabled: true, state: {}, createdAt: 1, updatedAt: 2 },
          { v: 1 as const, serviceId: 'claude-subscription' as const, groupId: 'claude-main', profileId: 'healthy', priority: 3, enabled: true, state: {}, createdAt: 1, updatedAt: 2 },
        ],
      })),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'claude-subscription' as const,
        profiles: [
          { profileId: 'narrow-one', status: 'connected' as const },
          { profileId: 'narrow-two', status: 'connected' as const },
          { profileId: 'healthy', status: 'connected' as const },
        ],
      })),
      getConnectedServiceCredentialSealed,
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    const switchAfterClassifiedFailure = vi.fn()
      .mockResolvedValueOnce({
        status: 'switched' as const,
        activeProfileId: 'narrow-two',
        generation: 6,
      })
      .mockResolvedValueOnce({
        status: 'switched' as const,
        activeProfileId: 'healthy',
        generation: 7,
      });

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude-main',
          },
        },
      },
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      credentials,
      api,
      processEnv,
      sessionId: 'session-1',
      authGroupSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({
          status: 'not_switched',
          activeProfileId: 'narrow-one',
          generation: 5,
        })),
        switchAfterClassifiedFailure,
      },
    })).resolves.not.toBeNull();

    expect(switchAfterClassifiedFailure).toHaveBeenCalledTimes(2);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(2);
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'claude-subscription',
      profileId: 'narrow-one',
      health: expect.objectContaining({
        status: 'needs_reauth',
        reconnectRequired: true,
      }),
    }));
  });
});

describe('persistMaterializationFailureCredentialHealthForSpawn', () => {
  it('does not latch needs_reauth for a non-auth blocking materialization diagnostic', async () => {
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = { updateConnectedServiceCredentialHealth } as unknown as ApiClient;
    const diagnostic: ConnectedServicesMaterializationDiagnostic = {
      // A blocking, NON-auth failure (e.g. shared-state link unavailable): no credentialRefreshFailure.
      code: 'claude_shared_state_link_unavailable',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'shared_state_link_failed',
    };

    await persistMaterializationFailureCredentialHealthForSpawn({
      api,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      diagnostic,
      nowMs: 1_000,
    });

    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledTimes(1);
    const written = (updateConnectedServiceCredentialHealth.mock.calls[0] as unknown as [
      { serviceId: string; profileId: string; health: { status: string; reconnectRequired: boolean; lastRefreshFailureKind?: string; providerHttpStatus?: number } },
    ])[0];
    expect(written.serviceId).toBe('claude-subscription');
    expect(written.profileId).toBe('primary');
    expect(written.health.status).not.toBe('needs_reauth');
    expect(written.health.reconnectRequired).toBe(false);
    expect(written.health.providerHttpStatus).toBeUndefined();
  });

  it('latches needs_reauth only for a genuine auth (provider_403) materialization diagnostic', async () => {
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = { updateConnectedServiceCredentialHealth } as unknown as ApiClient;
    const diagnostic: ConnectedServicesMaterializationDiagnostic = {
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
    };

    await persistMaterializationFailureCredentialHealthForSpawn({
      api,
      serviceId: 'claude-subscription',
      profileId: 'primary',
      diagnostic,
      nowMs: 1_000,
    });

    const written = (updateConnectedServiceCredentialHealth.mock.calls[0] as unknown as [
      { health: { status: string; reconnectRequired: boolean; lastRefreshFailureKind?: string; providerHttpStatus?: number } },
    ])[0];
    expect(written.health.status).toBe('needs_reauth');
    expect(written.health.reconnectRequired).toBe(true);
    expect(written.health.lastRefreshFailureKind).toBe('provider_403');
    expect(written.health.providerHttpStatus).toBe(403);
  });
});
