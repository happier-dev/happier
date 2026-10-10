import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ConnectedServiceBindingsV2, ProviderBoundModelRef, SessionMcpSelectionV1 } from '@happier-dev/protocol';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

type RuntimeSnapshotValue<T> = Readonly<{ value: T; updatedAt: number }>;

type RuntimeSnapshotModule = Readonly<{
  resolveSessionRuntimeSnapshot: (params: Readonly<{
    incomingOptions: SpawnSessionOptions;
    persistedMetadata?: Record<string, unknown> | null;
    trackedSpawnOptions?: SpawnSessionOptions | null;
    persistedVendorResumeId?: string | null;
    trackedVendorResumeId?: string | null;
    resolutionMode?: 'ordinary' | 'retained_live_process';
  }>) => Readonly<{
    snapshot: Readonly<{
      sessionId: string | null;
      connectedServices: ConnectedServiceBindingsV2 | null;
      connectedServicesUpdatedAt: number | null;
      mcpSelection: SessionMcpSelectionV1 | null;
      permissionMode: RuntimeSnapshotValue<PermissionMode> | null;
      agentModeId: RuntimeSnapshotValue<string> | null;
      modelSelection: RuntimeSnapshotValue<ProviderBoundModelRef | null> | null;
      vendorResumeId: Readonly<{ value: string; updatedAt: number | null }> | null;
    }>;
    spawnOptions: SpawnSessionOptions;
  }>;
}>;

async function loadRuntimeSnapshotModule(): Promise<RuntimeSnapshotModule | null> {
  const modulePath = './resolveSessionRuntimeSnapshot';
  return await import(modulePath).catch(() => null) as RuntimeSnapshotModule | null;
}

const persistedConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'happier.agent.claude/claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'persisted-profile',
    },
  },
} as const;

// Retained V1 records stay readable, but the owner normalizes every persisted
// envelope through the canonical V2 ingress, so they read back upgraded.
const persistedConnectedServicesAsV2 = {
  v: 2,
  bindingsByServiceId: persistedConnectedServices.bindingsByServiceId,
} as const;

const persistedMaterializationIdentity = {
  v: 1,
  id: 'csm_persisted',
  createdAt: 1,
} as const;

const persistedProviderBinding = {
  v: 1,
  connectionId: ProviderConnectionIdSchema.parse('pc_work'),
  contributionKey: 'plugin.gateway/gateway',
  connectionRevision: 2,
  protocol: 'openai-responses',
  materialization: 'engineConfig',
  adapterBindingKey: 'gateway',
  compatibilityFingerprint: 'compatibility-v1',
  bindingSecurityFingerprint: 'security-v1',
  displaySnapshot: {
    providerName: 'Gateway',
    connectionName: 'Work',
    connectionRole: 'named',
    connectionDisplayNameMode: 'custom',
  },
} as const;

describe('resolveSessionRuntimeSnapshot', () => {
  it('retains requester attribution only for the same Session and never retains request admission callbacks', async () => {
    const { resolveSessionRuntimeSnapshot } = await import('./resolveSessionRuntimeSnapshot');
    const attribution = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
    const incomingOptions: SpawnSessionOptions = { directory: '/repo', existingSessionId: 'session',
      verifyRequesterMachineAdmissionCurrent: async () => true };
    const trackedSpawnOptions: SpawnSessionOptions = { directory: '/repo', existingSessionId: 'session',
      requesterWorkAttributionV1: attribution };
    const recovered = resolveSessionRuntimeSnapshot({ incomingOptions, trackedSpawnOptions,
      persistedMetadata: { requesterWorkAttributionV1: { ...attribution, accountId: 'forged' } } }).spawnOptions;
    expect(recovered.requesterWorkAttributionV1).toEqual(attribution);
    expect(recovered.verifyRequesterMachineAdmissionCurrent).toBeUndefined();
    expect(resolveSessionRuntimeSnapshot({ incomingOptions,
      trackedSpawnOptions: { ...trackedSpawnOptions, existingSessionId: 'other-session' },
      persistedMetadata: { requesterWorkAttributionV1: attribution },
    }).spawnOptions.requesterWorkAttributionV1).toBeUndefined();
  });
  it('preserves a timestamped tracked model clear without placing a null ref in spawn options', async () => {
    const { resolveSessionRuntimeSnapshot } = await import('./resolveSessionRuntimeSnapshot');
    const ref = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'incoming-model' } as const;
    for (const updatedAt of [100, 200, 300]) {
      const result = resolveSessionRuntimeSnapshot({
        incomingOptions: { directory: '/repo', modelSelection: { v: 1, ref, updatedAt } },
        trackedModelSelection: { value: null, updatedAt: 200 },
      });
      expect(result.snapshot.modelSelection).toEqual({ value: updatedAt < 200 ? null : ref,
        updatedAt: updatedAt < 200 ? 200 : updatedAt });
      expect(result.spawnOptions.modelSelection).toEqual(updatedAt < 200 ? undefined : { v: 1, ref, updatedAt });
    }
  });
  it('applies authored same-Agent launch selection without replacing native Session identity', async () => {
    const { resolveSessionRuntimeSnapshot } = await import('./resolveSessionRuntimeSnapshot');
    const persisted = { v: 1 as const, agentId: 'codex', agent: {
      backendMode: 'appServer', providerSessionId: 'native-thread', appServerEndpoint: '/native/socket',
    } };
    const incoming = { v: 1 as const, agentId: 'codex', agent: { backendMode: 'acp' } };
    const result = resolveSessionRuntimeSnapshot({ incomingOptions: { directory: '/repo', runtimeDescriptorV1: incoming },
      persistedMetadata: { runtimeDescriptorV1: persisted },
    });
    expect(result.spawnOptions.runtimeDescriptorV1).toEqual({ ...persisted,
      agent: { ...persisted.agent, backendMode: 'acp' } });
    // Retained live-process adoption is evidence of an already running driver,
    // not permission to replace its active descriptor with next-launch intent.
    expect(resolveSessionRuntimeSnapshot({ incomingOptions: { directory: '/repo', runtimeDescriptorV1: incoming },
      persistedMetadata: { runtimeDescriptorV1: persisted }, resolutionMode: 'retained_live_process',
    }).spawnOptions.runtimeDescriptorV1).toEqual(persisted);
  });
  it('rehydrates managed directory identity without retaining one-shot creation or consent', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;
    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/managed/chat', freshSessionCreation: true, approvedNewDirectoryCreation: true,
        managedDirectorySeed: { sourceSessionId: 'source', sourcePath: '/managed/source' },
      },
      persistedMetadata: { sessionDirectoryV1: { v: 1, kind: 'managed' } },
    });
    expect(result.spawnOptions.directoryKind).toBe('managed');
    expect(result.spawnOptions.approvedNewDirectoryCreation).toBe(false);
    expect(result.spawnOptions.freshSessionCreation).toBeUndefined();
    expect(result.spawnOptions.managedDirectorySeed).toBeUndefined();
  });
  it('retains trusted managed creation routing before the initial row publishes its marker', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;
    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: { directory: '/managed/chat', directoryKind: 'managed', freshSessionCreation: true },
      persistedMetadata: { path: '/managed/chat' },
    });
    expect(result.spawnOptions.directoryKind).toBe('managed');
    expect(result.spawnOptions.freshSessionCreation).toBeUndefined();
  });
  it('restores persisted per-session MCP selection into resume and respawn options', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;
    const persistedSelection = {
      v: 1 as const,
      managedServersEnabled: true,
      forceIncludeServerIds: ['managed-1'],
      forceExcludeServerIds: ['managed-2'],
    };

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: { mcpSelectionV1: persistedSelection },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: [],
          forceExcludeServerIds: [],
        },
      },
    });

    expect(result.snapshot.mcpSelection).toEqual(persistedSelection);
    expect(result.spawnOptions.mcpSelection).toEqual(persistedSelection);
  });

  it('restores persisted runtime controls over stale incoming defaults', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        resume: 'incoming-vendor-resume',
      },
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServicesUpdatedAt: 500,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 510,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 520 },
        modelOverrideV1: { v: 1, modelId: 'claude-opus-4-7', updatedAt: 530 },
        connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_tracked',
          createdAt: 2,
        },
      } as SpawnSessionOptions & Record<string, unknown>,
      persistedVendorResumeId: 'vendor-persisted',
    });

    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServicesAsV2,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 510,
      agentModeId: 'plan',
      agentModeUpdatedAt: 520,
      modelSelection: {
        v: 1,
        updatedAt: 530,
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-opus-4-7' },
      },
      resume: 'incoming-vendor-resume',
    });
    expect((result.spawnOptions as unknown as Record<string, unknown>).connectedServiceMaterializationIdentityV1)
      .toEqual(persistedMaterializationIdentity);
    expect((result.spawnOptions as unknown as Record<string, unknown>).connectedServicesUpdatedAt).toBe(500);
    expect((result.snapshot as Record<string, unknown>).connectedServiceMaterializationIdentityV1)
      .toEqual(persistedMaterializationIdentity);
    expect(result.snapshot.connectedServicesUpdatedAt).toBe(500);
  });

  it('strips one-shot delivery fields from the durable spawn-options snapshot', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        initialTranscriptAfterSeq: 33294,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 510,
      },
      persistedMetadata: null,
      trackedSpawnOptions: {
        directory: '/tmp/repo',
      },
    });

    // Durable respawn identity must keep runtime controls but never replay one-shot
    // delivery cursors/prompts on later crash respawns.
    expect(result.spawnOptions).toMatchObject({
      directory: '/tmp/repo',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 510,
    });
    expect('initialTranscriptAfterSeq' in result.spawnOptions).toBe(false);
  });

  it('does not let undocumented bare metadata replace a canonical provider-bound selection', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        providerBindingV1: persistedProviderBinding,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 100,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
          },
        },
        modelId: 'stale-native-model',
        modelUpdatedAt: 999,
      },
    });

    expect(result.spawnOptions.modelSelection).toEqual({
      v: 1,
      updatedAt: 100,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    });
  });

  it('keeps the retained live Provider model envelope while preserving a newer next-launch intent', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const retainedSelection = {
      v: 1 as const,
      updatedAt: 90,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'retained-model',
      },
    };
    const retainedBinding = {
      ...persistedProviderBinding,
      model: { id: 'retained-model', name: 'Retained model' },
    };
    const persistedIntent = {
      v: 1 as const,
      updatedAt: 100,
      selection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: 'pc_work',
        modelId: 'next-model',
      },
    };

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      resolutionMode: 'retained_live_process',
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: retainedSelection,
        providerBindingMetadataV1: retainedBinding,
      },
      persistedMetadata: {
        providerBindingV1: retainedBinding,
        modelSelectionIntentV1: persistedIntent,
      },
    });

    expect(result.spawnOptions.modelSelection).toEqual(retainedSelection);
    expect(result.spawnOptions.providerBindingMetadataV1).toEqual(retainedBinding);
    expect(result.snapshot.modelSelection).toEqual({
      source: 'incoming',
      value: retainedSelection.ref,
      updatedAt: retainedSelection.updatedAt,
    });
    expect(result.spawnOptions).not.toHaveProperty('modelSelectionIntentV1');
    expect((result as unknown as { persistedMetadata?: unknown }).persistedMetadata).toBeUndefined();
    expect(persistedIntent.selection.modelId).toBe('next-model');
  });

  it.each([
    ['native', { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'native-next' }],
    ['another Provider', { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_other', modelId: 'other-next' }],
  ] as const)(
    'keeps the retained live Provider envelope when the next launch selects %s',
    async (_label, nextSelection) => {
      const runtimeSnapshot = await loadRuntimeSnapshotModule();
      expect(runtimeSnapshot).not.toBeNull();
      if (!runtimeSnapshot) return;
      const retainedBinding = {
        ...persistedProviderBinding,
        model: { id: 'retained-model', name: 'Retained model' },
      };
      const retainedSelection = {
        v: 1 as const,
        updatedAt: 90,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
          modelId: 'retained-model',
        },
      };

      const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
        resolutionMode: 'retained_live_process',
        incomingOptions: {
          directory: '/tmp/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          modelSelection: retainedSelection,
          providerBindingMetadataV1: retainedBinding,
        },
        persistedMetadata: {
          providerBindingV1: retainedBinding,
          modelSelectionIntentV1: { v: 1, updatedAt: 100, selection: nextSelection },
        },
      });

      expect(result.spawnOptions.modelSelection).toEqual(retainedSelection);
      expect(result.spawnOptions.providerBindingMetadataV1).toEqual(retainedBinding);
    },
  );

  it('keeps a retained native process native when the incoming request carries a next-launch Provider selection', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      resolutionMode: 'retained_live_process',
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      incomingOptions: {
        directory: '/tmp/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        modelSelection: {
          v: 1,
          updatedAt: 100,
          ref: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
            modelId: 'next-model',
          },
        },
        providerBindingMetadataV1: {
          ...persistedProviderBinding,
          model: { id: 'next-model', name: 'Next model' },
        },
      },
      persistedMetadata: null,
    });

    expect(result.spawnOptions.modelSelection).toBeUndefined();
    expect(result.spawnOptions.providerBindingMetadataV1).toBeUndefined();
  });

  it('refuses malformed persisted Provider continuity before runtime-state arbitration', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    expect(() => runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        providerBindingV1: { v: 1, connectionId: 'pc_work' },
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 100,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
          },
        },
      },
    })).toThrow(expect.objectContaining({
      providerError: expect.objectContaining({
        code: 'provider_binding_changed',
        connectionId: 'pc_work',
      }),
    }));
  });

  it('restores observed vendor resume evidence without persisting it as explicit resume', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: ' codex-thread-from-metadata ',
      },
    });

    // The Agent minted this id: its surrounding whitespace is part of the identity.
    expect(result.snapshot.vendorResumeId).toEqual({
      value: ' codex-thread-from-metadata ',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('keeps observed persisted and tracked vendor resume ids byte-exact', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const exactResume = '  provider\nses/AB+cd==  ';
    const incomingOptions = {
      directory: '/tmp/repo',
      existingSessionId: 'session-external-1',
      backendTarget: { kind: 'backend', backendId: 'acme.review-agent', sourceKind: 'built_in' },
    } satisfies SpawnSessionOptions;

    const persisted = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions,
      persistedVendorResumeId: exactResume,
      trackedVendorResumeId: 'stale-tracked',
    });
    const tracked = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions,
      trackedVendorResumeId: exactResume,
    });
    const blank = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions,
      persistedVendorResumeId: ' \n ',
      trackedVendorResumeId: '   ',
    });

    expect(persisted.snapshot.vendorResumeId).toEqual({ value: exactResume, updatedAt: null });
    expect(tracked.snapshot.vendorResumeId).toEqual({ value: exactResume, updatedAt: null });
    expect(blank.snapshot.vendorResumeId).toBeNull();
  });

  it('restores the persisted canonical Codex runtime descriptor for a default respawn', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const defaultCodexOptions = {
      directory: '/tmp/repo',
      existingSessionId: 'session-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    } satisfies SpawnSessionOptions;
    const runtimeDescriptorV1 = {
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'codex-thread-from-metadata',
      },
    } as const;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: defaultCodexOptions,
      trackedSpawnOptions: defaultCodexOptions,
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: 'codex-thread-from-metadata',
        runtimeDescriptorV1,
      },
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'codex-thread-from-metadata',
      updatedAt: null,
    });
    expect(result.spawnOptions.runtimeDescriptorV1).toEqual(runtimeDescriptorV1);
  });

  it('prefers the persisted provider identity over stale tracked observation', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: 'codex-thread-persisted',
      },
      persistedVendorResumeId: 'codex-thread-persisted',
      trackedVendorResumeId: 'codex-thread-stale',
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'codex-thread-persisted',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('resumes an observed Claude identity from the persisted id alone', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: 'observed-claude-session',
      },
      trackedVendorResumeId: 'observed-claude-session',
    });

    // `AM-24`: the transcript-path gate is gone, and Claude now follows the same
    // rule as every other Agent — the persisted current view is the authority.
    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'observed-claude-session',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('restores observed Claude identity without persisting explicit resume', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: 'observed-claude-session',
        claudeTranscriptPath: '/tmp/observed-claude-session.jsonl',
      },
      trackedVendorResumeId: 'observed-claude-session',
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'observed-claude-session',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('does not persist an observed Claude identity as explicit resume authority', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const observedVendorResumeId = 'observed-claude-session';
    const first = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: observedVendorResumeId,
        claudeTranscriptPath: `/tmp/${observedVendorResumeId}.jsonl`,
      },
      trackedVendorResumeId: observedVendorResumeId,
    });

    const second = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: first.spawnOptions,
      trackedSpawnOptions: first.spawnOptions,
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: observedVendorResumeId,
      },
      trackedVendorResumeId: observedVendorResumeId,
    });

    // Still resumable from the persisted view, but never promoted into
    // `spawnOptions.resume`: an observation is not an explicit user instruction.
    expect(second.snapshot.vendorResumeId).toEqual({
      value: observedVendorResumeId,
      updatedAt: null,
    });
    expect(second.spawnOptions.resume).toBeUndefined();
  });

  it('prefers the persisted Claude id over a diverging tracked observation', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: 'durably-proven-session',
        claudeTranscriptPath: '/tmp/durably-proven-session.jsonl',
      },
      trackedVendorResumeId: 'newer-observed-session',
    });

    // One rule for every Agent (`AM-24`): the persisted current view wins over a
    // tracked runtime observation. The Claude-only divergence gate that used to
    // refuse the resume outright existed to protect an id/proof pairing that no
    // longer exists, and Codex already behaved exactly this way.
    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'durably-proven-session',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('preserves explicit incoming and tracked spawn resume without derived proof', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const incoming = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        resume: 'explicit-incoming-resume',
      },
      persistedMetadata: { flavor: 'claude', claudeSessionId: 'observed-only' },
    });
    const tracked = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: { flavor: 'claude', claudeSessionId: 'observed-only' },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        resume: 'explicit-tracked-resume',
      },
    });

    expect(incoming.spawnOptions.resume).toBe('explicit-incoming-resume');
    expect(tracked.spawnOptions.resume).toBe('explicit-tracked-resume');
  });

  it('hands an explicit resume id to the durable snapshot byte-exact and treats whitespace alone as absent', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const exactResume = '  provider\nses/AB+cd==  ';
    const base = {
      directory: '/tmp/repo',
      existingSessionId: 'session-1',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    } satisfies SpawnSessionOptions;
    const persistedMetadata = { flavor: 'claude', claudeSessionId: 'observed-only' };

    const incoming = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: { ...base, resume: exactResume },
      persistedMetadata,
    });
    const tracked = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: base,
      persistedMetadata,
      trackedSpawnOptions: { directory: '/tmp/repo', resume: exactResume },
    });
    const blank = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: { ...base, resume: ' \n ' },
      persistedMetadata,
      trackedSpawnOptions: { directory: '/tmp/repo', resume: '   ' },
    });

    expect(incoming.spawnOptions.resume).toBe(exactResume);
    expect(incoming.snapshot.vendorResumeId).toEqual({ value: exactResume, updatedAt: null });
    expect(tracked.spawnOptions.resume).toBe(exactResume);
    expect(tracked.snapshot.vendorResumeId).toEqual({ value: exactResume, updatedAt: null });
    // Whitespace alone is no explicit authority: the observed identity still wins.
    expect(blank.spawnOptions.resume).toBeUndefined();
    expect(blank.snapshot.vendorResumeId).toEqual({ value: 'observed-only', updatedAt: null });
  });

  it('retains an external Agent’s observed resume identity without consulting built-in policy', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-external-1',
        backendTarget: { kind: 'backend', backendId: 'acme.review-agent', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'acme.review-agent',
          agent: {},
        },
      },
      trackedVendorResumeId: 'acme-session-1',
    });

    expect(result.snapshot.vendorResumeId).toEqual({ value: 'acme-session-1', updatedAt: null });
  });
});
