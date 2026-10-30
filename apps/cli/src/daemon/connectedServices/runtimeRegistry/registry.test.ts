import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import {
  ConnectedServiceRuntimeRegistry,
  readConnectedServiceRuntimeTargetIdentity,
} from './registry';

const connectedServicesBindingsRaw = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'group',
      groupId: 'team',
      profileId: 'codex-a',
    },
  },
} as const;

const connectedServiceSelectionsEnv = {
  [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
    kind: 'group',
    serviceId: 'openai-codex',
    groupId: 'team',
    activeProfileId: 'codex-a',
    fallbackProfileId: 'codex-b',
    generation: 7,
  }]),
} as const;

function connectedServiceSelectionsEnvWithCredentialRevision(credentialRevision: string) {
  return {
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'codex-a',
      fallbackProfileId: 'codex-b',
      generation: 7,
      credentialRevision,
    }]),
  } as const;
}

function registerFullTarget(registry: ConnectedServiceRuntimeRegistry) {
  return registry.registerTarget({
    pid: 42,
    agentId: 'codex',
    sessionId: 'sess-a',
    connectedServicesBindingsRaw,
    connectedServiceSelectionsEnv,
    materializationKey: 'csm_runtime_registry',
    connectedServiceMaterializationIdentityV1: {
      v: 1,
      id: 'csm_runtime_registry',
      createdAtMs: 1_000,
    },
    sessionDirectory: '/workspace/a',
  });
}

describe('ConnectedServiceRuntimeRegistry', () => {
  it('publishes current registrations from both keyspaces and fences replaced registrations', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const registrations: Array<{
      key: { kind: 'session'; pid: number } | { kind: 'execution_run'; runKey: string };
      target: ReturnType<ConnectedServiceRuntimeRegistry['registerTarget']>;
    }> = [];
    const unsubscribe = registry.onTargetRegistration((registration) => registrations.push(registration));

    const session = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'session-observed',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'session-observed-key',
    });
    const run = registry.registerRunTarget({
      runKey: 'execution_run:observed',
      pid: 42,
      agentId: 'codex',
      sessionId: 'session-observed',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'execution_run:observed',
    });

    expect(registrations).toEqual([
      { key: { kind: 'session', pid: 42 }, target: session },
      { key: { kind: 'execution_run', runKey: 'execution_run:observed' }, target: run },
    ]);
    expect(registry.listTargetRegistrations()).toEqual(registrations);
    expect(registry.isCurrentTargetRegistration(registrations[0]!)).toBe(true);
    expect(registry.isCurrentTargetRegistration(registrations[1]!)).toBe(true);

    const unchangedRun = registry.registerRunTarget({
      runKey: 'execution_run:observed',
      pid: 42,
      agentId: 'codex',
      sessionId: 'session-observed',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'execution_run:observed',
    });
    expect(unchangedRun).toBe(run);
    expect(registrations.at(-1)).toEqual({
      key: { kind: 'execution_run', runKey: 'execution_run:observed' },
      target: run,
    });

    registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'session-observed',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision('csr_cccccccccccccccccccccc'),
      materializationKey: 'session-observed-key',
    });
    registry.unregisterRunKey('execution_run:observed');

    expect(registry.isCurrentTargetRegistration({ key: { kind: 'session', pid: 42 }, target: session })).toBe(false);
    expect(registry.isCurrentTargetRegistration({ key: { kind: 'execution_run', runKey: 'execution_run:observed' }, target: run })).toBe(false);
    unsubscribe();
  });

  it('indexes and evicts targets by broker selection identity (R3-6)', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const identity = 'opencode|connected|broker:1|openai-codex:codex-a:acct';

    registry.registerTarget({
      pid: 70,
      agentId: 'opencode',
      sessionId: 'sess-broker-a',
      brokerSelectionIdentity: identity,
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_broker_a',
    });
    registry.registerTarget({
      pid: 71,
      agentId: 'opencode',
      sessionId: 'sess-broker-b',
      brokerSelectionIdentity: identity,
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_broker_b',
    });

    // Two live sessions share the shared-server selection identity; the lowest live pid wins.
    expect(registry.getByBrokerSelectionIdentity(identity)?.pid).toBe(70);
    expect(registry.getByBrokerSelectionIdentity('no-such-identity')).toBeNull();

    // Dropping the lower pid keeps resolution live via the surviving sibling.
    registry.unregisterPid(70);
    expect(registry.getByBrokerSelectionIdentity(identity)?.pid).toBe(71);

    // Once every live target is gone the identity resolves to null (fail-closed).
    registry.unregisterPid(71);
    expect(registry.getByBrokerSelectionIdentity(identity)).toBeNull();
  });

  it('registers, updates, and unregisters targets across pid and session indexes', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    const registered = registerFullTarget(registry);

    expect(registered.revision).toBe(1);
    expect(registry.getByPid(42)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(42);

    const updated = registry.updateTarget({
      pid: 42,
      sessionId: 'sess-b',
      sessionDirectory: '/workspace/b',
    });

    expect(updated?.revision).toBe(2);
    expect(registry.getByPid(42)?.sessionDirectory).toBe('/workspace/b');
    expect(registry.getBySessionId('sess-a')).toBeNull();
    expect(registry.getBySessionId('sess-b')?.pid).toBe(42);

    const unregistered = registry.unregisterPid(42);

    expect(unregistered?.pid).toBe(42);
    expect(registry.getByPid(42)).toBeNull();
    expect(registry.getBySessionId('sess-b')).toBeNull();
  });

  it('transfers a target to a promoted pid without losing its session identity', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registerFullTarget(registry);

    const transferred = registry.transferPid(42, 84);

    expect(transferred?.pid).toBe(84);
    expect(transferred?.sessionId).toBe('sess-a');
    expect(transferred?.revision).toBe(2);
    expect(registry.getByPid(42)).toBeNull();
    expect(registry.getByPid(84)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(84);
  });

  it('replaces the old pid entry when the same session reattaches under a new pid', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registerFullTarget(registry);

    const reattached = registry.registerTarget({
      pid: 84,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_runtime_registry',
      sessionDirectory: '/workspace/a',
    });

    expect(reattached.pid).toBe(84);
    expect(registry.getByPid(42)).toBeNull();
    expect(registry.getByPid(84)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(84);
    expect(registry.listTargets().map((target) => target.pid)).toEqual([84]);
    expect(registry.listRefreshTargets().map((target) => target.pid)).toEqual([84]);
    expect(registry.listQuotaTargets().map((target) => target.pid)).toEqual([84]);
  });

  it('adopts a session id onto a target and updates both consumer views atomically', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_runtime_registry',
    });

    const adopted = registry.adoptSessionId({ pid: 42, sessionId: 'sess-adopted' });

    expect(adopted?.sessionId).toBe('sess-adopted');
    expect(registry.getBySessionId('sess-adopted')?.pid).toBe(42);
    expect(registry.listRefreshTargets()[0]?.sessionId).toBe('sess-adopted');
    expect(registry.listQuotaTargets()[0]?.sessionId).toBe('sess-adopted');
  });

  it('does not bump the revision for unchanged reattach updates', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const registered = registerFullTarget(registry);

    const unchanged = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
      materializationKey: 'csm_runtime_registry',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_runtime_registry',
        createdAtMs: 1_000,
      },
      sessionDirectory: '/workspace/a',
    });

    expect(unchanged.revision).toBe(registered.revision);
    expect(unchanged).toBe(registered);
  });

  it('changes the runtime binding identity when the same profile receives a new credential revision', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const firstRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const secondRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';

    const first = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(firstRevision),
      materializationKey: 'csm_runtime_registry',
    });
    const second = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(secondRevision),
      materializationKey: 'csm_runtime_registry',
    });

    expect(first.activeBindings).toEqual([expect.objectContaining({
      profileId: 'codex-a',
      credentialRevision: firstRevision,
    })]);
    expect(second.activeBindings).toEqual([expect.objectContaining({
      profileId: 'codex-a',
      credentialRevision: secondRevision,
    })]);
    expect(second.runtimeIdentityKey).not.toBe(first.runtimeIdentityKey);
    expect(second.revision).toBe(first.revision + 1);
  });

  it('advances the existing session binding only after exact group application settles', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const target = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(
        'csr_aaaaaaaaaaaaaaaaaaaaaa',
      ),
      materializationKey: 'csm_runtime_registry',
    });
    const registration = { key: { kind: 'session' as const, pid: target.pid }, target };

    const settled = registry.adoptExactGroupApplicationForSession({
      sessionId: 'sess-a',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'codex-b',
      generation: 8,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(settled?.activeBindings).toEqual([{
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'codex-b',
      generation: 8,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }]);
    expect(registry.getBySessionId('sess-a')).toBe(settled);
    expect(registry.isCurrentTargetRegistration(registration)).toBe(true);
  });

  it('does not fabricate an exact group binding for an unregistered scope', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const original = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(
        'csr_aaaaaaaaaaaaaaaaaaaaaa',
      ),
      materializationKey: 'csm_runtime_registry',
    });

    expect(registry.adoptExactGroupApplicationForSession({
      sessionId: 'sess-a',
      serviceId: 'openai-codex',
      groupId: 'other-team',
      profileId: 'codex-b',
      generation: 8,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    })).toBeNull();
    expect(registry.getBySessionId('sess-a')).toBe(original);
  });

  it('adopts a refreshed credential revision only for represented runtime identities that applied it', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const firstRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const secondRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const first = registry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(firstRevision),
      materializationKey: 'session-a',
    });
    const run = registry.registerRunTarget({
      runKey: 'execution_run:a',
      pid: 42,
      agentId: 'codex',
      sessionId: 'sess-a',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(firstRevision),
      materializationKey: 'execution_run:a',
    });
    registry.registerTarget({
      pid: 84,
      agentId: 'codex',
      sessionId: 'sess-b',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv: connectedServiceSelectionsEnvWithCredentialRevision(firstRevision),
      materializationKey: 'session-b',
    });

    expect(registry.adoptCredentialRevisionForProfile({
      serviceId: 'openai-codex',
      profileId: 'codex-a',
      credentialRevision: secondRevision,
      runtimeIdentityKeys: new Set([first.runtimeIdentityKey, run.runtimeIdentityKey]),
    })).toBe(2);

    const registrations = registry.listTargetRegistrations();
    expect(registrations.find((entry) => entry.key.kind === 'session' && entry.key.pid === 42)
      ?.target.activeBindings[0]?.credentialRevision).toBe(secondRevision);
    expect(registrations.find((entry) => entry.key.kind === 'execution_run')
      ?.target.activeBindings[0]?.credentialRevision).toBe(secondRevision);
    expect(registrations.find((entry) => entry.key.kind === 'session' && entry.key.pid === 84)
      ?.target.activeBindings[0]?.credentialRevision).toBe(firstRevision);
  });

  it('exposes the same connected-service runtime identity to refresh and quota views', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registerFullTarget(registry);

    const refreshTarget = registry.listRefreshTargets()[0];
    const quotaTarget = registry.listQuotaTargets()[0];

    expect(refreshTarget).toBeDefined();
    expect(quotaTarget).toBeDefined();
    expect(refreshTarget?.runtimeIdentityKey).toBe(quotaTarget?.runtimeIdentityKey);
    expect(readConnectedServiceRuntimeTargetIdentity(refreshTarget!)).toEqual(
      readConnectedServiceRuntimeTargetIdentity(quotaTarget!),
    );
  });

  it('covers a run target and a session target on the SAME pid in the refresh distribution view (R3-1)', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    // A session (claude) runs in a runner process with pid 4242.
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'sess-host',
      materializationKey: 'session-key',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'claude-a' },
        },
      },
    });

    // A codex execution run is hosted INSIDE that same runner pid — it must coexist, keyed by its
    // run key, and share coverage on the same pid instead of clobbering the session registration.
    const runTarget = registry.registerRunTarget({
      runKey: 'execution_run:run_codex_1',
      pid: 4242,
      agentId: 'codex',
      materializationKey: 'execution_run:run_codex_1',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
    });
    expect(runTarget.materializationKey).toBe('execution_run:run_codex_1');

    // The pid map still resolves to the SESSION target (untouched).
    expect(registry.getByPid(4242)?.materializationKey).toBe('session-key');
    expect(registry.getByPid(4242)?.agentId).toBe('claude');

    // Both targets are visible to refresh redistribution + quota fanout.
    const refreshKeys = registry.listRefreshTargets().map((target) => target.materializationKey).sort();
    expect(refreshKeys).toEqual(['execution_run:run_codex_1', 'session-key']);
    const quotaKeys = registry.listQuotaTargets().map((target) => target.materializationKey).sort();
    expect(quotaKeys).toEqual(['execution_run:run_codex_1', 'session-key']);

    // Releasing the run removes ONLY the run target; the session coverage remains.
    expect(registry.unregisterRunKey('execution_run:run_codex_1')?.materializationKey).toBe('execution_run:run_codex_1');
    expect(registry.listRefreshTargets().map((target) => target.materializationKey)).toEqual(['session-key']);
    expect(registry.getByPid(4242)?.materializationKey).toBe('session-key');
  });

  it('drops a run target when its host runner pid is unregistered or transferred (R3-1)', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 4242,
      agentId: 'claude',
      sessionId: 'sess-host',
      materializationKey: 'session-key',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
    });
    registry.registerRunTarget({
      runKey: 'execution_run:run_codex_1',
      pid: 4242,
      agentId: 'codex',
      materializationKey: 'execution_run:run_codex_1',
      connectedServicesBindingsRaw,
      connectedServiceSelectionsEnv,
    });

    // A dead runner takes its execution runs with it.
    registry.unregisterPid(4242);
    expect(registry.listTargets()).toEqual([]);
    expect(registry.unregisterRunKey('execution_run:run_codex_1')).toBeNull();
  });

  it('resolves a broker selection identity from a RUN target with no live session sharing it (NF-1)', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    // An OpenCode run bound to a pool that no live session uses. Its broker token refresh authorizes
    // via getByBrokerSelectionIdentity — which must fold in the run keyspace, not just session targets.
    registry.registerRunTarget({
      runKey: 'execution_run:run_oc_1',
      pid: 5150,
      agentId: 'opencode',
      materializationKey: 'execution_run:run_oc_1',
      brokerSelectionIdentity: 'oc-pool-x',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'opencode-zen': { source: 'connected', selection: 'group', groupId: 'pool-x', profileId: 'oc-a' },
        },
      },
    });

    const resolved = registry.getByBrokerSelectionIdentity('oc-pool-x');
    expect(resolved?.materializationKey).toBe('execution_run:run_oc_1');
    expect(resolved?.pid).toBe(5150);

    // Evicted on run release — no leak, no cross-run authorize of a dead run.
    registry.unregisterRunKey('execution_run:run_oc_1');
    expect(registry.getByBrokerSelectionIdentity('oc-pool-x')).toBeNull();
  });

  it('evicts a run target from the broker index when its runner pid dies (NF-1)', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerRunTarget({
      runKey: 'execution_run:run_pi_1',
      pid: 6200,
      agentId: 'pi',
      materializationKey: 'execution_run:run_pi_1',
      brokerSelectionIdentity: 'pi-pool-y',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'pi-managed': { source: 'connected', selection: 'group', groupId: 'pool-y', profileId: 'pi-a' },
        },
      },
    });
    expect(registry.getByBrokerSelectionIdentity('pi-pool-y')?.pid).toBe(6200);

    registry.unregisterPid(6200);
    expect(registry.getByBrokerSelectionIdentity('pi-pool-y')).toBeNull();
  });

  it('can retire only a superseded session registration without deleting live run targets on the pid', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 6201,
      sessionId: 'superseded-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
        },
      },
    });
    registry.registerRunTarget({
      runKey: 'execution_run:still-live',
      pid: 6201,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'run-profile' },
        },
      },
    });

    expect(registry.unregisterSessionTargetByPid(6201)?.sessionId).toBe('superseded-session');
    expect(registry.getBySessionId('superseded-session')).toBeNull();
    expect(registry.listTargetRegistrations()).toEqual([
      expect.objectContaining({ key: { kind: 'execution_run', runKey: 'execution_run:still-live' } }),
    ]);
  });

  it('owns session runtime account identity and clears it with the session target', () => {
    let now = 1_000;
    const registry = new ConnectedServiceRuntimeRegistry({
      nowMs: () => now,
      runtimeAccountIdentityTtlMs: 50,
    });
    registerFullTarget(registry);

    expect(registry.recordRuntimeAccountIdentity({
      sessionId: 'sess-a',
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'codex-a',
      providerAccountId: 'acct-a',
      accountLabel: 'a@example.test',
      observedAtMs: now,
      source: 'spawn_selection',
      proofStrength: 'exact',
      groupGeneration: 7,
    })).toEqual({ status: 'recorded' });

    expect(registry.readRuntimeAccountIdentity('sess-a')).toMatchObject({
      providerAccountId: 'acct-a',
      groupGeneration: 7,
    });

    now = 1_025;
    expect(registry.listRuntimeIdentitiesByProviderAccount({
      serviceId: 'openai-codex',
      providerAccountId: 'acct-a',
      groupId: 'team',
      currentGroupGenerationBySessionId: new Map([['sess-a', 7]]),
    }).map((entry) => entry.sessionId)).toEqual(['sess-a']);

    registry.unregisterPid(42);
    expect(registry.readRuntimeAccountIdentity('sess-a')).toBeNull();
  });
});
