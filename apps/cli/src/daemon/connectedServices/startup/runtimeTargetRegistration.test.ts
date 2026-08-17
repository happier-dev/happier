import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { parseConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import { reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget } from '../accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { registerConnectedServiceRuntimeTargetForDaemon } from './runtimeTargetRegistration';
import { registerConnectedServiceTrackedSessionTargetsForDaemon } from './runtimeTargetRegistration';
import * as runtimeTargetRegistrationModule from './runtimeTargetRegistration';

/**
 * RR-8: the `successful_spawn` positive-evidence emit is wired through this registration seam via
 * `onRegisteredTarget`. It must fire (with the freshly registered target) exactly when a
 * connected-service target is registered, and never for spawns without connected-service data.
 */
describe('registerConnectedServiceRuntimeTargetForDaemon onRegisteredTarget', () => {
  const connectedBindings = {
    v: 1 as const,
    bindingsByServiceId: { 'claude-subscription': { source: 'connected' as const, profileId: 'work' } },
  };

  it('invokes onRegisteredTarget with the registered target for a connected-service spawn', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();

    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4321,
      agentId: 'claude',
      sessionId: 'sess-spawn-evidence',
      connectedServicesBindingsRaw: connectedBindings,
      materializationKey: 'mk-spawn-evidence',
      onRegisteredTarget,
    });

    expect(onRegisteredTarget).toHaveBeenCalledTimes(1);
    expect(onRegisteredTarget).toHaveBeenCalledWith(expect.objectContaining({ pid: 4321, agentId: 'claude' }));
  });

  it('does not replay registration side effects for an unchanged target revision', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();
    const registration = {
      runtimeRegistry: registry,
      pid: 4321,
      agentId: 'claude' as const,
      sessionId: 'sess-spawn-evidence',
      connectedServicesBindingsRaw: connectedBindings,
      materializationKey: 'mk-spawn-evidence',
      onRegisteredTarget,
    };

    registerConnectedServiceRuntimeTargetForDaemon(registration);
    registerConnectedServiceRuntimeTargetForDaemon(registration);

    expect(onRegisteredTarget).toHaveBeenCalledTimes(1);
  });

  it('offers every registration to current-truth reconciliation even when registry metadata is unchanged', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRuntimeTargetRegistration = vi.fn();
    registry.onTargetRegistration(onRuntimeTargetRegistration);
    const registration = {
      runtimeRegistry: registry,
      pid: 4321,
      agentId: 'claude' as const,
      sessionId: 'sess-current-truth',
      connectedServicesBindingsRaw: connectedBindings,
      materializationKey: 'mk-current-truth',
    };

    registerConnectedServiceRuntimeTargetForDaemon(registration);
    registerConnectedServiceRuntimeTargetForDaemon(registration);

    expect(onRuntimeTargetRegistration).toHaveBeenCalledTimes(2);
  });

  it('replays registration side effects when late session adoption changes the target revision', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();

    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4321,
      agentId: 'claude',
      connectedServicesBindingsRaw: connectedBindings,
      materializationKey: 'mk-spawn-evidence',
      onRegisteredTarget,
    });
    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4321,
      agentId: 'claude',
      sessionId: 'sess-adopted-late',
      connectedServicesBindingsRaw: connectedBindings,
      materializationKey: 'mk-spawn-evidence',
      onRegisteredTarget,
    });

    expect(onRegisteredTarget).toHaveBeenCalledTimes(2);
    expect(onRegisteredTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'sess-adopted-late',
      revision: 2,
    }));
  });

  it('does not invoke onRegisteredTarget when there is no connected-service registration data', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();

    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4322,
      agentId: 'claude',
      sessionId: 'sess-no-cs',
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
      onRegisteredTarget,
    });

    expect(onRegisteredTarget).not.toHaveBeenCalled();
  });

  it('does not invoke onRegisteredTarget without a registry', () => {
    const onRegisteredTarget = vi.fn();
    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: null,
      pid: 4323,
      connectedServicesBindingsRaw: connectedBindings,
      onRegisteredTarget,
    });
    expect(onRegisteredTarget).not.toHaveBeenCalled();
  });

  it('propagates late tracked-session registration to the durable generation replay seam', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const onRegisteredTarget = vi.fn();

    registerConnectedServiceTrackedSessionTargetsForDaemon({
      runtimeRegistry: registry,
      tracked: {
        pid: 4324,
        startedBy: 'daemon',
        happySessionId: 'late-session',
        spawnOptions: {
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
              },
            },
          },
        },
      } as Parameters<typeof registerConnectedServiceTrackedSessionTargetsForDaemon>[0]['tracked'],
      onRegisteredTarget,
    });

    expect(onRegisteredTarget).toHaveBeenCalledWith(expect.objectContaining({
      pid: 4324,
      sessionId: 'late-session',
    }));
  });

  it('indexes a terminal-started broker runtime from its durable session metadata', () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const brokerSelectionIdentity = 'opencode|connected|broker:1|openai-codex:work:acct-1|group:team';

    registerConnectedServiceTrackedSessionTargetsForDaemon({
      runtimeRegistry: registry,
      tracked: {
        pid: 4326,
        startedBy: 'happy directly - likely by user from terminal',
        happySessionId: 'terminal-session',
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/terminal-session',
          host: 'test-host',
          homeDir: '/tmp/home',
          happyHomeDir: '/tmp/happier',
          happyLibDir: '/tmp/happier/lib',
          happyToolsDir: '/tmp/happier/tools',
          hostPid: 4326,
          flavor: 'opencode',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
              },
            },
          },
          connectedServiceBrokerSelectionIdentityV1: brokerSelectionIdentity,
        },
      } as Parameters<typeof registerConnectedServiceTrackedSessionTargetsForDaemon>[0]['tracked'],
    });

    expect(registry.getByBrokerSelectionIdentity(brokerSelectionIdentity)).toEqual(expect.objectContaining({
      pid: 4326,
      sessionId: 'terminal-session',
    }));
  });

  it('reconciles a late runtime against the latest projection when the profile is unchanged but its credential revision changed', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const previousCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const currentCredentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const projection = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        groups: [{ groupId: 'team', activeProfileId: 'codex-a', generation: 7 }],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'codex-a',
        credentialRevision: currentCredentialRevision,
      }],
    });
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget: {
        serviceId: 'openai-codex' as const,
        groupId: 'team',
        profileId: 'codex-a',
        generation: 7,
        credentialRevision: currentCredentialRevision,
        proof: {
          status: 'verified' as const,
          source: 'codex_app_server',
          credentialRevision: currentCredentialRevision,
        },
      },
    }));
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'per_session_runtime',
        ownerId: 'codex',
      }),
      verifySharedGenerationApplication: async () => null,
      notifyCurrentGroupTruth: async () => ({ ok: true }),
    });
    const reconciliations: Promise<unknown>[] = [];
    registry.onTargetRegistration(({ target }) => {
      reconciliations.push(reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
        target,
        consumer,
        listCurrentGroups: async (serviceId) => projection.groups.filter((group) => group.serviceId === serviceId),
        resolveCredentialRevision: projection.resolveCredentialRevision,
        resolveCredentialBoundary: projection.resolveCredentialBoundary,
        executionAuthority: 'passive_projection',
      }));
    });

    registerConnectedServiceRuntimeTargetForDaemon({
      runtimeRegistry: registry,
      pid: 4325,
      agentId: 'codex',
      sessionId: 'late-current-truth-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
            profileId: 'codex-a',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'codex-a',
          fallbackProfileId: 'codex-b',
          generation: 7,
          credentialRevision: previousCredentialRevision,
        }]),
      },
    });
    await Promise.all(reconciliations);

    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      executionAuthority: 'passive_projection',
      committedGeneration: expect.objectContaining({
        decisionCommittedTarget: expect.objectContaining({
          profileId: 'codex-a',
          generation: 7,
          credentialRevision: currentCredentialRevision,
        }),
      }),
    }));
  });
});

describe('runtime-target reconciliation readiness', () => {
  it('does not reconcile a daemon-spawned session registration before its runner webhook is ready', () => {
    const candidate = Reflect.get(
      runtimeTargetRegistrationModule,
      'shouldReconcileConnectedServiceRuntimeTargetRegistration',
    );
    expect(candidate).toBeTypeOf('function');
    if (typeof candidate !== 'function') return;

    expect(candidate({
      registration: {
        key: { kind: 'session', pid: 4321 },
        target: { pid: 4321, sessionId: 'sess-starting' },
      },
      tracked: {
        pid: 4321,
        happySessionId: 'sess-starting',
      },
    })).toBe(false);
    expect(candidate({
      registration: {
        key: { kind: 'session', pid: 4321 },
        target: { pid: 4321, sessionId: 'sess-ready' },
      },
      tracked: {
        pid: 4321,
        happySessionId: 'sess-ready',
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/session-ready',
          host: 'test-host',
          homeDir: '/tmp/home',
          happyHomeDir: '/tmp/happier',
          happyLibDir: '/tmp/happier/lib',
          happyToolsDir: '/tmp/happier/tools',
          hostPid: 4321,
        },
      },
    })).toBe(true);
    expect(candidate({
      registration: {
        key: { kind: 'execution_run', runKey: 'run-1' },
        target: { pid: 4321, sessionId: 'sess-ready' },
      },
      tracked: null,
    })).toBe(true);
  });
});
