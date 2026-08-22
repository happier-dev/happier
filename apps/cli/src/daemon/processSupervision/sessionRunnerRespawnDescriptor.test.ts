import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildTrackedSessionRespawnEnvironmentVariables,
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  normalizeOwnedMarkerRespawnEnvironmentCiphertext,
  SessionRunnerRespawnDescriptorV1Schema,
  writeSessionRunnerRespawnDescriptorForPersistence,
} from './sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
  ProviderConnectionIdSchema,
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import {
  sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext,
} from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
  'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON';

/**
 * Provenance-pinned compatibility reader: the discriminating persisted slice of
 * ../remote-dev/apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.ts
 * and packages/protocol/src/backendTargets/backendTargetRef.ts at HEAD
 * 490a27a7435b414f9c70e82b1774f416d180f6bd, including the working-tree hashes
 * re-attested on 2026-07-14. Known optional fields still reject incompatible
 * values when present, so the legacy backend-target union must be modeled here.
 */
const REMOTE_DEV_BACKEND_TARGET_REF_V1_READER = z.union([
  z.object({
    kind: z.literal('builtInAgent'),
    agentId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('configuredAcpBackend'),
    backendId: z.string().min(1),
  }),
]);

const REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER = z.object({
  version: z.literal(1),
  directory: z.string(),
  backendTarget: REMOTE_DEV_BACKEND_TARGET_REF_V1_READER.optional(),
  vendorResumeId: z.string().optional(),
  modelId: z.string().optional(),
  modelUpdatedAt: z.number().int().optional(),
  terminal: z.object({
    mode: z.enum(['plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
    tmux: z.object({
      sessionName: z.string().optional(),
      isolated: z.boolean().optional(),
      tmpDir: z.union([z.string(), z.null()]).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const REMOTE_DEV_NATIVE_RESPAWN_DESCRIPTOR_V1 = {
  version: 1 as const,
  directory: '/tmp/repo',
  backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
  modelId: 'legacy-native',
  modelUpdatedAt: 7,
};

describe('sessionRunnerRespawnDescriptor', () => {
  it('imports flat Oh My Pi continuation and persists only structured Agent identity', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'ohMyPi',
        sourceKind: 'built_in',
      },
      modelSelection: {
        v: 1,
        updatedAt: 42,
        ref: {
          agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
          providerConnectionId: null,
          modelId: 'anthropic/claude-sonnet-4-6',
        },
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'ohMyPi',
        agent: {
          backendMode: 'acp',
          providerSessionId: 'omp-session-1',
        },
      },
    } satisfies SpawnSessionOptions);

    const persisted = writeSessionRunnerRespawnDescriptorForPersistence(descriptor!);
    expect(persisted).toMatchObject({
      version: 1,
      agentIdentity: {
        pluginId: 'happier.agent.ohmypi',
        localId: 'ohmypi',
      },
      modelSelection: {
        ref: {
          agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
        },
      },
      runtimeDescriptorV1: {
        agentIdentity: {
          pluginId: 'happier.agent.ohmypi',
          localId: 'ohmypi',
        },
      },
    });
    expect(persisted).not.toHaveProperty('backendTarget');
    expect(persisted).not.toHaveProperty('backendTargetV2');
    expect(JSON.stringify(persisted)).not.toContain('ohMyPi');

    const reread = SessionRunnerRespawnDescriptorV1Schema.parse(persisted);
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(reread)).toMatchObject({
      backendTarget: {
        kind: 'backend',
        backendId: 'ohMyPi',
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1: {
        agentId: 'ohMyPi',
      },
    });
  });

  it('imports the predecessor Oh My Pi continuation envelope and rewrites it structurally', () => {
    const imported = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: {
        kind: 'builtInAgent',
        agentId: 'ohMyPi',
      },
      modelId: 'anthropic/claude-sonnet-4-6',
      modelUpdatedAt: 42,
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'ohMyPi',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'omp-session-1',
        },
      },
    });

    expect(imported).toMatchObject({
      backendTarget: {
        kind: 'builtInAgent',
        agentId: 'ohMyPi',
      },
      runtimeDescriptorV1: {
        agentId: 'ohMyPi',
        agent: {
          backendMode: 'acp',
          vendorSessionId: 'omp-session-1',
        },
      },
      modelSelection: {
        ref: {
          agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
        },
      },
    });

    const persisted = writeSessionRunnerRespawnDescriptorForPersistence(imported);
    expect(persisted).toMatchObject({
      agentIdentity: {
        pluginId: 'happier.agent.ohmypi',
        localId: 'ohmypi',
      },
      runtimeDescriptorV1: {
        agentIdentity: {
          pluginId: 'happier.agent.ohmypi',
          localId: 'ohmypi',
        },
      },
    });
    expect(JSON.stringify(persisted)).not.toContain('ohMyPi');
  });

  it('imports a flat Oh My Pi continuation selection key once', () => {
    expect(SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: {
        kind: 'builtInAgent',
        agentId: 'ohMyPi',
      },
      modelSelection: {
        v: 1,
        updatedAt: 42,
        ref: {
          agentTargetKey: 'backend:ohMyPi',
          providerConnectionId: null,
          modelId: 'anthropic/claude-sonnet-4-6',
        },
      },
    })).toMatchObject({
      modelSelection: {
        ref: {
          agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
        },
      },
    });
  });

  it('writes Provider-bound continuity under a version the predecessor V1 reader rejects', () => {
    const providerBindingMetadataV1 = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      managedPurposeBindings: {
        v: 1 as const,
        bindings: [{
          purpose: {
            consumer: {
              pluginId: 'happier.provider.gateway',
              localId: 'gateway',
            },
            purpose: 'upstream',
          },
          target: {
            kind: 'group' as const,
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            groupId: 'team',
          },
        }],
      },
      displaySnapshot: {
        providerName: 'OpenRouter',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 9,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: providerBindingMetadataV1.connectionId,
          modelId: 'vendor/model',
        },
      },
      providerBindingMetadataV1,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({ version: 2, providerBindingMetadataV1 });
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(false);
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse(descriptor).success).toBe(true);
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      ...descriptor!,
      backendTargetV2: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }).success).toBe(false);
  });

  it('accepts the predecessor V1 native vector and keeps native V1 writes readable by that predecessor', () => {
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(
      REMOTE_DEV_NATIVE_RESPAWN_DESCRIPTOR_V1,
    ).success).toBe(true);
    expect(SessionRunnerRespawnDescriptorV1Schema.parse(
      REMOTE_DEV_NATIVE_RESPAWN_DESCRIPTOR_V1,
    ).modelSelection).toEqual({
      v: 1,
      updatedAt: 7,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'legacy-native',
      },
    });

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 8,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'native-current',
        },
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: 'native-current',
      modelUpdatedAt: 8,
    });
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(true);
  });

  it('writes configured native V1 targets in the predecessor shape and restores the canonical target', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
      },
      modelSelection: {
        v: 1,
        updatedAt: 9,
        ref: {
          agentTargetKey: 'backend:review-bot:configured:review-bot',
          providerConnectionId: null,
          modelId: 'native-configured',
        },
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      modelId: 'native-configured',
      modelUpdatedAt: 9,
    });
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(true);
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!)).toMatchObject({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    });
    expect(descriptor).not.toHaveProperty('backendTargetV2');
  });

  it('keeps an old-reader-compatible V1 target while preserving unequal configured V2 identity', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'kiro',
        sourceKind: 'configured',
      },
      modelSelection: {
        v: 1,
        updatedAt: 10,
        ref: {
          agentTargetKey: 'backend:customAcpRuntimeCarrier:configured:kiro',
          providerConnectionId: null,
          modelId: 'native-configured',
        },
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'kiro' },
      backendTargetV2: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'kiro',
        sourceKind: 'configured',
      },
      modelId: 'native-configured',
      modelUpdatedAt: 10,
    });
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(true);
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!)).toMatchObject({
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'kiro',
        sourceKind: 'configured',
      },
      modelSelection: {
        ref: {
          agentTargetKey: 'backend:customAcpRuntimeCarrier:configured:kiro',
        },
      },
    });
  });

  it('fails closed on missing, invalid, or contradictory native V2 target shadows', () => {
    const backendTarget = { kind: 'configuredAcpBackend' as const, backendId: 'kiro' };
    const backendTargetV2 = {
      kind: 'backend' as const,
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured' as const,
    };
    const modelSelection = {
      v: 1 as const,
      updatedAt: 10,
      ref: {
        agentTargetKey: 'backend:customAcpRuntimeCarrier:configured:kiro',
        providerConnectionId: null,
        modelId: 'native-configured',
      },
    };

    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget,
      backendTargetV2,
      modelSelection,
    }).success).toBe(true);
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget,
      modelSelection,
    }).success).toBe(false);
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTargetV2,
    }).success).toBe(false);
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: '   ',
      },
    }).success).toBe(false);
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget,
      backendTargetV2: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'review-bot',
      },
    }).success).toBe(false);
  });

  it('writes the predecessor runtime-learned vendor resume identity without inventing a spawn-time resume', () => {
    const buildWithPredecessorVendorResumeOption = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions as unknown as (
      spawnOptions: SpawnSessionOptions,
      options: Readonly<{ vendorResumeId?: string }>,
    ) => ReturnType<typeof buildSessionRunnerRespawnDescriptorV1FromSpawnOptions>;

    const descriptor = buildWithPredecessorVendorResumeOption({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    }, {
      vendorResumeId: '  remote-runtime-learned-id  ',
    });

    expect(descriptor).toMatchObject({
      version: 1,
      vendorResumeId: 'remote-runtime-learned-id',
    });
    expect(descriptor).not.toHaveProperty('resume');
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(true);
  });

  it('round-trips non-secret provider binding continuity metadata through planned respawns', () => {
    const providerBindingMetadataV1 = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      managedPurposeBindings: {
        v: 1 as const,
        bindings: [{
          purpose: {
            consumer: {
              pluginId: 'happier.provider.gateway',
              localId: 'gateway',
            },
            purpose: 'upstream',
          },
          target: {
            kind: 'group' as const,
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            groupId: 'team',
          },
        }],
      },
      displaySnapshot: {
        providerName: 'OpenRouter',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const spawnOptions = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
      modelSelection: {
        v: 1 as const,
        updatedAt: 9,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: providerBindingMetadataV1.connectionId,
          modelId: 'vendor/model',
        },
      },
      providerBindingMetadataV1,
    } as SpawnSessionOptions & { providerBindingMetadataV1: typeof providerBindingMetadataV1 };

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({ providerBindingMetadataV1 });
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!)).toMatchObject({ providerBindingMetadataV1 });
  });

  it('refuses orphaned Provider continuity metadata instead of respawning as native', () => {
    const orphanedBinding = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'OpenRouter', connectionName: 'Work', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const raw = {
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
      providerBindingMetadataV1: orphanedBinding,
    };

    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse(raw).success).toBe(false);
    expect(buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(raw)).toBeNull();
  });

  it('refuses stale Provider binding continuity when the respawn selection is explicitly native', () => {
    const providerBindingMetadataV1 = {
      v: 1 as const, connectionId: ProviderConnectionIdSchema.parse('pc_old'),
      contributionKey: 'plugin:old:old', connectionRevision: 1,
      protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
      adapterBindingKey: 'old', compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: { providerName: 'Old', connectionName: 'Old', connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const },
    };
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1, updatedAt: 10,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native-model' },
      },
      providerBindingMetadataV1,
    });

    expect(descriptor).toBeNull();
  });

  it('round-trips paired provider-bound model identity and reads deployed bare descriptors as native', () => {
    const providerBindingMetadataV1 = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'OpenRouter', connectionName: 'Work', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const spawnOptions = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 42,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
          modelId: 'provider-model',
        },
      },
      providerBindingMetadataV1,
    } satisfies SpawnSessionOptions;
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);
    expect(descriptor?.modelSelection).toEqual(spawnOptions.modelSelection);
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!).modelSelection).toEqual(spawnOptions.modelSelection);

    expect(SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: spawnOptions.backendTarget,
      modelId: 'legacy-native',
      modelUpdatedAt: 7,
    }).modelSelection).toEqual({
      v: 1,
      updatedAt: 7,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'legacy-native' },
    });
  });

  it('rejects a malformed canonical model selection instead of falling back to a legacy native model', () => {
    expect(SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 8,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: '',
        },
      },
      modelId: 'legacy-native',
      modelUpdatedAt: 7,
    }).success).toBe(false);
  });

  it('canonicalizes legacy agentRuntimeDescriptorV1 respawn carriers onto runtimeDescriptorV1', () => {
    const descriptor = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });
    expect(descriptor).not.toHaveProperty('agentRuntimeDescriptorV1');

    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor)).toMatchObject({
      directory: '/tmp/repo',
      approvedNewDirectoryCreation: true,
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'runtime-thread',
        },
      },
    });
  });

  it('round-trips mcpSelection through the respawn descriptor', () => {
    const spawnOptions = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'vendor-session-1',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    } satisfies SpawnSessionOptions;

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'vendor-session-1',
      approvedNewDirectoryCreation: true,
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    });
  });

  it('round-trips existingSessionId through the respawn descriptor', () => {
    const spawnOptions = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'sess-existing-runtime',
    } satisfies SpawnSessionOptions;

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess-existing-runtime',
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'sess-existing-runtime',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips connected-service materialization identity through the respawn descriptor', () => {
    const identity = {
      v: 1,
      id: 'csm_respawn',
      createdAt: 123,
    };
    const identityJson = JSON.stringify(identity);
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      connectedServiceMaterializationIdentityV1: identity,
      environmentVariables: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
      },
    } as SpawnSessionOptions & Record<string, unknown>);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      connectedServiceMaterializationIdentityV1: identity,
      environmentVariables: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      connectedServiceMaterializationIdentityV1: identity,
      environmentVariables: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
      },
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips windows terminal modes through the respawn descriptor', () => {
    const spawnOptions = {
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'happier-qa',
    } satisfies SpawnSessionOptions;

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'happier-qa',
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: 'C:\\repo',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsRemoteSessionConsole: 'visible',
      windowsTerminalWindowName: 'happier-qa',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips zellij topology through the respawn descriptor', () => {
    const spawnOptions = {
      directory: '/tmp/repo',
      terminal: {
        mode: 'zellij',
      },
    } satisfies SpawnSessionOptions;

    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      terminal: {
        mode: 'zellij',
      },
    });
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!)).toMatchObject({
      directory: '/tmp/repo',
      terminal: {
        mode: 'zellij',
      },
    });
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(false);
  });

  it('tolerates newer persisted respawn fields while preserving known ones', () => {
    const parsed = SessionRunnerRespawnDescriptorV1Schema.safeParse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      futureFlag: true,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    });
  });

  it('fails closed when a V1 backendTarget carrier is injected into canonical spawn options before respawn persistence', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as never,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
    });
    expect(descriptor?.backendTarget).toBeUndefined();
  });

  it('persists legacy experimentalCodexAcp spawn options as canonical codexBackendMode only', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      experimentalCodexAcp: true,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexAcp');

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
    expect(restored).not.toHaveProperty('experimentalCodexAcp');
  });

  it('hydrates legacy persisted experimentalCodexAcp descriptors onto canonical codexBackendMode', () => {
    const descriptor = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      experimentalCodexAcp: true,
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexAcp');

    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
    expect(restored).not.toHaveProperty('experimentalCodexAcp');
  });

  it('hydrates legacy experimentalCodexResume descriptors onto canonical codexBackendMode', () => {
    const descriptor = SessionRunnerRespawnDescriptorV1Schema.parse({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      experimentalCodexResume: true,
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
    });
    expect(descriptor).not.toHaveProperty('experimentalCodexResume');

    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips canonical codex backend mode through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'appServer',
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      codexBackendMode: 'appServer',
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'appServer',
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips the fresh-session spawn nonce through daemon restart continuity', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: '  nonce-survives-restart  ',
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      spawnNonce: 'nonce-survives-restart',
    });
    expect(REMOTE_DEV_RESPAWN_DESCRIPTOR_V1_READER.safeParse(descriptor).success).toBe(true);
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!)).toMatchObject({
      spawnNonce: 'nonce-survives-restart',
    });
  });

  it('round-trips agent mode overrides through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
      approvedNewDirectoryCreation: true,
    });
  });

  it('round-trips session config-option overrides without workspace context through the respawn descriptor', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          speed: { updatedAt: 10, value: 'fast' },
        },
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).toMatchObject({
      version: 1,
      directory: '/tmp/repo',
      sessionConfigOptionOverrides: {
        v: 1,
        overrides: {
          speed: { value: 'fast' },
        },
      },
    });

    const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!);
    expect(restored).toMatchObject({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionConfigOptionOverrides: {
        v: 1,
        overrides: {
          speed: { value: 'fast' },
        },
      },
      approvedNewDirectoryCreation: true,
    });
    expect(restored).not.toHaveProperty('workspaceId');
    expect(restored).not.toHaveProperty('workspaceLocationId');
    expect(restored).not.toHaveProperty('workspaceCheckoutId');
  });

  it('persists safe respawn environment variables and seals the rest for continuity', () => {
    const credentials = {
      type: 'dataKey' as const,
      machineKey: new Uint8Array(32).fill(7),
    };

    const descriptor = (buildSessionRunnerRespawnDescriptorV1FromSpawnOptions as unknown as (
      spawnOptions: SpawnSessionOptions,
      options?: { encryptionMaterial?: typeof credentials },
    ) => ReturnType<typeof buildSessionRunnerRespawnDescriptorV1FromSpawnOptions>)(
      {
        directory: '/tmp/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
          OPENAI_API_KEY: 'test-key',
        },
        connectedServices: {
          v: 1,
          bindings: {
            codex: { profileId: 'work' },
          },
        },
      } satisfies SpawnSessionOptions,
      {
        encryptionMaterial: credentials,
      },
    );

    expect(descriptor).toMatchObject({
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
      },
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
    });
    expect(descriptor).toMatchObject({
      sealedEnvironmentVariables: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
    });
    expect(descriptor?.environmentVariables).not.toHaveProperty('OPENAI_API_KEY');

    const restored = (buildSpawnSessionOptionsFromRespawnDescriptorV1 as unknown as (
      descriptor: NonNullable<ReturnType<typeof buildSessionRunnerRespawnDescriptorV1FromSpawnOptions>>,
      options?: { encryptionMaterial?: typeof credentials },
    ) => SpawnSessionOptions)(descriptor!, {
      encryptionMaterial: credentials,
    });
    expect(restored).toMatchObject({
      connectedServices: {
        bindings: {
          codex: { profileId: 'work' },
        },
      },
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'test-key',
      },
      approvedNewDirectoryCreation: true,
    });
    expect(restored.environmentVariables).toMatchObject({
      OPENAI_API_KEY: 'test-key',
    });
  });

  it('seals respawn-only secrets with device-local custody and restores them without account encryption material', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-respawn-device-secret-'));
    try {
      const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
        path: join(home, 'device-local-secret-key.json'),
      });
      const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
        {
          directory: '/tmp/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          environmentVariables: {
            CODEX_HOME: '/tmp/codex-home',
            OPENAI_API_KEY: 'token-only-secret',
          },
        },
        { deviceLocalSecretStorage },
      );

      expect(descriptor?.sealedEnvironmentVariables).toMatchObject({
        format: 'device_local_v1',
        ciphertext: expect.any(String),
      });
      expect(descriptor?.sealedEnvironmentVariables?.ciphertext).not.toContain(
        'token-only-secret',
      );
      expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!, {
        deviceLocalSecretStorage,
      }).environmentVariables).toEqual({
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'token-only-secret',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reseals the respawn alias once and preserves canonical ciphertext on later owned-marker recovery', () => {
    const material = {
      type: 'dataKey' as const,
      machineKey: new Uint8Array(32).fill(7),
    };
    const payload = {
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'test-key',
    };
    const aliasCiphertext =
      sealHistoricalSessionRespawnEnvironmentAliasFixtureCiphertext({
        material,
        payload,
        randomBytes: (length) =>
          new Uint8Array(length).fill(6),
      });

    const resealed =
      normalizeOwnedMarkerRespawnEnvironmentCiphertext({
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: aliasCiphertext,
        },
        encryptionMaterial: material,
        randomBytes: (length) =>
          new Uint8Array(length).fill(8),
      });
    expect(
      readAccountScopedCiphertextKindByte(
        resealed?.ciphertext ?? '',
      ),
    ).toBe(5);
    expect(resealed?.ciphertext).not.toBe(aliasCiphertext);

    expect(
      normalizeOwnedMarkerRespawnEnvironmentCiphertext({
        sealedEnvironmentVariables: resealed!,
        encryptionMaterial: material,
        randomBytes: (length) =>
          new Uint8Array(length).fill(9),
      }),
    ).toEqual(resealed);
  });

  it('builds tracked respawn environment variables from expanded env plus safe child runtime locators only', () => {
    const identityJson = JSON.stringify({ v: 1, id: 'csm_child_env', createdAt: 321 });
    expect(buildTrackedSessionRespawnEnvironmentVariables({
      expandedEnvironmentVariables: {
        OPENAI_API_KEY: 'sk-openai',
        ANTHROPIC_AUTH_TOKEN: 'sk-anthropic',
        CODEX_HOME: '/tmp/codex-home',
      },
      extraEnvForChild: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
        HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: '["OPENAI_API_KEY"]',
        HAPPIER_SESSION_REQUESTED_DIRECTORY: '/tmp/repo',
        HAPPIER_CODEX_BACKEND_MODE: 'acp',
      },
    })).toEqual({
      OPENAI_API_KEY: 'sk-openai',
      ANTHROPIC_AUTH_TOKEN: 'sk-anthropic',
      CODEX_HOME: '/tmp/codex-home',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: identityJson,
    });
  });

  it('never persists provider-owned values even when their keys are otherwise safe respawn locators', () => {
    expect(buildTrackedSessionRespawnEnvironmentVariables({
      expandedEnvironmentVariables: {
        PROFILE_ONLY: 'profile-value',
      },
      extraEnvForChild: {
        CODEX_HOME: '/tmp/provider-secret-home',
        CLAUDE_CONFIG_DIR: '/tmp/provider-secret-config',
        HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: '["CODEX_HOME","CLAUDE_CONFIG_DIR"]',
      },
      excludedEnvironmentVariableKeys: ['codex_home', 'CLAUDE_CONFIG_DIR'],
    })).toEqual({
      PROFILE_ONLY: 'profile-value',
    });
  });

  it('strips pending first-input custody from ordinary respawn metadata', () => {
    const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'launch-1',
      pendingFirstInput: {
        text: 'ephemeral prompt',
        localId: 'spawn-first-turn:launch-1',
      },
    } satisfies SpawnSessionOptions);

    expect(descriptor).not.toBeNull();
    expect(descriptor).not.toHaveProperty('pendingFirstInput');
    expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor!)).not.toHaveProperty('pendingFirstInput');
  });
});
