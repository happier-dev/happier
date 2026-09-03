import { describe, expect, it, vi } from 'vitest';

import { createSpawnRequestCoalescer, computeDaemonSpawnRequestKey } from './spawnRequestCoalescer';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

function computeExactExistingSessionKey(localId: string) {
  return computeDaemonSpawnRequestKey({
    directory: '/tmp',
    existingSessionId: 'sess_1',
    executionAuthorization: {
      provenance: 'user_request',
      requestId: localId,
    },
  } satisfies SpawnSessionOptions);
}

function computeRuntimeDescriptorKeys(
  agentRuntimeDescriptorV1: SpawnSessionOptions['agentRuntimeDescriptorV1'],
) {
  const base = {
    directory: '/tmp/repo',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' } as const,
    agentRuntimeDescriptorV1,
  } satisfies SpawnSessionOptions;

  return {
    newSession: computeDaemonSpawnRequestKey(base),
    existingSession: computeDaemonSpawnRequestKey({
      ...base,
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
      },
    } satisfies SpawnSessionOptions),
  };
}

describe('computeDaemonSpawnRequestKey', () => {
  it('distinguishes re-armed durable authorizations while preserving exact duplicate identity', () => {
    const baseExistingSessionOptions = {
      directory: '/tmp/repo',
      existingSessionId: 'sess_1',
    } satisfies SpawnSessionOptions;
    const first = computeDaemonSpawnRequestKey({
      ...baseExistingSessionOptions,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
        requestedAt: 100,
      },
    });
    const duplicate = computeDaemonSpawnRequestKey({
      ...baseExistingSessionOptions,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
        requestedAt: 100,
      },
    });
    const rearmed = computeDaemonSpawnRequestKey({
      ...baseExistingSessionOptions,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
        requestedAt: 101,
      },
    });

    expect(first).toEqual(duplicate);
    expect(rearmed.key).not.toBe(first.key);
    expect(rearmed.kind).toBe('existing');
    expect(first.kind).toBe('existing');
    if (first.kind !== 'existing' || rearmed.kind !== 'existing') throw new Error('expected existing-session keys');
    expect(rearmed.authorizationKey).not.toBe(first.authorizationKey);
    expect(rearmed.serializationKey).toBe(first.serializationKey);
  });
  it('is stable for equivalent inputs with different object key order', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      environmentVariables: { B: '2', A: '1' },
      connectedServices: { z: 1, a: 2 },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      directory: '/tmp/repo',
      environmentVariables: { A: '1', B: '2' },
      connectedServices: { a: 2, z: 1 },
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });

  it('incorporates spawnNonce when provided', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      spawnNonce: 'nonce-a',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      spawnNonce: 'nonce-b',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('uses spawnNonce as the admission key even when other spawn options differ', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo-a',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      spawnNonce: 'nonce-shared',
      modelId: 'model-a',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo-b',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      spawnNonce: 'nonce-shared',
      modelId: 'model-b',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });

  it('keys existing-session spawns by session id', () => {
    const k = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: '  sess_1 ',
    } satisfies SpawnSessionOptions);
    expect(k).toEqual({
      kind: 'existing',
      key: 'existing:sess_1',
      serializationKey: 'existing:sess_1',
    });
  });

  it('distinguishes exact requests while keeping one serialization lane per existing session', () => {
    const first = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
      },
    } satisfies SpawnSessionOptions);
    const firstReplay = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
      },
    } satisfies SpawnSessionOptions);
    const second = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-2',
      },
    } satisfies SpawnSessionOptions);

    expect(first).toEqual(firstReplay);
    expect(first.key).not.toBe(second.key);
    expect(first.kind).toBe('existing');
    expect(second.kind).toBe('existing');
    if (first.kind !== 'existing' || second.kind !== 'existing') throw new Error('Expected existing-session keys');
    expect(first.serializationKey).toBe('existing:sess_1');
    expect(second.serializationKey).toBe('existing:sess_1');
    expect(first.authorizationKey).not.toBe(second.authorizationKey);
  });

  it('does not include updatedAt timestamps in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 111,
      modelId: 'gpt-5',
      modelUpdatedAt: 111,
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 222,
      modelId: 'gpt-5',
      modelUpdatedAt: 222,
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });

  it('includes transcriptStorage=direct in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      transcriptStorage: 'direct',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('includes the Windows Terminal window name in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier-qa',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('includes codexBackendMode in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'mcp',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'appServer',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('treats legacy experimentalCodexAcp requests as canonical acp for the new-session key', () => {
    const canonical = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
    } satisfies SpawnSessionOptions);
    const legacy = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      experimentalCodexAcp: true,
    } satisfies SpawnSessionOptions);

    expect(canonical.kind).toBe('new');
    expect(legacy.kind).toBe('new');
    expect(canonical.key).toBe(legacy.key);
  });

  it('is stable for reordered generic runtime descriptor envelope keys', () => {
    const first = computeRuntimeDescriptorKeys({
      v: 1,
      providerId: 'custom-provider',
      provider: {
        backendMode: 'custom-runtime',
        providerExtra: {
          owner: 'custom-provider',
          schemaId: 'custom-provider.runtimeDescriptor.extra',
          v: 1,
          runtimeIdentity: {
            region: 'eu',
            worker: 'primary',
          },
        },
        vendorSessionId: 'session_1',
      },
      envelopeExtra: {
        generation: 2,
        source: 'catalog',
      },
    });
    const reordered = computeRuntimeDescriptorKeys({
      envelopeExtra: {
        source: 'catalog',
        generation: 2,
      },
      provider: {
        vendorSessionId: 'session_1',
        providerExtra: {
          runtimeIdentity: {
            worker: 'primary',
            region: 'eu',
          },
          v: 1,
          schemaId: 'custom-provider.runtimeDescriptor.extra',
          owner: 'custom-provider',
        },
        backendMode: 'custom-runtime',
      },
      providerId: 'custom-provider',
      v: 1,
    });

    expect(first.newSession.key).toBe(reordered.newSession.key);
    expect(first.existingSession.key).toBe(reordered.existingSession.key);
  });

  it('changes both key families when any known-provider envelope field category changes', () => {
    const baseDescriptor = {
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'mcp',
        futureRuntimeFlag: 'first',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'mcp',
            futureAffinityField: 'first',
          },
          futureProviderExtraField: 'first',
        },
      },
      futureEnvelopeField: 'first',
    } as const satisfies NonNullable<SpawnSessionOptions['agentRuntimeDescriptorV1']>;
    const base = computeRuntimeDescriptorKeys(baseDescriptor);
    const changedDescriptors = [
      {
        ...baseDescriptor,
        provider: {
          ...baseDescriptor.provider,
          backendMode: 'appServer',
        },
      },
      {
        ...baseDescriptor,
        provider: {
          ...baseDescriptor.provider,
          futureRuntimeFlag: 'second',
        },
      },
      {
        ...baseDescriptor,
        provider: {
          ...baseDescriptor.provider,
          providerExtra: {
            ...baseDescriptor.provider.providerExtra,
            futureProviderExtraField: 'second',
          },
        },
      },
      {
        ...baseDescriptor,
        provider: {
          ...baseDescriptor.provider,
          providerExtra: {
            ...baseDescriptor.provider.providerExtra,
            runtimeAffinity: {
              ...baseDescriptor.provider.providerExtra.runtimeAffinity,
              futureAffinityField: 'second',
            },
          },
        },
      },
      {
        ...baseDescriptor,
        futureEnvelopeField: 'second',
      },
    ] satisfies NonNullable<SpawnSessionOptions['agentRuntimeDescriptorV1']>[];

    for (const changedDescriptor of changedDescriptors) {
      const changed = computeRuntimeDescriptorKeys(changedDescriptor);
      expect(changed.newSession.key).not.toBe(base.newSession.key);
      expect(changed.existingSession.key).not.toBe(base.existingSession.key);
    }
  });

  it('includes a valid unknown-provider runtime descriptor in both key families', () => {
    const absent = computeRuntimeDescriptorKeys(undefined);
    const present = computeRuntimeDescriptorKeys({
      v: 1,
      providerId: 'custom-provider',
      provider: {
        executionTarget: 'custom-runtime',
      },
    });

    expect(present.newSession.key).not.toBe(absent.newSession.key);
    expect(present.existingSession.key).not.toBe(absent.existingSession.key);
  });

  it('normalizes invalid runtime descriptor envelopes consistently to null', () => {
    const absent = computeRuntimeDescriptorKeys(undefined);
    const invalidVersion = computeRuntimeDescriptorKeys({
      v: 2,
      providerId: 'custom-provider',
      provider: {},
    } as unknown as SpawnSessionOptions['agentRuntimeDescriptorV1']);
    const invalidProviderId = computeRuntimeDescriptorKeys({
      v: 1,
      providerId: '',
      provider: {},
    } as SpawnSessionOptions['agentRuntimeDescriptorV1']);

    expect(invalidVersion.newSession.key).toBe(absent.newSession.key);
    expect(invalidVersion.existingSession.key).toBe(absent.existingSession.key);
    expect(invalidProviderId.newSession.key).toBe(absent.newSession.key);
    expect(invalidProviderId.existingSession.key).toBe(absent.existingSession.key);
  });

  it('treats ~/ directories as equivalent to their expanded home path in the new-session key', () => {
    const previousHome = process.env.HOME;
    process.env.HOME = '/Users/tester';

    try {
      const tilde = computeDaemonSpawnRequestKey({
        directory: '~/Documents',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } satisfies SpawnSessionOptions);
      const absolute = computeDaemonSpawnRequestKey({
        directory: '/Users/tester/Documents',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } satisfies SpawnSessionOptions);

      expect(tilde.kind).toBe('new');
      expect(absolute.kind).toBe('new');
      expect(tilde.key).toBe(absolute.key);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('includes mcpSelection in the new-session key while ignoring list order noise', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-b', 'portable-a'],
        forceExcludeServerIds: ['workspace-a'],
      },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-a', 'portable-b'],
        forceExcludeServerIds: ['workspace-a'],
      },
    } satisfies SpawnSessionOptions);

    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });

  it('changes the new-session key when mcpSelection changes', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-a'],
        forceExcludeServerIds: [],
      },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['portable-a'],
        forceExcludeServerIds: [],
      },
    } satisfies SpawnSessionOptions);

    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('changes the new-session key when session config option overrides change', () => {
    const base = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' } as const,
    } satisfies SpawnSessionOptions;

    const a = computeDaemonSpawnRequestKey({
      ...base,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: {
          speed: { updatedAt: 123, value: 'standard' },
        },
      },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      ...base,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 999,
        overrides: {
          speed: { updatedAt: 999, value: 'fast' },
        },
      },
    } satisfies SpawnSessionOptions);

    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('ignores session config option freshness timestamps when effective values are unchanged', () => {
    const base = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' } as const,
    } satisfies SpawnSessionOptions;
    const first = computeDaemonSpawnRequestKey({
      ...base,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 100,
        overrides: { speed: { updatedAt: 100, value: 'fast' } },
      },
    } satisfies SpawnSessionOptions);
    const refreshed = computeDaemonSpawnRequestKey({
      ...base,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 200,
        overrides: { speed: { updatedAt: 200, value: 'fast' } },
      },
    } satisfies SpawnSessionOptions);

    expect(first.kind).toBe('new');
    expect(refreshed.kind).toBe('new');
    expect(first.key).toBe(refreshed.key);
  });

  it('includes agent mode but ignores removed workspace shaping fields in the new-session key', () => {
    const base = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
    } satisfies SpawnSessionOptions;
    const baseWithWorkspace = base as SpawnSessionOptions & {
      workspaceId?: string;
      workspaceLocationId?: string;
      workspaceCheckoutId?: string;
    };

    const baseKey = computeDaemonSpawnRequestKey(base);
    const agentModeKey = computeDaemonSpawnRequestKey({
      ...base,
      agentModeId: 'plan',
    } satisfies SpawnSessionOptions);
    const workspaceKey = computeDaemonSpawnRequestKey({
      ...baseWithWorkspace,
      workspaceId: 'ws_payments',
    } as SpawnSessionOptions);
    const workspaceLocationKey = computeDaemonSpawnRequestKey({
      ...baseWithWorkspace,
      workspaceLocationId: 'loc_local',
    } as SpawnSessionOptions);
    const workspaceCheckoutKey = computeDaemonSpawnRequestKey({
      ...baseWithWorkspace,
      workspaceCheckoutId: 'checkout_feature_auth',
    } as SpawnSessionOptions);

    expect(baseKey.kind).toBe('new');
    expect(agentModeKey.kind).toBe('new');
    expect(workspaceKey.kind).toBe('new');
    expect(workspaceLocationKey.kind).toBe('new');
    expect(workspaceCheckoutKey.kind).toBe('new');

    expect(agentModeKey.key).not.toBe(baseKey.key);
    expect(workspaceKey.key).toBe(baseKey.key);
    expect(workspaceLocationKey.key).toBe(baseKey.key);
    expect(workspaceCheckoutKey.key).toBe(baseKey.key);
  });
});

describe('createSpawnRequestCoalescer', () => {
  it('coalesces concurrent calls for the same key and caches recent new-session success', async () => {
    let now = 10_000;
    const nowMs = () => now;
    const coalescer = createSpawnRequestCoalescer({ nowMs, recentSuccessTtlMs: 2_000 });

    const work = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess_new' }));
    const key = { kind: 'new' as const, key: 'new:abc' };

    const [r1, r2] = await Promise.all([coalescer.run(key, work), coalescer.run(key, work)]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ type: 'success', sessionId: 'sess_new' });
    expect(r2).toEqual({ type: 'success', sessionId: 'sess_new' });

    now += 500;
    const r3 = await coalescer.run(key, work);
    expect(work).toHaveBeenCalledTimes(1);
    expect(r3).toEqual({ type: 'success', sessionId: 'sess_new' });

    now += 5_000;
    const r4 = await coalescer.run(key, work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(r4).toEqual({ type: 'success', sessionId: 'sess_new' });
  });

  it('serializes a same-row re-arm without joining the prior attempt or replaying its cached success', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 2_000 });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const starts: string[] = [];
    const firstKey = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: { provenance: 'user_request', requestId: 'same-row', requestedAt: 100 },
    });
    const secondKey = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: { provenance: 'user_request', requestId: 'same-row', requestedAt: 101 },
    });

    const first = coalescer.run(firstKey, async () => {
      starts.push('first');
      await firstBlocked;
      return { type: 'success', sessionId: 'sess_1' };
    });
    const second = coalescer.run(secondKey, async () => {
      starts.push('second');
      return { type: 'success', sessionId: 'sess_1' };
    });

    await vi.waitFor(() => expect(starts).toEqual(['first']));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { type: 'success', sessionId: 'sess_1' },
      { type: 'success', sessionId: 'sess_1' },
    ]);
    expect(starts).toEqual(['first', 'second']);
  });

  it('coalesces a concurrent replay of the same exact existing-session request', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    const key = computeExactExistingSessionKey('same');
    const work = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess_1' }));

    await expect(Promise.all([coalescer.run(key, work), coalescer.run(key, work)])).resolves.toEqual([
      { type: 'success', sessionId: 'sess_1' },
      { type: 'success', sessionId: 'sess_1' },
    ]);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('caches a sequential replay of the same exact authorized existing-session success', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 2_000 });
    const key = computeExactExistingSessionKey('same');
    const work = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess_1' }));

    await expect(coalescer.run(key, work)).resolves.toEqual({ type: 'success', sessionId: 'sess_1' });
    await expect(coalescer.run(key, work)).resolves.toEqual({ type: 'success', sessionId: 'sess_1' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('returns a typed conflict for concurrent differing semantics on the same exact authorization', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstKey = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
      },
      pendingFirstInput: { text: 'first', localId: 'local-1' },
    } satisfies SpawnSessionOptions);
    const conflictingKey = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'local-1',
      },
      pendingFirstInput: { text: 'different', localId: 'local-1' },
    } satisfies SpawnSessionOptions);
    const firstWork = vi.fn(async () => {
      await firstBlocked;
      return { type: 'success' as const, sessionId: 'sess_1' };
    });
    const conflictingWork = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess_1' }));

    const first = coalescer.run(firstKey, firstWork);
    await vi.waitFor(() => expect(firstWork).toHaveBeenCalledTimes(1));
    await expect(coalescer.run(conflictingKey, conflictingWork)).resolves.toMatchObject({
      type: 'error',
      errorCode: 'INVALID_REQUEST',
    });
    expect(conflictingWork).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toEqual({ type: 'success', sessionId: 'sess_1' });
  });

  it('rejects changed execution options instead of joining the same exact authorization', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executionAuthorization = {
      provenance: 'user_request' as const,
      requestId: 'local-1',
    };
    const firstKey = computeDaemonSpawnRequestKey({
      directory: '/repo-a',
      existingSessionId: 'sess_1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      executionAuthorization,
    } satisfies SpawnSessionOptions);
    const conflictingKey = computeDaemonSpawnRequestKey({
      directory: '/repo-b',
      existingSessionId: 'sess_1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      executionAuthorization,
    } satisfies SpawnSessionOptions);
    const firstWork = vi.fn(async () => {
      await firstBlocked;
      return { type: 'success' as const, sessionId: 'from-first' };
    });
    const conflictingWork = vi.fn(async () => ({ type: 'success' as const, sessionId: 'from-second' }));

    const first = coalescer.run(firstKey, firstWork);
    await vi.waitFor(() => expect(firstWork).toHaveBeenCalledTimes(1));
    const conflicting = coalescer.run(conflictingKey, conflictingWork);
    releaseFirst();

    await expect(conflicting).resolves.toMatchObject({
      type: 'error',
      errorCode: 'INVALID_REQUEST',
    });
    expect(conflictingWork).not.toHaveBeenCalled();
    await expect(first).resolves.toEqual({ type: 'success', sessionId: 'from-first' });
  });

  it('runs a distinct exact request after the preceding existing-session spawn fails', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    const starts: string[] = [];
    const first = coalescer.run(computeExactExistingSessionKey('first'), async () => {
      starts.push('first');
      throw new Error('spawn failed');
    });
    const second = coalescer.run(computeExactExistingSessionKey('second'), async () => {
      starts.push('second');
      return { type: 'success', sessionId: 'sess_1' };
    });

    await expect(first).rejects.toThrow('spawn failed');
    await expect(second).resolves.toEqual({ type: 'success', sessionId: 'sess_1' });
    expect(starts).toEqual(['first', 'second']);
  });
});
