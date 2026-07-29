import { describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { createSpawnRequestCoalescer, computeDaemonSpawnRequestKey } from './spawnRequestCoalescer';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ProviderConnectionId } from '@happier-dev/protocol';

function nativeModelSelection(agentId: string, modelId: string, updatedAt: number) {
  return {
    v: 1 as const,
    updatedAt,
    ref: {
      agentTargetKey: `backend:${agentId}`,
      providerConnectionId: null,
      modelId,
    },
  };
}

function computeAuthorizedExistingSessionKey(localId: string) {
  return computeDaemonSpawnRequestKey({
    machineId: 'machine-1',
    directory: '/tmp',
    existingSessionId: 'sess_1',
    executionAuthorization: {
      provenance: 'user_request',
      requestId: localId,
    },
  } satisfies SpawnSessionOptions);
}

function computeRuntimeDescriptorKeys(
  runtimeDescriptorV1: SpawnSessionOptions['runtimeDescriptorV1'],
) {
  const base = {
    directory: '/tmp/repo',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const,
    runtimeDescriptorV1,
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

const providerBindingSecurityChangeConfirmation = {
  v: 1 as const,
  sessionId: 'sess_1',
  connectionId: 'pc_gateway' as ProviderConnectionId,
  previousBindingSecurityFingerprint: 'binding-security:v1:a',
  nextBindingSecurityFingerprint: 'binding-security:v1:b',
};

describe('computeDaemonSpawnRequestKey', () => {
  it('is stable for equivalent inputs with different object key order', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      environmentVariables: { B: '2', A: '1' },
      connectedServices: { z: 1, a: 2 },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
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
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      spawnNonce: 'nonce-a',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      spawnNonce: 'nonce-b',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('uses spawnNonce as the fresh-session admission key even when other spawn options differ', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo-a',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      spawnNonce: 'nonce-shared',
      modelSelection: nativeModelSelection('claude', 'model-a', 1),
      permissionMode: 'read-only',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo-b',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'nonce-shared',
      modelSelection: nativeModelSelection('codex', 'model-b', 1),
      permissionMode: 'default',
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
    expect(k.kind).toBe('existing');
    expect(k.key).toMatch(/^existing:sess_1:request:[a-f0-9]{64}$/);
    if (k.kind !== 'existing') throw new Error('Expected existing-session key');
    expect(k.serializationKey).toBe('existing:sess_1');
  });

  it('distinguishes a one-shot Provider confirmation while retaining one existing-session serialization lane', () => {
    const base = {
      directory: '/tmp',
      existingSessionId: 'sess_1',
    } satisfies SpawnSessionOptions;
    const ordinary = computeDaemonSpawnRequestKey(base);
    const confirmed = computeDaemonSpawnRequestKey({
      ...base,
      providerBindingSecurityChangeConfirmationV1: providerBindingSecurityChangeConfirmation,
    });
    const confirmedReplay = computeDaemonSpawnRequestKey({
      ...base,
      providerBindingSecurityChangeConfirmationV1: { ...providerBindingSecurityChangeConfirmation },
    });

    expect(confirmed.key).not.toBe(ordinary.key);
    expect(confirmed.key).toBe(confirmedReplay.key);
    expect(ordinary.kind).toBe('existing');
    expect(confirmed.kind).toBe('existing');
    if (ordinary.kind !== 'existing' || confirmed.kind !== 'existing') {
      throw new Error('Expected existing-session keys');
    }
    expect(confirmed.serializationKey).toBe(ordinary.serializationKey);
  });

  it('distinguishes authorized requests while keeping one serialization lane per existing session', () => {
    const authorizedOptions = (localId: string, machineId: string): SpawnSessionOptions => ({
      machineId,
      directory: '/tmp',
      existingSessionId: 'sess_1',
      executionAuthorization: {
        provenance: 'user_request',
        requestId: localId,
      },
    });
    const first = computeDaemonSpawnRequestKey(authorizedOptions('local-1', 'machine-1'));
    const firstReplay = computeDaemonSpawnRequestKey(authorizedOptions('local-1', ' machine-1 '));
    const second = computeDaemonSpawnRequestKey(authorizedOptions('local-2', 'machine-1'));

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
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 111,
      modelSelection: nativeModelSelection('claude', 'gpt-5', 111),
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 222,
      modelSelection: nativeModelSelection('claude', 'gpt-5', 222),
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).toBe(b.key);
  });

  it('includes transcriptStorage=direct in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      transcriptStorage: 'direct',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('includes Windows Terminal window name in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'happier-qa',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('includes canonical codexBackendMode in the new-session key', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'appServer',
    } satisfies SpawnSessionOptions);
    expect(a.kind).toBe('new');
    expect(b.kind).toBe('new');
    expect(a.key).not.toBe(b.key);
  });

  it('coalesces retired mcp backend mode with canonical app-server', () => {
    const legacy = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'mcp',
    } as unknown as SpawnSessionOptions);
    const canonical = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'appServer',
    } satisfies SpawnSessionOptions);
    expect(legacy.kind).toBe('new');
    expect(canonical.kind).toBe('new');
    expect(legacy.key).toBe(canonical.key);
  });

  it('treats legacy experimentalCodexAcp requests as canonical acp for the new-session key', () => {
    const canonical = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    } satisfies SpawnSessionOptions);
    const legacy = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      experimentalCodexAcp: true,
    } satisfies SpawnSessionOptions);

    expect(canonical.kind).toBe('new');
    expect(legacy.kind).toBe('new');
    expect(canonical.key).toBe(legacy.key);
  });

  it('includes provider runtime selection from non-Codex runtime descriptors in the new-session key', () => {
    const server = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: { backendMode: 'server' },
      },
    } satisfies SpawnSessionOptions);
    const acp = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: { backendMode: 'acp' },
      },
    } satisfies SpawnSessionOptions);

    expect(server.kind).toBe('new');
    expect(acp.kind).toBe('new');
    expect(server.key).not.toBe(acp.key);
  });

  it('is stable for reordered generic runtime descriptor envelope keys', () => {
    const first = computeRuntimeDescriptorKeys({
      v: 1,
      agentId: 'custom-agent',
      agent: {
        backendMode: 'custom-runtime',
        agentExtra: {
          owner: 'custom-agent',
          schemaId: 'custom-agent.runtimeDescriptor.extra',
          v: 1,
          runtimeIdentity: {
            region: 'eu',
            worker: 'primary',
          },
        },
        providerSessionId: 'session_1',
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
      agent: {
        providerSessionId: 'session_1',
        agentExtra: {
          runtimeIdentity: {
            worker: 'primary',
            region: 'eu',
          },
          v: 1,
          schemaId: 'custom-agent.runtimeDescriptor.extra',
          owner: 'custom-agent',
        },
        backendMode: 'custom-runtime',
      },
      agentId: 'custom-agent',
      v: 1,
    });

    expect(first.newSession.key).toBe(reordered.newSession.key);
    expect(first.existingSession.key).toBe(reordered.existingSession.key);
  });

  it('changes both key families when any known-agent descriptor field category changes', () => {
    const baseDescriptor = {
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'acp',
        futureRuntimeFlag: 'first',
        agentExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'acp',
            futureAffinityField: 'first',
          },
          futureAgentExtraField: 'first',
        },
      },
      futureEnvelopeField: 'first',
    } as const satisfies NonNullable<SpawnSessionOptions['runtimeDescriptorV1']>;
    const base = computeRuntimeDescriptorKeys(baseDescriptor);
    const changedDescriptors = [
      {
        ...baseDescriptor,
        agent: {
          ...baseDescriptor.agent,
          backendMode: 'appServer',
        },
      },
      {
        ...baseDescriptor,
        agent: {
          ...baseDescriptor.agent,
          futureRuntimeFlag: 'second',
        },
      },
      {
        ...baseDescriptor,
        agent: {
          ...baseDescriptor.agent,
          agentExtra: {
            ...baseDescriptor.agent.agentExtra,
            futureAgentExtraField: 'second',
          },
        },
      },
      {
        ...baseDescriptor,
        agent: {
          ...baseDescriptor.agent,
          agentExtra: {
            ...baseDescriptor.agent.agentExtra,
            runtimeAffinity: {
              ...baseDescriptor.agent.agentExtra.runtimeAffinity,
              futureAffinityField: 'second',
            },
          },
        },
      },
      {
        ...baseDescriptor,
        futureEnvelopeField: 'second',
      },
    ] satisfies NonNullable<SpawnSessionOptions['runtimeDescriptorV1']>[];

    for (const changedDescriptor of changedDescriptors) {
      const changed = computeRuntimeDescriptorKeys(changedDescriptor);
      expect(changed.newSession.key).not.toBe(base.newSession.key);
      expect(changed.existingSession.key).not.toBe(base.existingSession.key);
    }
  });

  it('includes a valid unknown-agent runtime descriptor in both key families', () => {
    const absent = computeRuntimeDescriptorKeys(undefined);
    const present = computeRuntimeDescriptorKeys({
      v: 1,
      agentId: 'custom-agent',
      agent: {
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
      agentId: 'custom-agent',
      agent: {},
    } as unknown as SpawnSessionOptions['runtimeDescriptorV1']);
    const invalidAgentId = computeRuntimeDescriptorKeys({
      v: 1,
      agentId: '',
      agent: {},
    } as SpawnSessionOptions['runtimeDescriptorV1']);

    expect(invalidVersion.newSession.key).toBe(absent.newSession.key);
    expect(invalidVersion.existingSession.key).toBe(absent.existingSession.key);
    expect(invalidAgentId.newSession.key).toBe(absent.newSession.key);
    expect(invalidAgentId.existingSession.key).toBe(absent.existingSession.key);
  });

  it('includes mcpSelection in the new-session key while ignoring list order noise', () => {
    const a = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-b', 'portable-a'],
        forceExcludeServerIds: ['workspace-a'],
      },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
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
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-a'],
        forceExcludeServerIds: [],
      },
    } satisfies SpawnSessionOptions);
    const b = computeDaemonSpawnRequestKey({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
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
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const,
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

  it('does not coalesce different pending first-input custody when no spawn nonce is supplied', () => {
    const base = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const,
    } satisfies SpawnSessionOptions;

    const withoutInput = computeDaemonSpawnRequestKey(base);
    const withInput = computeDaemonSpawnRequestKey({
      ...base,
      pendingFirstInput: {
        text: 'first prompt',
        localId: 'spawn-first-turn:launch-1',
      },
    } satisfies SpawnSessionOptions);

    expect(withInput.kind).toBe('new');
    expect(withInput.key).not.toBe(withoutInput.key);
  });

  it('ignores session config option freshness timestamps when effective values are unchanged', () => {
    const base = {
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const,
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
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } as const,
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

  it('keeps a timed-out nonce admitted as pending so retries do not spawn duplicate provider work', async () => {
    let now = 10_000;
    const nowMs = () => now;
    const coalescer = createSpawnRequestCoalescer({
      nowMs,
      recentSuccessTtlMs: 2_000,
      pendingTimeoutTtlMs: 5_000,
    });
    const key = { kind: 'new' as const, key: 'new:nonce:abc' };
    const timeoutResult = {
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session startup timed out',
    };
    const work = vi.fn()
      .mockResolvedValueOnce(timeoutResult)
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess_duplicate' });

    await expect(coalescer.run(key, work)).resolves.toEqual(timeoutResult);
    await expect(coalescer.run(key, work)).resolves.toEqual(timeoutResult);
    expect(work).toHaveBeenCalledTimes(1);

    now += 5_001;
    await expect(coalescer.run(key, work)).resolves.toEqual({
      type: 'success',
      sessionId: 'sess_duplicate',
    });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('coalesces a concurrent replay of the same authorized existing-session request', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    const key = computeAuthorizedExistingSessionKey('same');
    const work = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess_1' }));

    await expect(Promise.all([coalescer.run(key, work), coalescer.run(key, work)])).resolves.toEqual([
      { type: 'success', sessionId: 'sess_1' },
      { type: 'success', sessionId: 'sess_1' },
    ]);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('caches a sequential replay of the same exact authorized existing-session success', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 2_000 });
    const key = computeAuthorizedExistingSessionKey('same');
    const work = vi.fn(async () => ({
      type: 'success' as const,
      spawnNonce: 'spawn-1',
      sessionIdStatus: 'pending' as const,
    }));

    await expect(coalescer.run(key, work)).resolves.toEqual({
      type: 'success',
      spawnNonce: 'spawn-1',
      sessionIdStatus: 'pending',
    });
    await expect(coalescer.run(key, work)).resolves.toEqual({
      type: 'success',
      spawnNonce: 'spawn-1',
      sessionIdStatus: 'pending',
    });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('serializes but does not coalesce confirmation-bearing and ordinary existing-session requests', async () => {
    const coalescer = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    let releaseOrdinary!: () => void;
    const ordinaryBlocked = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const base = {
      directory: '/tmp',
      existingSessionId: 'sess_1',
    } satisfies SpawnSessionOptions;
    const ordinaryKey = computeDaemonSpawnRequestKey(base);
    const confirmedKey = computeDaemonSpawnRequestKey({
      ...base,
      providerBindingSecurityChangeConfirmationV1: providerBindingSecurityChangeConfirmation,
    });
    const ordinaryWork = vi.fn(async () => {
      await ordinaryBlocked;
      return { type: 'success' as const, sessionId: 'ordinary' };
    });
    const confirmedWork = vi.fn(async () => ({ type: 'success' as const, sessionId: 'confirmed' }));

    const ordinary = coalescer.run(ordinaryKey, ordinaryWork);
    await vi.waitFor(() => expect(ordinaryWork).toHaveBeenCalledTimes(1));
    const confirmed = coalescer.run(confirmedKey, confirmedWork);
    await Promise.resolve();
    expect(confirmedWork).not.toHaveBeenCalled();
    releaseOrdinary();

    await expect(ordinary).resolves.toEqual({ type: 'success', sessionId: 'ordinary' });
    await expect(confirmed).resolves.toEqual({ type: 'success', sessionId: 'confirmed' });
    expect(confirmedWork).toHaveBeenCalledTimes(1);
  });

  it('rejects changed execution options instead of joining the same authorization', async () => {
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
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      executionAuthorization,
    } satisfies SpawnSessionOptions);
    const conflictingKey = computeDaemonSpawnRequestKey({
      directory: '/repo-b',
      existingSessionId: 'sess_1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
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
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(conflictingWork).not.toHaveBeenCalled();
    await expect(first).resolves.toEqual({ type: 'success', sessionId: 'from-first' });
  });

  it('rejects changed machine hook context instead of joining the same exact authorization', async () => {
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
      machineId: 'machine-a',
      directory: '/repo',
      existingSessionId: 'sess_1',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      executionAuthorization,
    } satisfies SpawnSessionOptions);
    const conflictingKey = computeDaemonSpawnRequestKey({
      machineId: 'machine-b',
      directory: '/repo',
      existingSessionId: 'sess_1',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
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
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(conflictingWork).not.toHaveBeenCalled();
    await expect(first).resolves.toEqual({ type: 'success', sessionId: 'from-first' });
  });

});
