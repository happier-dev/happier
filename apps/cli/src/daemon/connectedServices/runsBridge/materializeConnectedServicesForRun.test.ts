import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import {
  ExecutionRunConnectedServiceMaterializeError,
  createExecutionRunConnectedServicesBridge,
  type ResolveConnectedServiceAuthForRun,
} from './materializeConnectedServicesForRun';

const RUN_KEY = 'execution_run:run_codex_1';

function buildResolved(cleanupOnExit: (() => void) | null = null) {
  return {
    env: { CODEX_HOME: '/materialized/run/codex/codex-home' },
    materializationRoot: '/materialized/run/codex',
    cleanupMaterializationRoot: () => {},
    cleanupOnFailure: null,
    cleanupOnExit,
    connectedServicesBindings: {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      },
    },
    runtimeAccountIdentitySelections: [],
  };
}

function buildRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    runId: 'run_codex_1',
    agentId: 'codex' as const,
    pid: 4242,
    materializationKey: RUN_KEY,
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    },
    sessionDirectory: '/tmp/workspace',
    ...overrides,
  };
}

describe('createExecutionRunConnectedServicesBridge', () => {
  it('materializes via the spawn resolver, registers the run in the run keyspace, and returns the env', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const resolveAuthForSpawn = vi.fn(async (_input: unknown) => buildResolved());
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: resolveAuthForSpawn as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const result = await bridge.materialize(buildRequest());

    expect(result.env).toEqual({ CODEX_HOME: '/materialized/run/codex/codex-home' });
    expect(result.proof).toEqual({
      v: 1,
      agentId: 'codex',
      materializationKey: RUN_KEY,
      connectedServicesBindings: buildResolved().connectedServicesBindings,
    });
    expect(result.registration).toEqual({
      v: 1,
      agentId: 'codex',
      materializationKey: RUN_KEY,
      connectedServicesBindings: buildResolved().connectedServicesBindings,
      brokerSelectionIdentity: null,
      runtimeAccountIdentitySelections: [],
      sessionDirectory: '/tmp/workspace',
      materializedRoot: '/materialized/run/codex',
    });
    expect(resolveAuthForSpawn.mock.calls.at(0)?.[0]).toMatchObject({
      agentId: 'codex',
      materializationKey: RUN_KEY,
      sessionDirectory: '/tmp/workspace',
    });
    // The run is covered by refresh redistribution via the run keyspace (not the pid map).
    const refreshTargets = registry.listRefreshTargets();
    expect(refreshTargets.map((target) => target.materializationKey)).toEqual([RUN_KEY]);
    expect(refreshTargets[0]?.agentId).toBe('codex');
    expect(refreshTargets[0]?.pid).toBe(4242);
  });

  it('registers and returns the exact non-secret generation and credential revision selected for a run', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const credentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const connectedServiceSelectionsJson = JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'work',
      fallbackProfileId: 'backup',
      generation: 12,
      credentialRevision,
    }]);
    const connectedServicesBindings = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'group' as const,
          groupId: 'team',
          profileId: 'work',
        },
      },
    };
    const registrations: unknown[] = [];
    registry.onTargetRegistration((registration) => registrations.push(registration));
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(),
        env: {
          CODEX_HOME: '/materialized/run/codex/codex-home',
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedServiceSelectionsJson,
        },
        connectedServicesBindings,
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const result = await bridge.materialize(buildRequest());

    // Preserve the old strict daemon→runner registration wire shape; the runner derives this
    // non-secret envelope from the already-returned env before writing its local marker.
    expect(result.registration).not.toHaveProperty('connectedServiceSelectionsJson');
    expect(registry.listTargets()[0]?.activeBindings).toEqual([expect.objectContaining({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'work',
      generation: 12,
      credentialRevision,
    })]);
    expect(registrations).toEqual([expect.objectContaining({
      key: { kind: 'execution_run', runKey: RUN_KEY },
      target: registry.listTargets()[0],
    })]);
  });

  it('returns only non-secret runtime account identity facts for durable launch registration', async () => {
    const credential = {
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      profileId: 'work',
      kind: 'oauth' as const,
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 3,
      oauth: {
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        idToken: 'secret-id-token',
        scope: 'openid',
        tokenType: 'Bearer',
        providerAccountId: 'account-1',
        providerEmail: 'work@example.com',
        raw: { secret: 'raw-secret' },
      },
      token: null,
    };
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(),
        runtimeAccountIdentitySelections: [{
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: null,
          groupGeneration: null,
          record: credential,
          source: 'spawn_selection',
        }],
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const result = await bridge.materialize(buildRequest({ sessionId: 'session-1' }));

    expect(result.registration.runtimeAccountIdentitySelections).toEqual([{
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
      groupGeneration: null,
      providerAccountId: 'account-1',
      accountLabel: 'work@example.com',
      source: 'spawn_selection',
    }]);
    expect(JSON.stringify(result.registration)).not.toContain('secret-');
    expect(registry.listQuotaTargets()[0]?.runtimeAccountIdentitySelections).toEqual([
      expect.objectContaining({ record: credential }),
    ]);
  });

  it('R3-1: coexists with an existing session target on the same PID — BOTH covered by refresh distribution', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'session-1',
      materializationKey: 'session-key-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'a' },
        },
      },
    });
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved()) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const result = await bridge.materialize(buildRequest());

    expect(result.env).toEqual({ CODEX_HOME: '/materialized/run/codex/codex-home' });
    // The session pid target is untouched…
    const sessionTarget = registry.getByPid(4242);
    expect(sessionTarget?.materializationKey).toBe('session-key-1');
    expect(sessionTarget?.agentId).toBe('claude');
    // …and the run target coexists on the same pid — a rotation's redistribution now reaches BOTH.
    const refreshKeys = registry.listRefreshTargets().map((target) => target.materializationKey).sort();
    expect(refreshKeys).toEqual([RUN_KEY, 'session-key-1']);
  });

  it('NF-1: indexes the run target by its broker selection identity so a broker refresh authorizes it', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(),
        env: { OPENCODE_SERVER: 'http://x', HAPPIER_OPENCODE_BROKER_SELECTION_IDENTITY: 'oc-pool-x' },
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      resolveBrokerSelectionIdentity: (env) => env['HAPPIER_OPENCODE_BROKER_SELECTION_IDENTITY'] ?? null,
    });

    await bridge.materialize(buildRequest({ agentId: 'opencode' }));

    // No live session shares the pool, yet the run is resolvable by its broker selection identity.
    const resolved = registry.getByBrokerSelectionIdentity('oc-pool-x');
    expect(resolved?.materializationKey).toBe(RUN_KEY);

    // Released on run end — no cross-run authorize of a dead run.
    await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(registry.getByBrokerSelectionIdentity('oc-pool-x')).toBeNull();
  });

  it('fails CLOSED (typed error, no registration) when the resolver yields no selection', async () => {
    // POST-WAVE-REVIEW F1: the runner only calls materialize when a CS selection was prepared, so
    // an unresolved selection here means the run would silently proceed on the runner's INHERITED
    // account — a fail-open identity hazard. It must reject instead (dev-parity).
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => null) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await expect(bridge.materialize(buildRequest())).rejects.toMatchObject({
      code: 'execution_run_connected_service_materialization_failed',
    });
    expect(registry.getByPid(4242)).toBeNull();
  });

  it('fails CLOSED with a typed error when resolution throws', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => {
        throw new Error('materialization exploded');
      }) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await expect(bridge.materialize(buildRequest())).rejects.toBeInstanceOf(ExecutionRunConnectedServiceMaterializeError);
    expect(registry.getByPid(4242)).toBeNull();
  });

  it('release unregisters the run target and runs the materialized-root cleanup exactly once', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanupOnExit = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved(cleanupOnExit)) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await bridge.materialize(buildRequest());
    expect(registry.listRefreshTargets().map((target) => target.materializationKey)).toEqual([RUN_KEY]);

    const released = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(released.released).toBe(true);
    expect(registry.listRefreshTargets()).toEqual([]);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);

    // Idempotent: a second release is a no-op.
    const again = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
    expect(again.released).toBe(false);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
  });

  it('reclaims the exact run allocation when target admission fails after materialization', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.onTargetRegistration(() => {
      throw new Error('target admission rejected');
    });
    const cleanupMaterializationRoot = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(null),
        cleanupMaterializationRoot,
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await expect(bridge.materialize(buildRequest())).rejects.toThrow('target admission rejected');
    expect(cleanupMaterializationRoot).toHaveBeenCalledTimes(1);
    expect(registry.listRefreshTargets()).toEqual([]);
  });

  it('release removes the run allocation without deleting a provider-owned target root', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'happier-er-cs-run-root-'));
    const providerTargetRoot = await mkdtemp(join(tmpdir(), 'happier-er-cs-provider-root-'));
    const cleanupMaterializationRoot = vi.fn(async () => {
      await rm(runRoot, { recursive: true, force: true });
    });
    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => ({
        ...buildResolved(null),
        materializationRoot: runRoot,
        cleanupMaterializationRoot,
        env: {
          CODEX_HOME: providerTargetRoot,
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: providerTargetRoot,
        },
      })) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    try {
      const materialized = await bridge.materialize(buildRequest());
      expect(materialized.registration.materializedRoot).toBe(runRoot);
      const released = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });
      expect(released.released).toBe(true);
      expect(cleanupMaterializationRoot).toHaveBeenCalledTimes(1);
      await expect(stat(runRoot)).rejects.toThrow();
      await expect(stat(providerTargetRoot)).resolves.toBeDefined();
    } finally {
      await rm(runRoot, { recursive: true, force: true });
      await rm(providerTargetRoot, { recursive: true, force: true });
    }
  });

  it('A1: a release racing an in-flight materialize still reclaims the late daemon-side success', async () => {
    // Client-abandonment shape: the runner timed out and fired release while the daemon's materialize
    // was still resolving. Release must serialize behind the in-flight materialize so the late success
    // (root + registered target) is reclaimed instead of leaking.
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanupOnExit = vi.fn();
    let resolveMaterialization!: () => void;
    const materializationGate = new Promise<void>((resolve) => {
      resolveMaterialization = resolve;
    });
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => {
        await materializationGate;
        return buildResolved(cleanupOnExit);
      }) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    const materializePromise = bridge.materialize(buildRequest());
    const releasePromise = bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });

    // Let the release call arrive while the materialization is still pending, then finish it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveMaterialization();

    const [, released] = await Promise.all([materializePromise, releasePromise]);
    expect(released.released).toBe(true);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    expect(registry.listRefreshTargets()).toEqual([]);
  });

  it('keeps materialize + release diagnostics file-only without emitting env values/tokens (QA2-F01)', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanupOnExit = vi.fn();
    const debug = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved(cleanupOnExit)) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      logger: { debug },
    });

    await bridge.materialize(buildRequest());
    await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });

    const materializeLog = debug.mock.calls.find((call) => String(call[0]).includes('materialized'));
    expect(materializeLog?.[1]).toMatchObject({
      runId: 'run_codex_1',
      agentId: 'codex',
      materializationKey: RUN_KEY,
      registered: true,
      envKeyCount: 1,
    });

    const releaseLog = debug.mock.calls.find((call) => String(call[0]).includes('released'));
    expect(releaseLog?.[1]).toMatchObject({ runId: 'run_codex_1', released: true, cleanupRan: true });

    // Values-never-logged: the materialized env VALUE (a home path / would be a token) must never
    // appear anywhere in the emitted diagnostics.
    const serialized = JSON.stringify(debug.mock.calls);
    expect(serialized).not.toContain('/materialized/run/codex/codex-home');
  });

  it('records registered:true even when a session target shares the pid (run keyspace, R3-1)', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'session-1',
      materializationKey: 'session-key-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'a' },
        },
      },
    });
    const debug = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved()) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      logger: { debug },
    });

    await bridge.materialize(buildRequest());

    const materializeLog = debug.mock.calls.find((call) => String(call[0]).includes('materialized'));
    // The run keyspace means a same-pid session no longer forces a coverage skip.
    expect(materializeLog?.[1]).toMatchObject({ registered: true });
    const refreshKeys = registry.listRefreshTargets().map((target) => target.materializationKey).sort();
    expect(refreshKeys).toEqual([RUN_KEY, 'session-key-1']);
  });

  it('release never unregisters a target owned by a different materialization (session target stays)', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'session-1',
      materializationKey: 'session-key-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'a' },
        },
      },
    });
    const cleanupOnExit = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: (async () => buildResolved(cleanupOnExit)) as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
    });

    await bridge.materialize(buildRequest());
    const released = await bridge.release({ runId: 'run_codex_1', pid: 4242, materializationKey: RUN_KEY });

    // Root cleanup still runs (the run's materialized root is run-owned)…
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    expect(released.released).toBe(true);
    // …but the session's registration is untouched.
    expect(registry.getByPid(4242)?.materializationKey).toBe('session-key-1');
  });

  it('adopts a replacement cleanup passively and explicit release runs it exactly once', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const cleanup = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: vi.fn() as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: registry,
      createAdoptedRootCleanup: ({ materializedRoot }) => materializedRoot === '/managed/run-one' ? cleanup : null,
    });

    expect(bridge.adoptLiveMaterialization({
      runId: 'run-one',
      runKey: RUN_KEY,
      pid: 4242,
      agentId: 'codex',
      materializedRoot: '/managed/run-one',
    })).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();

    await bridge.release({ runId: 'run-one', pid: 4242, materializationKey: RUN_KEY });
    await bridge.release({ runId: 'run-one', pid: 4242, materializationKey: RUN_KEY });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe adopted cleanup and allows a later valid retry', async () => {
    const cleanup = vi.fn();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: vi.fn() as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
      createAdoptedRootCleanup: ({ materializedRoot }) => materializedRoot === '/managed/retry' ? cleanup : null,
    });

    expect(bridge.adoptLiveMaterialization({
      runId: 'run-one', runKey: RUN_KEY, pid: 4242, agentId: 'codex', materializedRoot: '/outside',
    })).toBe(false);
    expect(bridge.adoptLiveMaterialization({
      runId: 'run-one', runKey: RUN_KEY, pid: 4242, agentId: 'codex', materializedRoot: '/managed/retry',
    })).toBe(true);
    await bridge.release({ runId: 'run-one', pid: 4242, materializationKey: RUN_KEY });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains an adopted cleanup record after a partial failure so explicit release can retry', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: vi.fn() as unknown as ResolveConnectedServiceAuthForRun,
      runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
      createAdoptedRootCleanup: () => cleanup,
    });
    bridge.adoptLiveMaterialization({
      runId: 'run-one', runKey: RUN_KEY, pid: 4242, agentId: 'codex', materializedRoot: '/managed/retry',
    });

    await expect(bridge.release({ runId: 'run-one', pid: 4242, materializationKey: RUN_KEY }))
      .resolves.toEqual({ released: false });
    await expect(bridge.release({ runId: 'run-one', pid: 4242, materializationKey: RUN_KEY }))
      .resolves.toEqual({ released: true });
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
