import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { createConnectedServiceContinuationApplicationCorrelation } from '../../continuation/connectedServiceContinuationApplicationCorrelation';
import { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';

type ConsumerDeps = ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0];

const generation = buildConnectedServiceAuthGroupCommittedGenerationFact({
  decisionId: 'decision-2',
  provenance: 'reconciliation',
  decisionCommittedTarget: {
    serviceId: 'openai-codex',
    groupId: 'team',
    profileId: 'backup',
    generation: 2,
    credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
  },
});

const providerAdoptedTarget = {
  ...generation.decisionCommittedTarget,
  proof: {
    status: 'verified' as const,
    source: 'codex_app_server',
    providerAccountId: 'acct',
    credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
  },
};

const perSessionDeps = {
  resolveGenerationApplicationScope: async (input: { sessionId: string }) => ({
    status: 'supported' as const,
    scope: 'per_session_runtime' as const,
    ownerId: `test:${input.sessionId}`,
  }),
  verifySharedGenerationApplication: async () => null,
  notifyCurrentGroupTruth: async () => ({ ok: true as const }),
};

function convergedConsumer(overrides: Partial<ConsumerDeps> = {}) {
  return new ConnectedServiceAuthGroupGenerationConsumer({
    ...perSessionDeps,
    applyCommittedGeneration: async () => ({
      reconciliationDisposition: 'converged',
      errorCode: null,
      providerAdoptedTarget,
    }),
    ...overrides,
  });
}

describe('ConnectedServiceAuthGroupGenerationConsumer', () => {
  it.each([
    ['automatic_runtime_failure', 'same_provider_account_exhausted'],
    ['pre_turn_group_policy', 'soft_threshold'],
    ['manual', 'manual'],
  ] as const)('classifies %s generation recipients as %s instead of reusing generation provenance', async (
    switchReason,
    expectedGenerationApplyReason,
  ) => {
    const hardLimitGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: `decision-${switchReason}`,
      provenance: 'hard_limit',
      decisionCommittedTarget: generation.decisionCommittedTarget,
    });
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));

    await convergedConsumer({ applyCommittedGeneration }).consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: hardLimitGeneration,
      switchReason,
      sessions: [{ sessionId: 'recipient', activity: 'live' }],
    });

    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      generationApplyReason: expectedGenerationApplyReason,
    }));
  });

  it('invokes the decision owner once and applies one immutable fact to every live recipient', async () => {
    const decideCommittedGeneration = vi.fn(async () => generation);
    const applyCommittedGeneration = vi.fn(async (_input: Parameters<ConsumerDeps['applyCommittedGeneration']>[0]) => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const result = await convergedConsumer({ applyCommittedGeneration }).decideAndConsume({
      executionAuthority: 'runtime_recovery',
      decideCommittedGeneration,
      switchReason: 'automatic_runtime_failure',
      sessions: Array.from({ length: 5 }, (_, index) => ({
        sessionId: `session-${index}`,
        activity: 'live' as const,
      })),
    });

    expect(decideCommittedGeneration).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration).toHaveBeenCalledTimes(5);
    expect(new Set(applyCommittedGeneration.mock.calls.map(([input]) => input.committedGeneration.decisionId)))
      .toEqual(new Set(['decision-2']));
    expect(result.acknowledgeable).toBe(true);
  });

  it('invokes one shared provider application for multiple live group sessions', async () => {
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const applySharedGenerationApplication = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const consumer = convergedConsumer({
      applyCommittedGeneration,
      applySharedGenerationApplication,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'shared_group_auth_surface',
        ownerId: 'claude',
      }),
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: ['a', 'b', 'c'].map((sessionId) => ({ sessionId, activity: 'live' as const })),
    });

    expect(applySharedGenerationApplication).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(result).toMatchObject({ acknowledgeable: true, appliedSessionCount: 3 });
  });

  it('keeps exact application settled when best-effort continuation fails', async () => {
    const settleExactRecipientApplication = vi.fn(async () => undefined);
    const continueAfterExactRecipientApplication = vi.fn(async () => {
      throw new Error('pending continuation unavailable');
    });
    const notifyCurrentGroupTruth = vi.fn(async () => ({ ok: true as const }));
    const consumer = convergedConsumer({
      settleExactRecipientApplication,
      continueAfterExactRecipientApplication,
      notifyCurrentGroupTruth,
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: [{ sessionId: 'origin', activity: 'live' }],
    });

    expect(settleExactRecipientApplication).toHaveBeenCalledOnce();
    expect(notifyCurrentGroupTruth).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'origin',
      applicationSettled: true,
    }));
    expect(continueAfterExactRecipientApplication).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      acknowledgeable: true,
      appliedSessionCount: 1,
      failedSessionCount: 0,
    });
  });

  it('drops a replaced exact registration after shared proof without applying or publishing stale available truth', async () => {
    let isCurrent = true;
    let resolveProof!: (value: typeof providerAdoptedTarget) => void;
    const proof = new Promise<typeof providerAdoptedTarget>((resolve) => {
      resolveProof = resolve;
    });
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const notifyCurrentGroupTruth = vi.fn(async () => ({ ok: true as const }));
    const consumer = convergedConsumer({
      applyCommittedGeneration,
      resolveGenerationApplicationScope: async () => ({
        status: 'supported',
        scope: 'shared_group_auth_surface',
        ownerId: 'claude',
      }),
      verifySharedGenerationApplication: async () => await proof,
      notifyCurrentGroupTruth,
    });
    const resultPromise = consumer.consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: [{ sessionId: 'same-session', activity: 'live', isCurrent: () => isCurrent }],
    });

    await Promise.resolve();
    isCurrent = false;
    resolveProof(providerAdoptedTarget);

    await expect(resultPromise).resolves.toMatchObject({
      acknowledgeable: true,
      appliedSessionCount: 0,
      failedSessionCount: 0,
      resultsBySessionId: {},
    });
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(notifyCurrentGroupTruth).not.toHaveBeenCalled();
  });

  it('does not apply or persist when no runtime target is live', async () => {
    const applyCommittedGeneration = vi.fn();
    const result = await convergedConsumer({ applyCommittedGeneration }).consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: [
        { sessionId: 'idle', activity: 'idle' },
        { sessionId: 'offline', activity: 'offline' },
      ],
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(result).toMatchObject({ acknowledgeable: true, appliedSessionCount: 0, resultsBySessionId: {} });
  });

  it.each([
    ['unsupported', 'generation_application_scope_unsupported'],
    ['unavailable', 'generation_application_scope_unavailable'],
  ] as const)('fails %s live application scope closed without acknowledging', async (status, errorCode) => {
    const applyCommittedGeneration = vi.fn();
    const result = await convergedConsumer({
      applyCommittedGeneration,
      resolveGenerationApplicationScope: async () => ({ status, errorCode }),
    }).consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: [{ sessionId: 'live', activity: 'live' }],
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      acknowledgeable: false,
      resultsBySessionId: {
        live: { disposition: 'failed', reconciliationDisposition: 'failed', errorCode },
      },
    });
  });

  it('leaves a failed live application non-acknowledgeable for projection retry', async () => {
    const result = await convergedConsumer({
      applyCommittedGeneration: async (input) => {
        expect(input.executionAuthority).toBe('passive_projection');
        return {
          reconciliationDisposition: 'deferred_restart',
          errorCode: 'restart_disallowed_by_execution_policy',
        };
      },
    }).consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: [{ sessionId: 'live', activity: 'live' }],
    });

    expect(result).toMatchObject({
      acknowledgeable: false,
      skippedIdleSessionCount: 1,
      resultsBySessionId: {
        live: {
          disposition: 'failed',
          reconciliationDisposition: 'deferred_restart',
          errorCode: 'restart_disallowed_by_execution_policy',
        },
      },
    });
  });

  it('continues each interrupted exact recipient once without waiting for aggregate acknowledgement', async () => {
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();
    const enqueueOrdinaryPending = vi.fn(async (_input: Readonly<{
      sessionId: string;
      interruptedOriginId: string;
    }>) => {});
    const exactApplications = new Set<string>();
    const target = generation.decisionCommittedTarget;
    for (const [sessionId, interruptedOriginId] of [
      ['interrupted-a', 'origin-a'],
      ['interrupted-b', 'origin-b'],
    ] as const) {
      expect(correlation.register({
        sessionId,
        serviceId: target.serviceId,
        groupId: target.groupId,
        profileId: target.profileId,
        generation: target.generation,
      }, interruptedOriginId)).toBe(true);
    }

    const consumer = convergedConsumer({
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
        if (sessionId === 'unresolved') {
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'recipient_not_acknowledged',
          };
        }
        const appliedTarget = committedGeneration.decisionCommittedTarget;
        const exactApplicationKey = `${sessionId}:${appliedTarget.generation}`;
        if (!exactApplications.has(exactApplicationKey)) {
          exactApplications.add(exactApplicationKey);
        }
        return {
          reconciliationDisposition: 'converged',
          errorCode: null,
          providerAdoptedTarget,
        };
      },
      settleExactRecipientApplication: async ({ sessionId, providerAdoptedTarget: appliedTarget }) => {
        await correlation.settle({
          sessionId,
          serviceId: appliedTarget.serviceId,
          groupId: appliedTarget.groupId,
          profileId: appliedTarget.profileId,
          generation: appliedTarget.generation,
        }, async (interruptedOriginId) => {
          await enqueueOrdinaryPending({ sessionId, interruptedOriginId });
        });
      },
    });
    const sessions = [
      'interrupted-a',
      'interrupted-b',
      'unresolved',
      'unrelated-sibling',
    ].map((sessionId) => ({ sessionId, activity: 'live' as const }));
    const consume = async () => await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions,
    });

    await expect(consume()).resolves.toMatchObject({
      acknowledgeable: false,
      failedSessionCount: 1,
    });
    await expect(consume()).resolves.toMatchObject({
      acknowledgeable: false,
      failedSessionCount: 1,
    });

    expect(exactApplications).toEqual(new Set([
      'interrupted-a:2',
      'interrupted-b:2',
      'unrelated-sibling:2',
    ]));
    expect(enqueueOrdinaryPending.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: 'interrupted-a', interruptedOriginId: 'origin-a' },
      { sessionId: 'interrupted-b', interruptedOriginId: 'origin-b' },
    ]);
  });

  it('redistributes a newer authoritative epoch to every live recipient', async () => {
    const generationC = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-3',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        ...generation.decisionCommittedTarget,
        profileId: 'backup-c',
        generation: 3,
        credentialRevision: 'csr_3123456789ABCDEFGHJKMNPQRS',
      },
    });
    const applied: string[] = [];
    const result = await convergedConsumer({
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
        applied.push(`${sessionId}:${committedGeneration.decisionCommittedTarget.generation}`);
        if (sessionId === 'source' && committedGeneration.decisionCommittedTarget.generation === 2) {
          return {
            reconciliationDisposition: 'superseded_after_apply',
            errorCode: null,
            authoritativeGeneration: generationC,
          };
        }
        return {
          reconciliationDisposition: 'converged',
          errorCode: null,
          providerAdoptedTarget: {
            ...committedGeneration.decisionCommittedTarget,
            proof: {
              status: 'verified',
              source: 'codex_app_server',
              credentialRevision: committedGeneration.decisionCommittedTarget.credentialRevision,
            },
          },
        };
      },
    }).consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: ['source', 'sibling'].map((sessionId) => ({ sessionId, activity: 'live' as const })),
    });

    expect(applied).toEqual(expect.arrayContaining(['source:2', 'sibling:2', 'source:3', 'sibling:3']));
    expect(result.acknowledgeable).toBe(true);
  });
});
