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
  it('records fresh provider accounts without inventing generation proof and preserves exact application ownership', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      const registry = new ConnectedServiceRuntimeRegistry();
      const input = { pid: 123, sessionId: 'observed', agentId: 'codex', connectedServicesBindingsRaw: connectedBindings,
        connectedServiceSelectionsEnvRaw: connectedSelections };
      registry.registerTarget(input);
      const scoped = registry.scopeToRequester(target => target.sessionId === 'observed');
      const observed = scoped.adoptProviderObservedGroupAccountForSession({ sessionId: 'observed',
        serviceId: 'acme.accounts/session-auth', groupId: 'codex-team', profileId: 'other-profile', observedAtMs: 50 });
      expect(observed?.activeBindings).toEqual([{ serviceId: 'acme.accounts/session-auth', groupId: 'codex-team',
        profileId: 'other-profile', groupGeneration: null, credentialRevision: null }]);
      expect(observed?.connectedServiceSelectionsEnv).toEqual({ [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: connectedSelections });
      registry.registerTarget({ ...input, connectedServicesBindingsRaw: { ...connectedBindings, bindingsByServiceId: {
        'acme.accounts/session-auth': { ...connectedBindings.bindingsByServiceId['acme.accounts/session-auth'], appliedProfileId: 'other-profile' },
      } } });
      expect(registry.getBySessionId('observed')).toBe(observed);
      expect(scoped.adoptProviderObservedGroupAccountForSession({ sessionId: 'observed',
        serviceId: 'acme.accounts/session-auth', groupId: 'codex-team', profileId: 'active-profile', observedAtMs: 49 })).toBeNull();
      clock.mockReturnValue(300);
      const applied = registry.adoptExactGroupApplicationForSession({ sessionId: 'observed', serviceId: 'acme.accounts/session-auth',
        groupId: 'codex-team', profileId: 'active-profile', generation: 5, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' });
      expect(applied?.activeBindings[0]).toMatchObject({ profileId: 'active-profile', groupGeneration: 5, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' });
      expect(scoped.adoptProviderObservedGroupAccountForSession({ sessionId: 'observed',
        serviceId: 'acme.accounts/session-auth', groupId: 'codex-team', profileId: 'other-profile', observedAtMs: 250 })).toBeNull();
      expect(registry.getBySessionId('observed')).toBe(applied);
      const foreign = registry.scopeToRequester(() => false);
      expect(foreign.adoptProviderObservedGroupAccountForSession({ sessionId: 'observed', serviceId: 'acme.accounts/session-auth',
        groupId: 'codex-team', profileId: 'other-profile', observedAtMs: 400 })).toBeNull();
      const fresh = scoped.adoptProviderObservedGroupAccountForSession({ sessionId: 'observed', serviceId: 'acme.accounts/session-auth',
        groupId: 'codex-team', profileId: 'other-profile', observedAtMs: 400 });
      expect(fresh?.activeBindings[0]).toMatchObject({ profileId: 'other-profile', groupGeneration: null, credentialRevision: null });
    } finally { clock.mockRestore(); }
  });

  it('keeps only an owned group application recipient across binding withdrawal and success registration', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const input = { pid: 123, sessionId: 'applying', agentId: 'codex',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget(input);
    const recipient = registry.getByPid(input.pid)!;
    const withdrawn = registry.withdrawSessionGroupApplicationBindings(recipient)!;
    expect(registry.readAppliedSessionBindings({ runnerPid: 123, sessionId: 'applying', agentId: 'codex' })).toEqual({ status: 'unavailable' });
    expect(registry.resolveExactSessionGroupApplicationTarget(recipient)).toBe(withdrawn);
    registry.registerTarget(input, { groupApplicationTarget: withdrawn });
    const settled = registry.getByPid(input.pid)!;
    expect(registry.resolveExactSessionGroupApplicationTarget(recipient)).toBe(settled);
    registry.updateTarget({ pid: input.pid, connectedServicesBindingsRaw: null });
    const unbound = registry.getByPid(input.pid);
    expect(registry.resolveExactSessionGroupApplicationTarget(recipient)).toBeNull();
    expect(() => registry.registerTarget(input, { groupApplicationTarget: settled })).toThrow('credential_revision_superseded');
    expect(registry.getByPid(input.pid)).toBe(unbound);
  });
  it('invalidates an in-flight application when an explicit unbind repeats its withdrawn binding', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const input = { pid: 123, sessionId: 'applying', agentId: 'codex', connectedServicesBindingsRaw: connectedBindings };
    registry.registerTarget(input);
    const recipient = registry.getByPid(123)!;
    const applying = registry.withdrawSessionGroupApplicationBindings(recipient)!;
    registry.updateTarget({ pid: 123, connectedServicesBindingsRaw: null });
    expect(registry.resolveExactSessionGroupApplicationTarget(recipient)).toBeNull();
    expect(() => registry.registerTarget(input, { groupApplicationTarget: applying })).toThrow('credential_revision_superseded');
    expect(registry.readAppliedSessionBindings({ runnerPid: 123, sessionId: 'applying', agentId: 'codex' })).toEqual({ status: 'unavailable' });
  });
  it('retires selected Agent launch bytes when the applied credential identity changes, without borrowing Session material for a Run', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const material = { runtimeHome: '/var/lib/happier-agent/session', environment: { SELECTED: 'old' }, selectedMaterials: [] };
    const input = { pid: 123, sessionId: 'isolated', agentId: 'codex', materializationKey: 'isolated',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections, agentLaunchMaterials: material };
    registry.registerTarget(input);
    const refreshedMaterial = { ...material };
    registry.updateTarget({ pid: input.pid, agentLaunchMaterials: refreshedMaterial });
    expect(registry.getBySessionId(input.sessionId)?.agentLaunchMaterials).toBe(refreshedMaterial);
    registry.updateTarget({ pid: input.pid, sessionDirectory: '/checkout' });
    expect(registry.getBySessionId(input.sessionId)?.agentLaunchMaterials).toBe(refreshedMaterial);
    registry.registerRunTarget({ ...input, agentLaunchMaterials: undefined, runKey: 'isolated-run' });
    expect(registry.getRunTargetByRunKey('isolated-run')?.agentLaunchMaterials).toBeUndefined();
    registry.updateTarget({ pid: input.pid, connectedServiceSelectionsEnvRaw: connectedSelectionsWithCredentialRevision('csr_bbbbbbbbbbbbbbbbbbbbbb') });
    expect(registry.getBySessionId(input.sessionId)?.agentLaunchMaterials).toBeUndefined();
  });
  it('publishes refreshed Agent material only to the exact current Session or Run lease', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const material = { runtimeHome: '/var/lib/happier-agent/session', environment: { SELECTED: 'old' }, selectedMaterials: [] };
    const input = { pid: 123, sessionId: 'isolated', agentId: 'codex', materializationKey: 'isolated', agentLaunchMaterials: material,
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget(input);
    registry.registerRunTarget({ ...input, materializationKey: 'isolated-run', runKey: 'isolated-run' });
    // The real refresh owner consumes these current registry projections, not
    // the backing target object returned by the Session/Run lookup API.
    const session = registry.listRefreshTargets().find(target => registry.isSessionTarget(target))!;
    const run = registry.listRefreshTargets().find(target => registry.isRunTarget(target))!;
    const refreshed = { ...material, environment: { SELECTED: 'refreshed' } };
    expect(registry.replaceAgentLaunchMaterials(run, refreshed)?.agentLaunchMaterials).toBe(refreshed);
    expect(registry.getBySessionId(input.sessionId)?.agentLaunchMaterials).toBe(material);
    expect(registry.replaceAgentLaunchMaterials(run, material)).toBeNull();
    expect(registry.replaceAgentLaunchMaterials(session, refreshed)?.agentLaunchMaterials).toBe(refreshed);
  });
  it('publishes only changed Session and Run targets to background inventory subscribers', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const publish = vi.fn();
    const unsubscribe = registry.subscribeTargetRegistrations(publish);
    const input = { pid: 123, sessionId: 'settled', agentId: 'codex', materializationKey: 'settled',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections };
    try {
      registry.registerTarget(input);
      registry.registerRunTarget({ ...input, runKey: 'settled-run' });
      publish.mockClear();
      const session = registry.getByPid(input.pid);
      const run = registry.getRunTargetByRunKey('settled-run');
      for (let arrival = 0; arrival < 60; arrival++) {
        registry.registerTarget({ ...input });
        registry.updateTarget({ pid: input.pid, sessionId: input.sessionId });
        registry.registerRunTarget({ ...input, runKey: 'settled-run' });
      }
      expect(publish).not.toHaveBeenCalled();
      expect(registry.getByPid(input.pid)).toBe(session);
      expect(registry.getRunTargetByRunKey('settled-run')).toBe(run);
      const connectedServiceSelectionsEnvRaw = connectedSelectionsWithCredentialRevision('csr_bbbbbbbbbbbbbbbbbbbbbb');
      registry.updateTarget({ pid: input.pid, connectedServiceSelectionsEnvRaw });
      expect(publish).toHaveBeenCalledOnce();
      registry.registerRunTarget({ ...input, runKey: 'settled-run', connectedServiceSelectionsEnvRaw });
      expect(publish).toHaveBeenCalledTimes(2);
      unsubscribe();
      registry.updateTarget({ pid: input.pid, sessionId: 'later' });
      expect(publish).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it('reads a wrapper target from its witnessed runner identity and refuses a replaced runner', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ pid: 123, sessionId: 'parent', agentId: 'codex',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections });
    const tracked = { pid: 123, sessionRunnerPid: 124, happySessionId: 'parent' };
    const request = { runnerPid: 124, sessionId: 'parent', agentId: 'codex' };
    expect(registry.readAppliedSessionBindings(request, tracked)).toMatchObject({ status: 'applied',
      connectedServices: { bindingsByServiceId: { 'acme.accounts/session-auth': { source: 'connected', groupId: 'codex-team' } } } });
    expect(registry.readAppliedSessionBindings(request, { ...tracked, sessionRunnerPid: 125 }))
      .toEqual({ status: 'unavailable' });
    expect(registry.readAppliedSessionBindings(request, { ...tracked, happySessionId: 'other' }))
      .toEqual({ status: 'unavailable' });
  });
  it('reads only an exact applied parent pool identity, without its member or pending bootstrap selection', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ pid: 123, sessionId: 'parent', agentId: 'codex',
      connectedServicesBindingsRaw: { ...connectedBindings, retiredBindingsField: true,
        bindingsByServiceId: Object.fromEntries(Object.entries(connectedBindings.bindingsByServiceId)
          .map(([key, binding]) => [key, { ...binding, retiredBindingField: true }])) },
      connectedServiceSelectionsEnvRaw: connectedSelections });
    registry.registerTarget({ pid: 123, sessionId: 'parent', agentId: 'codex',
      connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
        'acme.accounts/session-auth': { source: 'connected', selection: 'profile', profileId: 'pending' },
      } } }, { source: 'bootstrap' });
    expect(registry.readAppliedSessionBindings({ runnerPid: 123, sessionId: 'parent', agentId: 'codex' }))
      .toEqual({ status: 'applied', connectedServices: { v: 2, bindingsByServiceId: {
        'acme.accounts/session-auth': { source: 'connected', selection: 'group', groupId: 'codex-team' },
      } } });
    expect(registry.readAppliedSessionBindings({ runnerPid: 124, sessionId: 'parent', agentId: 'codex' }))
      .toEqual({ status: 'unavailable' });
    expect(registry.readAppliedSessionBindings({ runnerPid: 123, sessionId: 'other', agentId: 'codex' }))
      .toEqual({ status: 'unavailable' });
    expect(registry.readAppliedSessionBindings({ runnerPid: 123, sessionId: 'parent', agentId: 'claude' }))
      .toEqual({ status: 'unavailable' });
  });
  it('keeps an admitted cold requester run out of the custodian view when its tracked attribution is unavailable', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const alice = registry.scopeToRequester(() => true, { serverId: 'home-a', accountId: 'alice' });
    const bob = registry.scopeToRequester(target => target.sessionId === 'cold-bob', { serverId: 'home-a', accountId: 'bob' });
    // The actual admitted producer supplies this retained, nonsecret ownership fact;
    // absence of a tracked marker must not turn it into custodian Account authority.
    const registration = { runKey: 'bob-run', pid: 202, sessionId: 'cold-bob', agentId: 'codex', materializationKey: 'bob-run',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections,
      requesterWorkAttributionV1: { serverId: 'home-a', accountId: 'bob', machineId: 'machine', installationId: 'installation' } };
    registry.registerRunTarget(registration);
    expect(bob.getRunTargetByRunKey('bob-run')?.sessionId).toBe('cold-bob');
    expect(alice.getRunTargetByRunKey('bob-run')).toBeNull();
    expect(alice.listRefreshTargets()).toEqual([]);
    expect(alice.listQuotaTargets()).toEqual([]);
    expect(bob.listRefreshTargets().map(target => target.materializationKey)).toEqual(['bob-run']);
    registry.registerRunTarget({ ...registration, runKey: 'other-home-run', materializationKey: 'other-home-run',
      requesterWorkAttributionV1: { ...registration.requesterWorkAttributionV1, serverId: 'home-b' } });
    expect(bob.getRunTargetByRunKey('other-home-run')).toBeNull();
    expect(registry.listTargets()).toHaveLength(2);
  });
  it('scopes refresh, quota, registration fanout and exact reads by trusted requester Home and Account over the same backing targets', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const attribution = new Map([
      ['alice', { serverId: 'home-a', accountId: 'alice' }],
      ['bob', { serverId: 'home-a', accountId: 'bob' }],
      ['bob-other-home', { serverId: 'home-b', accountId: 'bob' }],
    ]);
    const view = registry.scopeToRequester((target) => {
      const owner = target.sessionId ? attribution.get(target.sessionId) : null;
      return owner?.serverId === 'home-a' && owner.accountId === 'bob';
    });
    const delivered: string[] = [];
    const unsubscribe = view.subscribeTargetRegistrations((target) => { delivered.push(target.materializationKey ?? ''); });
    const bindings = { agentId: 'codex' as const, connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget({ ...bindings, pid: 101, sessionId: 'alice', materializationKey: 'alice-material' });
    view.registerTarget({ ...bindings, pid: 202, sessionId: 'bob', materializationKey: 'bob-material' });
    registry.registerTarget({ ...bindings, pid: 303, sessionId: 'bob-other-home', materializationKey: 'other-home-material' });
    registry.registerTarget({ ...bindings, pid: 404, sessionId: 'unknown', materializationKey: 'unattributed-material' });
    view.registerRunTarget({ ...bindings, pid: 202, runKey: 'bob-run', sessionId: 'bob', materializationKey: 'bob-run-material' });
    registry.registerRunTarget({ ...bindings, pid: 101, runKey: 'alice-run', sessionId: 'alice', materializationKey: 'alice-run-material' });
    unsubscribe();
    expect(view.listTargets().map((target) => target.materializationKey)).toEqual(['bob-material', 'bob-run-material']);
    expect(view.listRefreshTargets().map((target) => target.materializationKey)).toEqual(['bob-material', 'bob-run-material']);
    expect(view.listQuotaTargets().map((target) => target.materializationKey)).toEqual(['bob-material', 'bob-run-material']);
    expect(delivered).toEqual(['bob-material', 'bob-run-material']);
    expect(view.getByPid(101)).toBeNull();
    expect(view.getBySessionId('bob-other-home')).toBeNull();
    expect(view.getRunTargetByRunKey('alice-run')).toBeNull();
    expect(view.isSessionTarget(registry.getByPid(101)!)).toBe(false);
    expect(view.isRunTarget(registry.getRunTargetByRunKey('alice-run')!)).toBe(false);
    expect(registry.listTargets()).toHaveLength(6);
    expect(view.getByPid(202)).toBe(registry.getByPid(202));
    view.transferPid(202, 222);
    expect(registry.getBySessionId('bob')?.pid).toBe(222);
    expect(registry.getRunTargetByRunKey('bob-run')).toBeNull();
    expect(view.getByPid(222)).toBe(registry.getByPid(222));
    attribution.delete('bob');
    expect(view.listRefreshTargets()).toEqual([]);
    expect(registry.getByPid(222)).not.toBeNull();
  });

  it('prevents scoped mutation from replacing or removing another requester targets and runner children', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const view = registry.scopeToRequester((target) => target.sessionId === 'bob');
    const connected = { connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget({ ...connected, pid: 101, sessionId: 'alice' });
    registry.registerRunTarget({ ...connected, pid: 101, sessionId: 'alice', runKey: 'alice-run' });
    view.registerTarget({ pid: 202, sessionId: 'bob' });
    expect(view.updateTarget({ pid: 101, sessionDirectory: '/foreign' })).toBeNull();
    expect(view.unregisterPid(101)).toBeNull();
    expect(view.unregisterRunKey('alice-run')).toBeNull();
    expect(view.transferPid(101, 111)).toBeNull();
    expect(view.transferPid(202, 101)).toBeNull();
    const credentialUpdate = { serviceId: 'acme.accounts/session-auth' as const,
      expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' as const,
      credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' as const };
    expect(view.adoptExactCredentialRevisionForTarget({ ...credentialUpdate, target: registry.getByPid(101)! })).toBeNull();
    expect(view.adoptExactCredentialRevisionForRun({ ...credentialUpdate, runKey: 'alice-run',
      target: registry.getRunTargetByRunKey('alice-run')! })).toBeNull();
    expect(() => view.registerRunTarget({ pid: 202, sessionId: 'bob', runKey: 'alice-run' })).toThrow('connected_service_runtime_requester_scope_mismatch');
    expect(() => view.updateTarget({ pid: 202, sessionId: 'alice' })).toThrow('connected_service_runtime_requester_scope_mismatch');
    expect(registry.getByPid(101)?.sessionId).toBe('alice');
    expect(registry.getRunTargetByRunKey('alice-run')?.sessionId).toBe('alice');
    expect(registry.getByPid(202)?.sessionId).toBe('bob');
    expect(registry.getByPid(101)?.activeBindings[0]?.credentialRevision).toBe('csr_aaaaaaaaaaaaaaaaaaaaaa');
    // A Session target is keyed by its Session: bob landing on alice's process never replaces hers.
    view.registerTarget({ pid: 101, sessionId: 'bob' });
    expect(registry.getBySessionId('alice')).toMatchObject({ pid: 101, sessionId: 'alice' });
    expect(registry.getBySessionId('bob')?.pid).toBe(101);
  });

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

  it('identifies current projected Run targets without borrowing their runner Session identity', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const shared = { pid: 123, agentId: 'codex', sessionId: 'parent-session',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget({ ...shared, materializationKey: 'session-materialization' });
    registry.registerRunTarget({ ...shared, runKey: 'run-1', materializationKey: 'run-1' });
    const firstRun = registry.listRefreshTargets().find((target) => target.materializationKey === 'run-1')!;
    const session = registry.listRefreshTargets().find((target) => target.materializationKey === 'session-materialization')!;
    expect(registry.isRunTarget(firstRun)).toBe(true);
    expect(registry.isRunTarget(session)).toBe(false);
    expect(registry.isSessionTarget(session)).toBe(true);
    expect(registry.isSessionTarget(firstRun)).toBe(false);
    registry.registerRunTarget({ ...shared, runKey: 'run-1', materializationKey: 'run-1', sessionDirectory: '/replacement' });
    expect(registry.isRunTarget(firstRun)).toBe(false);
    expect(registry.isSessionTarget(firstRun)).toBe(false);
    const currentRun = registry.listRefreshTargets().find((target) => target.materializationKey === 'run-1')!;
    expect(registry.isRunTarget(currentRun)).toBe(true);
    registry.unregisterRunKey('run-1');
    expect(registry.isRunTarget(currentRun)).toBe(false);
    expect(registry.isSessionTarget(currentRun)).toBe(false);
    expect(registry.isRunTarget(session)).toBe(false);
    expect(registry.isSessionTarget(session)).toBe(true);
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

  it('adopts a verified exact application for a metadata-only declared pool member', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ pid: 123, agentId: 'codex', sessionId: 'metadata-only',
      connectedServicesBindingsRaw: connectedBindings });
    const settled = registry.adoptExactGroupApplicationForSession({
      sessionId: 'metadata-only', serviceId: 'acme.accounts/session-auth', groupId: 'codex-team',
      profileId: 'replacement-profile', generation: 5, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(settled?.activeBindings).toEqual([expect.objectContaining({ profileId: 'replacement-profile',
      groupId: 'codex-team', groupGeneration: 5, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' })]);
    expect(registry.adoptExactGroupApplicationForSession({
      sessionId: 'metadata-only', serviceId: 'acme.accounts/session-auth', groupId: 'foreign-pool',
      profileId: 'foreign', generation: 6, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
    })).toBeNull();
  });

  it('resolves only the same Session lineage after its own application, across requester views', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const scoped = registry.scopeToRequester(target => target.sessionId === 'lineage');
    registry.registerTarget({ pid: 123, agentId: 'codex', sessionId: 'lineage',
      connectedServicesBindingsRaw: connectedBindings, connectedServiceSelectionsEnvRaw: connectedSelections });
    const original = registry.getBySessionId('lineage')!;
    const adopted = scoped.adoptExactGroupApplicationForSession({ sessionId: 'lineage', serviceId: 'acme.accounts/session-auth',
      groupId: 'codex-team', profileId: 'replacement', generation: 5, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' });
    expect(registry.resolveExactSessionGroupApplicationTarget(original)).toBe(adopted);
    expect(registry.isSessionTarget(original)).toBe(false); // Refresh still needs its exact current snapshot.
    registry.unregisterPid(123);
    registry.registerTarget({ ...adopted!, pid: 123 });
    expect(registry.resolveExactSessionGroupApplicationTarget(original)).toBeNull();
    const replacement = registry.getBySessionId('lineage')!;
    registry.updateTarget({ pid: 123, connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {} },
      connectedServiceSelectionsEnvRaw: '[]' });
    expect(registry.resolveExactSessionGroupApplicationTarget(replacement)).toBeNull();
    registry.registerRunTarget({ ...original, runKey: 'run' });
    expect(registry.resolveExactSessionGroupApplicationTarget(registry.getRunTargetByRunKey('run')!)).toBeNull();
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

  it('shares transfer, session adoption, and unregister state across views', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onTargetRegistered = vi.fn();
    registry.subscribeTargetRegistrations(onTargetRegistered);
    const material = { runtimeHome: '/var/lib/happier-agent/session', environment: {}, selectedMaterials: [] };

    registry.registerTarget({
      pid: 123,
      agentId: 'codex',
      agentLaunchMaterials: material,
      connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections,
    });

    registry.adoptSessionId({ pid: 123, sessionId: 'session-1' });
    expect(registry.getBySessionId('session-1')?.agentLaunchMaterials).toBe(material);
    registry.transferPid(123, 456);
    expect(registry.getBySessionId('session-1')?.agentLaunchMaterials).toBe(material);

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

  it('keeps a separate target for each Session hosted by one process and ends only the ended Session', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const hostPid = 777;
    const connected = { agentId: 'codex', connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget({ ...connected, pid: hostPid, sessionId: 'hosted-a', materializationKey: 'mat-a' });
    registry.registerTarget({ ...connected, pid: hostPid, sessionId: 'hosted-b', materializationKey: 'mat-b' });

    expect(registry.listTargets().map((target) => target.sessionId).sort()).toEqual(['hosted-a', 'hosted-b']);
    expect(registry.getBySessionId('hosted-a')).toMatchObject({ pid: hostPid, materializationKey: 'mat-a' });
    expect(registry.getBySessionId('hosted-b')).toMatchObject({ pid: hostPid, materializationKey: 'mat-b' });
    // The host pid alone never picks one of its Sessions.
    expect(registry.getByPid(hostPid)).toBeNull();
    expect(registry.readAppliedSessionBindings({ runnerPid: hostPid, sessionId: 'hosted-a', agentId: 'codex' }).status)
      .toBe('applied');
    // Adopting a Session id at the host never re-keys another Session's target.
    expect(registry.adoptSessionId({ pid: hostPid, sessionId: 'hosted-c' })).toBeNull();
    // A fresh hosted Session's sessionless bootstrap is adopted into its own Session target.
    registry.registerTarget({ ...connected, pid: hostPid, materializationKey: 'mat-c' });
    expect(registry.adoptSessionId({ pid: hostPid, sessionId: 'hosted-c' })?.materializationKey).toBe('mat-c');
    expect(registry.listTargets().map((target) => target.sessionId).sort()).toEqual(['hosted-a', 'hosted-b', 'hosted-c']);

    // One hosted Session ends while the host keeps running.
    expect(registry.unregisterTarget(registry.getSessionTarget(hostPid, 'hosted-a')!)?.sessionId).toBe('hosted-a');
    expect(registry.getBySessionId('hosted-a')).toBeNull();
    expect(registry.getSessionTarget(hostPid, 'hosted-b')?.materializationKey).toBe('mat-b');
    expect(registry.listRefreshTargets().map((target) => target.materializationKey).sort()).toEqual(['mat-b', 'mat-c']);

    // The host process exits: every Session target it hosted ends.
    registry.unregisterPid(hostPid);
    expect(registry.listTargets()).toEqual([]);
  });

  it('keeps each concurrent fresh hosted spawn bootstrap under its own tracking key until it adopts its own Session', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const hostPid = 778;
    const connected = { agentId: 'codex', connectedServicesBindingsRaw: connectedBindings,
      connectedServiceSelectionsEnvRaw: connectedSelections };
    registry.registerTarget({ ...connected, pid: hostPid, spawnTrackingKey: 'session-spawn-a', materializationKey: 'mat-a' });
    registry.registerTarget({ ...connected, pid: hostPid, spawnTrackingKey: 'session-spawn-b', materializationKey: 'mat-b' });
    registry.registerTarget({ ...connected, pid: hostPid, spawnTrackingKey: 'session-spawn-c', materializationKey: 'mat-c' });
    expect(registry.listTargets().map((target) => target.materializationKey).sort()).toEqual(['mat-a', 'mat-b', 'mat-c']);

    // Readiness order differs from spawn order: each Session adopts only its own bootstrap.
    expect(registry.adoptSessionId({ pid: hostPid, sessionId: 'hosted-b', spawnTrackingKey: 'session-spawn-b' })?.materializationKey)
      .toBe('mat-b');
    expect(registry.adoptSessionId({ pid: hostPid, sessionId: 'hosted-a', spawnTrackingKey: 'session-spawn-a' })?.materializationKey)
      .toBe('mat-a');
    expect(registry.getBySessionId('hosted-a')?.materializationKey).toBe('mat-a');
    expect(registry.getBySessionId('hosted-b')?.materializationKey).toBe('mat-b');

    // A Session that registers its own target (hot apply) before adoption supersedes only its own bootstrap.
    registry.registerTarget({ ...connected, pid: hostPid, spawnTrackingKey: 'session-spawn-d', materializationKey: 'mat-d' });
    registry.registerTarget({ ...connected, pid: hostPid, sessionId: 'hosted-d', spawnTrackingKey: 'session-spawn-d',
      materializationKey: 'mat-d-applied' });
    expect(registry.getSessionTarget(hostPid, undefined, 'session-spawn-d')).toBeNull();
    expect(registry.getBySessionId('hosted-d')?.materializationKey).toBe('mat-d-applied');
    expect(registry.adoptSessionId({ pid: hostPid, sessionId: 'hosted-d', spawnTrackingKey: 'session-spawn-d' })).toBeNull();
    registry.unregisterTarget(registry.getBySessionId('hosted-d')!);

    // Spawn c's Session exits before it is adopted: only its own bootstrap ends.
    const pendingC = registry.getSessionTarget(hostPid, undefined, 'session-spawn-c');
    expect(pendingC?.materializationKey).toBe('mat-c');
    registry.unregisterTarget(pendingC!);
    expect(registry.listTargets().map((target) => target.sessionId).sort()).toEqual(['hosted-a', 'hosted-b']);
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
