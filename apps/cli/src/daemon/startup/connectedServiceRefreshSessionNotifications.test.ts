import { describe, expect, it } from 'vitest';

import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { resolveConnectedServiceRefreshSessionIds } from './connectedServiceRefreshSessionNotifications';
import { legacyPidSessionTrackingKey, type TrackedSessionMap } from '../sessions/sessionTrackingKey';

function trackedParentSession(): TrackedSessionMap {
  const trackingKey = legacyPidSessionTrackingKey(101);
  return new Map([[trackingKey, { trackingKey, pid: 101, happySessionId: 'parent-session', startedBy: 'daemon' }]]);
}

function registerTargets(registry: ConnectedServiceRuntimeRegistry) {
  const input = {
    pid: 101,
    agentId: 'codex',
    sessionId: 'parent-session',
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        'acme.accounts/session-auth': { source: 'connected', selection: 'profile', profileId: 'member' },
      },
    },
  };
  registry.registerTarget({ ...input, materializationKey: 'parent-home' });
  registry.registerRunTarget({ ...input, runKey: 'finite-run', materializationKey: 'finite-run' });
  return registry.listRefreshTargets();
}

describe('connected service refresh Session notifications', () => {
  it('does not send a detached Run refresh to its real parent Session', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const targets = registerTargets(registry);
    expect(resolveConnectedServiceRefreshSessionIds({
      affectedTargets: targets.filter((target) => target.materializationKey === 'finite-run'),
      registry,
      trackedSessions: trackedParentSession(),
    })).toEqual([]);
  });

  it('retains genuine same-runner Session refresh notifications', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    expect(resolveConnectedServiceRefreshSessionIds({
      affectedTargets: registerTargets(registry),
      registry,
      trackedSessions: trackedParentSession(),
    })).toEqual(['parent-session']);
  });

  it('does not infer a Session from a released Run projection', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const targets = registerTargets(registry).filter((target) => target.materializationKey === 'finite-run');
    registry.unregisterRunKey('finite-run');
    expect(resolveConnectedServiceRefreshSessionIds({
      affectedTargets: targets,
      registry,
      trackedSessions: trackedParentSession(),
    })).toEqual([]);
  });
});
