import { describe, expect, it, vi } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from './registry';

const connectedBindings = {
  v: 1,
  bindingsByServiceId: {
    'acme.accounts/session-auth': {
      source: 'connected',
      selection: 'group',
      groupId: 'codex-team',
      profileId: 'fallback-profile',
    },
  },
};

const connectedSelections = JSON.stringify([
  {
    kind: 'group',
    serviceId: 'acme.accounts/session-auth',
    groupId: 'codex-team',
    activeProfileId: 'active-profile',
    fallbackProfileId: 'fallback-profile',
    generation: 4,
    policy: null,
    credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
  },
]);

function connectedSelectionsWithCredentialRevision(credentialRevision: string): string {
  return JSON.stringify([{
    kind: 'group',
    serviceId: 'acme.accounts/session-auth',
    groupId: 'codex-team',
    activeProfileId: 'active-profile',
    fallbackProfileId: 'fallback-profile',
    generation: 4,
    policy: null,
    credentialRevision,
  }]);
}

describe('ConnectedServiceRuntimeRegistry', () => {
  it('resolves execution-run targets by exact run key even when they share a runner pid', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ pid: 101, sessionId: 'parent-session' });
    registry.registerRunTarget({ pid: 101, runKey: 'run-1', materializationKey: 'run-1' });
    registry.registerRunTarget({ pid: 101, runKey: 'run-2', materializationKey: 'run-2' });

    expect(registry.getRunTargetByRunKey('run-1')?.materializationKey).toBe('run-1');
    expect(registry.getRunTargetByRunKey('run-2')?.materializationKey).toBe('run-2');
    expect(registry.getRunTargetByRunKey('missing')).toBeNull();
    expect(registry.isRunTarget(registry.getRunTargetByRunKey('run-1')!)).toBe(true);
    expect(registry.isRunTarget(registry.getBySessionId('parent-session')!)).toBe(false);
  });
  it('projects one registered runtime target into refresh and quota views', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    const target = registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    expect(target?.bindings).toEqual([
      {
        serviceId: 'acme.accounts/session-auth',
        profileId: 'active-profile',
        groupId: 'codex-team',
        groupGeneration: 4,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    ]);
    expect(registry.listRefreshTargets()).toEqual([
      expect.objectContaining({
        pid: 123,
        agentId: 'codex',
        sessionId: 'session-1',
        materializationKey: 'mat-1',
      }),
    ]);
    expect(registry.listQuotaTargets()).toEqual([
      expect.objectContaining({
        pid: 123,
        sessionId: 'session-1',
        agentId: 'codex',
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedSelections,
        },
      }),
    ]);
  });

  it('changes the runtime identity when the same profile receives a new credential revision', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const firstRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const secondRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';

    const first = registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelectionsWithCredentialRevision(firstRevision),
    });
    const second = registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelectionsWithCredentialRevision(secondRevision),
    });

    expect(first.bindings).toEqual([expect.objectContaining({ credentialRevision: firstRevision })]);
    expect(second.bindings).toEqual([expect.objectContaining({ credentialRevision: secondRevision })]);
    expect(second.runtimeIdentityKey).not.toBe(first.runtimeIdentityKey);
    expect(second.revision).toBe(first.revision + 1);
  });

  it('advances the existing session binding only after exact group application settles', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    const settled = registry.adoptExactGroupApplicationForSession({
      sessionId: 'session-1',
      serviceId: 'acme.accounts/session-auth',
      groupId: 'codex-team',
      profileId: 'replacement-profile',
      generation: 5,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(settled?.activeBindings).toEqual([{
      serviceId: 'acme.accounts/session-auth',
      profileId: 'replacement-profile',
      groupId: 'codex-team',
      groupGeneration: 5,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    }]);
    expect(registry.getBySessionId('session-1')).toBe(settled);
  });

  it('does not let passive bootstrap registration overwrite a newer accepted runtime selection', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bootstrapRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const acceptedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';

    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      sessionDirectory: '/before',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelectionsWithCredentialRevision(bootstrapRevision),
    });
    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      sessionDirectory: '/before',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelectionsWithCredentialRevision(acceptedRevision),
    });
    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      sessionDirectory: '/reattached',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelectionsWithCredentialRevision(bootstrapRevision),
    }, { source: 'bootstrap' });

    expect(registry.getByPid(123)?.activeBindings).toEqual([
      expect.objectContaining({ credentialRevision: acceptedRevision }),
    ]);
    expect(registry.getByPid(123)?.sessionDirectory).toBe('/reattached');
  });

  it('offers every target registration to current-truth consumers even when the target is unchanged', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onTargetRegistered = vi.fn();
    const unsubscribe = registry.subscribeTargetRegistrations(onTargetRegistered);
    const registration = {
      pid: 123,
      agentId: 'codex' as const,
      sessionId: 'session-1',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    };

    const first = registry.registerTarget(registration);
    const second = registry.registerTarget(registration);
    registry.registerRunTarget({ ...registration, runKey: 'run-1' });
    unsubscribe();
    registry.registerTarget(registration);

    expect(second.runtimeIdentityKey).toBe(first.runtimeIdentityKey);
    expect(second.revision).toBe(first.revision);
    expect(onTargetRegistered).toHaveBeenCalledTimes(3);
    expect(onTargetRegistered).toHaveBeenNthCalledWith(1, expect.objectContaining({ pid: 123 }));
    expect(onTargetRegistered).toHaveBeenNthCalledWith(2, expect.objectContaining({ pid: 123 }));
    expect(onTargetRegistered).toHaveBeenNthCalledWith(3, expect.objectContaining({ pid: 123 }));
  });

  it('shares transfer, session adoption, and unregister state across views', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onTargetRegistered = vi.fn();
    registry.subscribeTargetRegistrations(onTargetRegistered);

    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    registry.adoptSessionId({ pid: 123, sessionId: 'session-1' });
    registry.transferPid(123, 456);

    expect(registry.getByPid(123)).toBeNull();
    expect(registry.getByPid(456)?.sessionId).toBe('session-1');
    expect(registry.listQuotaTargets()).toHaveLength(1);
    expect(onTargetRegistered).toHaveBeenCalledTimes(3);
    expect(onTargetRegistered).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pid: 123,
      sessionId: 'session-1',
    }));
    expect(onTargetRegistered).toHaveBeenNthCalledWith(3, expect.objectContaining({
      pid: 456,
      sessionId: 'session-1',
    }));

    registry.unregisterPid(456);

    expect(registry.listRefreshTargets()).toEqual([]);
    expect(registry.listQuotaTargets()).toEqual([]);
  });

  it('replaces the old pid entry when the same session reattaches under a new pid', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      sessionId: 'sess-a',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    const reattached = registry.registerTarget({
      pid: 456,
      agentId: 'codex',
      sessionId: 'sess-a',
      materializationKey: 'mat-1',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    expect(reattached.pid).toBe(456);
    expect(registry.getByPid(123)).toBeNull();
    expect(registry.getByPid(456)?.sessionId).toBe('sess-a');
    expect(registry.getBySessionId('sess-a')?.pid).toBe(456);
    expect(registry.listTargets().map((target) => target.pid)).toEqual([456]);
    expect(registry.listRefreshTargets().map((target) => target.pid)).toEqual([456]);
    expect(registry.listQuotaTargets().map((target) => target.pid)).toEqual([456]);
  });

  it('registers execution-run targets in a run keyspace without clobbering the session target at the same pid', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    registry.registerTarget({
      pid: 123,
      agentId: 'claude',
      sessionId: 'sess-a',
      materializationKey: 'session-mat',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    registry.registerRunTarget({
      runKey: 'run_abc',
      pid: 123,
      agentId: 'codex',
      materializationKey: 'run_abc',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    // The session target at pid 123 is untouched.
    expect(registry.getByPid(123)?.materializationKey).toBe('session-mat');
    expect(registry.getBySessionId('sess-a')?.agentId).toBe('claude');

    // Both targets are visible to distribution (refresh + quota views).
    const refreshKeys = registry.listRefreshTargets().map((target) => target.materializationKey).sort();
    expect(refreshKeys).toEqual(['run_abc', 'session-mat']);
    expect(registry.listQuotaTargets()).toHaveLength(2);

    // Releasing the run removes ONLY the run target.
    registry.unregisterRunKey('run_abc');
    expect(registry.listRefreshTargets().map((target) => target.materializationKey)).toEqual(['session-mat']);
    expect(registry.getByPid(123)?.materializationKey).toBe('session-mat');
  });

  it('drops execution-run targets bound to a runner pid when that pid unregisters or transfers', () => {
    const registry = new ConnectedServiceRuntimeRegistry();

    registry.registerTarget({
      pid: 123,
      agentId: 'claude',
      sessionId: 'sess-a',
      materializationKey: 'session-mat',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });
    registry.registerRunTarget({
      runKey: 'run_abc',
      pid: 123,
      agentId: 'codex',
      materializationKey: 'run_abc',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });
    registry.registerRunTarget({
      runKey: 'run_other',
      pid: 999,
      agentId: 'codex',
      materializationKey: 'run_other',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    // Runner death: session unregister also drops that runner's run targets, not others.
    registry.unregisterPid(123);
    expect(registry.listRefreshTargets().map((target) => target.materializationKey)).toEqual(['run_other']);

    // Runner respawn: pid transfer drops the dead runner's run targets (resumed runs re-materialize).
    registry.registerTarget({
      pid: 999,
      agentId: 'claude',
      sessionId: 'sess-b',
      materializationKey: 'session-mat-b',
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });
    registry.transferPid(999, 1000);
    expect(registry.listRefreshTargets().map((target) => target.materializationKey)).toEqual(['session-mat-b']);
    expect(registry.getByPid(1000)?.sessionId).toBe('sess-b');
  });

});
