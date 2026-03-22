import { describe, expect, it, vi } from 'vitest';

import { createSpawnRequestCoalescer, computeDaemonSpawnRequestKey } from './spawnRequestCoalescer';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('computeDaemonSpawnRequestKey', () => {
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

  it('keys existing-session spawns by session id', () => {
    const k = computeDaemonSpawnRequestKey({
      directory: '/tmp',
      existingSessionId: '  sess_1 ',
    } satisfies SpawnSessionOptions);
    expect(k).toEqual({ kind: 'existing', key: 'existing:sess_1' });
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
});
