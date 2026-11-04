import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState } from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceQuotasCoordinator } from '../quotas/ConnectedServiceQuotasCoordinator';
import { RuntimeAuthRecoveryScheduler } from './RuntimeAuthRecoveryScheduler';
import { fanoutRuntimeAuthUsageLimitRecovery } from './fanoutRuntimeAuthUsageLimitRecovery';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

describe('runtime usage-limit recovery fanout', () => {
  it('carries a scheduler-committed replacement to every sibling without selecting again', async () => {
    let current: ConnectedServiceAuthGroupSwitchState = {
      serviceId: 'claude-subscription', groupId: 'pool', activeProfileId: 'failed', generation: 1, runtimeStateRevision: 0,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority', autoSwitch: true },
      members: ['failed', 'backup'].map((profileId, priority) => ({ profileId, priority, enabled: true, createdAtMs: priority })),
      memberStatesByProfileId: new Map(),
    };
    let commits = 0;
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(), nowMs: () => 1_000,
      quotaFreshnessMs: 60_000, loadState: async () => current,
      // Durable group commit and provider application are genuine system boundaries.
      commitSwitch: async ({ toProfileId }) => { commits++; return current = { ...current, activeProfileId: toProfileId, generation: 2 }; },
      applyGeneration: async () => {},
    });
    const applied = new Map<string, { profileId: string; generation: number }>();
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      resolveGenerationApplicationScope: async () => ({ status: 'supported', scope: 'per_session_runtime', ownerId: 'runner' }),
      verifySharedGenerationApplication: async () => null,
      // Stand in for each external provider runtime, keeping the generation consumer real.
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
        const target = committedGeneration.decisionCommittedTarget;
        applied.set(sessionId, { profileId: target.profileId, generation: target.generation });
        return { reconciliationDisposition: 'converged', errorCode: null,
          providerAdoptedTarget: { ...target, proof: { status: 'verified', source: 'codex_app_server',
            providerAccountId: 'backup-account', credentialRevision: target.credentialRevision } } };
      },
      notifyCurrentGroupTruth: async () => ({ ok: true }),
    });
    type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
    // Only the remote API boundary is stubbed; this flow must not need a quota or credential read.
    const api = { getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceQuotaSnapshotPlain: async () => null, getConnectedServiceCredentialPlain: async () => null,
      getConnectedServiceQuotaSnapshotSealed: async () => null, getConnectedServiceCredentialSealed: async () => null,
    } as unknown as QuotaApi;
    const diagnostics: unknown[] = [];
    const quotaCoordinator = new ConnectedServiceQuotasCoordinator({
      api, credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      quotaFetchers: [], now: () => 1_000, randomBytes,
      authGroupSwitchCoordinator: switchCoordinator, sameAccountFanoutStrategyResolver: () => 'shared_group_auth_surface',
      consumeCommittedAuthGroupGeneration: (input) => consumer.consume(input), recordDiagnostic: (event) => diagnostics.push(event),
    });
    for (const [index, sessionId] of ['source', 'sibling-1', 'sibling-2'].entries()) {
      quotaCoordinator.registerSpawnTarget({ pid: 900_000 + index, sessionId,
        connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool' },
        } },
        connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group', serviceId: 'claude-subscription', groupId: 'pool', activeProfileId: 'failed',
          fallbackProfileId: 'backup', generation: 1,
        }]) },
      });
    }
    const classification: ConnectedServiceRuntimeFailureClassification = {
      kind: 'usage_limit', serviceId: 'claude-subscription', groupId: 'pool', profileId: 'failed', groupGeneration: 1,
      resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
    };
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, recover: async () => {
      const result = await switchCoordinator.switchAfterClassifiedFailure({
        serviceId: classification.serviceId, groupId: 'pool', reason: 'usage_limit', observedProfileId: 'failed',
      });
      const recovery = { status: 'switch_attempted', result };
      await fanoutRuntimeAuthUsageLimitRecovery({ sessionId: 'source', classification,
        recovery, quotaCoordinator, supersedingSourceConverged: false });
      return recovery;
    } });
    try {
      await scheduler.enqueueHandlerFailure({ sessionId: 'source', switchesThisTurn: 0, classification,
        error: { response: { status: 503 } } });
      await scheduler.wake({ sessionId: 'source', reason: 'manual' });
      expect(commits).toBe(1);
      expect([...applied.entries()].sort()).toEqual(['sibling-1', 'sibling-2', 'source'].map((id) =>
        [id, { profileId: 'backup', generation: 2 }]));
      expect(diagnostics).not.toContainEqual(expect.objectContaining({ reason: 'hard_limit_committed_generation_missing' }));
    } finally { scheduler.dispose(); quotaCoordinator.dispose(); }
  });
});
