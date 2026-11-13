import { describe, expect, it } from 'vitest';

import { ConnectedServiceRuntimeRegistry } from '../../runtimeRegistry/registry';
import { applyConnectedServiceProjectionCredentialUpdate } from '../../refresh/applyConnectedServiceProjectionCredentialUpdate';
import { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';
import { parseConnectedServiceProjectionSnapshot } from './connectedServiceProjectionSnapshot';
import {
  reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from './reconcileConnectedServiceAuthGroupGenerations';

const legacyService = 'happier.agent.claude/anthropic';
const nativeService = 'happier.agent.muse/muse-account';

function emptyLegacyProjection() {
  return parseConnectedServiceProjectionSnapshot({
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
  });
}

describe('legacy connected-service projection admission', () => {
  it('preserves a V4-only session omitted from V2 while stopping a deleted legacy credential', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    for (const [pid, serviceId] of [[42, nativeService], [43, legacyService]] as const) {
      registry.registerTarget({
        pid, agentId: 'pi', sessionId: `session-${pid}`, materializationKey: `materialization-${pid}`,
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
          [serviceId]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } },
      });
    }
    const snapshot = emptyLegacyProjection();
    const stopped: string[] = [];
    const outcome = await reconcileConnectedServiceDirectCredentialRevisions({
      credentialRevisions: snapshot.credentialRevisions,
      projectsService: snapshot.projectsService,
      resolveCredentialPresence: snapshot.resolveCredentialPresence,
      listRuntimeTargets: () => registry.listTargets().map((target) => ({
        ...target, activeBindings: target.activeBindings.map((binding) => ({
          ...binding, generation: binding.groupGeneration,
        })),
      })),
      executionAuthority: 'passive_projection',
      applyLiveCredentialRevision: async (input) => applyConnectedServiceProjectionCredentialUpdate({
        input, listRuntimeTargets: () => registry.listRefreshTargets(),
        // Process/session termination is the system boundary; all projection and deletion logic is real.
        stopSession: async (sessionId) => {
          stopped.push(sessionId);
          const target = registry.getBySessionId(sessionId);
          if (target) registry.unregisterPid(target.pid);
          return { status: 'stopped' };
        },
        getRefreshCoordinator: () => null,
      }),
    });
    expect(stopped).toEqual(['session-43']);
    expect(registry.getBySessionId('session-42')).not.toBeNull();
    expect(outcome.appliedBindingCount).toBe(1);
  });

  it.each(['declared', 'materialized'] as const)('preserves %s V4-only pools omitted from V2 while enforcing a deleted legacy pool', async (source) => {
    const snapshot = emptyLegacyProjection();
    const unavailable: string[] = [];
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration: async () => { throw new Error('No generation was projected'); },
      clearAdoptedGeneration: async () => {},
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'pi' }),
      verifySharedGenerationApplication: async () => null,
      // This callback effects session availability; projection and consumer logic remain real.
      enforceGroupUnavailable: async ({ sessionId }) => { unavailable.push(sessionId); },
    });
    for (const serviceId of [nativeService, legacyService]) {
      await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
        target: {
          sessionId: serviceId,
          activeBindings: source === 'materialized'
            ? [{ serviceId, groupId: 'team', profileId: 'work', generation: 1 }]
            : [],
          connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
            ...(source === 'declared' ? {
              [serviceId]: { source: 'connected', selection: 'group', groupId: 'team', profileId: 'work' },
            } : {}),
          } },
        },
        consumer, projectsService: snapshot.projectsService,
        listCurrentGroups: async () => snapshot.groups,
        resolveCredentialRevision: snapshot.resolveCredentialRevision,
        resolveCredentialPresence: snapshot.resolveCredentialPresence,
        executionAuthority: 'passive_projection',
      });
    }
    expect(unavailable).toEqual([legacyService]);
  });

  it('still settles an explicit V4-only credential deletion through qualified reconciliation', async () => {
    let present = true;
    await reconcileConnectedServiceDirectCredentialRevisions({
      credentialRevisions: [],
      resolveCredentialPresence: () => ({ status: 'absent' }),
      listRuntimeTargets: () => [{
        sessionId: 'native-session', activeBindings: [],
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
          [nativeService]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } },
      }],
      executionAuthority: 'passive_projection',
      applyLiveCredentialRevision: async (input) => applyConnectedServiceProjectionCredentialUpdate({
        input,
        listRuntimeTargets: () => present ? [{
          pid: 42, agentId: 'pi', sessionId: 'native-session', materializationKey: 'materialization-42',
          bindings: [{ serviceId: nativeService, profileId: 'work' }],
        }] : [],
        stopSession: async () => { present = false; return { status: 'stopped' }; },
        getRefreshCoordinator: () => null,
      }),
    });
    expect(present).toBe(false);
  });
});
