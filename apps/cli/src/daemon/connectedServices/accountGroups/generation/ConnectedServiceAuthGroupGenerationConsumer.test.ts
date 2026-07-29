import { describe, expect, it, vi } from 'vitest';
const perSessionGenerationApplicationDeps = {
  resolveGenerationApplicationScope: async (input: { sessionId: string }) => ({
    status: 'supported' as const,
    scope: 'per_session_runtime' as const,
    ownerId: `test:${input.sessionId}`,
  }),
  verifySharedGenerationApplication: async () => null,
};


import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';

type ConsumerDeps = ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0];
type ApplyInput = Parameters<ConsumerDeps['applyCommittedGeneration']>[0];
type PendingInput = Parameters<NonNullable<ConsumerDeps['recordPendingGeneration']>>[0];

describe('ConnectedServiceAuthGroupGenerationConsumer', () => {
  it('enforces group-unavailable on a live target before acknowledging it', async () => {
    const order: string[] = [];
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration: vi.fn(async () => ({ reconciliationDisposition: 'failed' as const, errorCode: 'unexpected' })),
      recordPendingGeneration: vi.fn(async () => {}),
      recordGroupUnavailable: vi.fn(async () => { order.push('persist'); }),
      enforceGroupUnavailable: vi.fn(async () => { order.push('enforce'); }),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    await expect(consumer.consumeUnavailable({
      serviceId: 'openai-codex',
      groupId: 'team',
      sessions: [{ sessionId: 'live', activity: 'live' }],
    })).resolves.toEqual({ acknowledgeable: true, recordedSessionCount: 1 });
    expect(order).toEqual(['enforce']);
  });

  it('does not acknowledge a live unavailable target when provider-request enforcement fails', async () => {
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration: vi.fn(async () => ({ reconciliationDisposition: 'failed' as const, errorCode: 'unexpected' })),
      recordPendingGeneration: vi.fn(async () => {}),
      recordGroupUnavailable: vi.fn(async () => {}),
      enforceGroupUnavailable: vi.fn(async () => { throw new Error('runner still usable'); }),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    await expect(consumer.consumeUnavailable({
      serviceId: 'openai-codex',
      groupId: 'team',
      sessions: [{ sessionId: 'live', activity: 'live' }],
    })).resolves.toEqual({ acknowledgeable: false, recordedSessionCount: 0 });
  });
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

  it('invokes the decision owner once for one source plus four siblings', async () => {
    const decideCommittedGeneration = vi.fn(async () => generation);
    const applyCommittedGeneration = vi.fn(async (_input: ApplyInput) => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration: vi.fn(async (_input: PendingInput) => {}),
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    const result = await consumer.decideAndConsume({
      executionAuthority: 'runtime_recovery',
      decideCommittedGeneration,
      switchReason: 'automatic_runtime_failure',
      sessions: Array.from({ length: 5 }, (_, index) => ({
        sessionId: index === 0 ? 'source' : `sibling-${index}`,
        activity: 'live' as const,
      })),
    });

    expect(decideCommittedGeneration).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration).toHaveBeenCalledTimes(5);
    expect(new Set(applyCommittedGeneration.mock.calls.map(([input]) => (
      `${input.committedGeneration.decisionId}:${input.committedGeneration.decisionCommittedTarget.generation}`
    )))).toEqual(new Set(['decision-2:2']));
    expect(result.acknowledgeable).toBe(true);
  });

  it('invokes one shared provider application and records one disposition per Claude group session', async () => {
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget: {
        ...providerAdoptedTarget,
        proof: {
          ...providerAdoptedTarget.proof,
          sharedAuthSurfaceId: 'team',
          credentialFingerprint: 'sha256:abcdef12',
        },
      },
    }));
    const clearAdoptedGeneration = vi.fn(async () => {});
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration: vi.fn(async () => {}),
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration,
      resolveGenerationApplicationScope: vi.fn(async () => ({
        status: 'supported' as const,
        scope: 'shared_group_auth_surface' as const,
        ownerId: 'claude',
      })),
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: ['source', 'sibling-a', 'sibling-b'].map((sessionId) => ({
        sessionId,
        activity: 'live' as const,
      })),
    });

    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
    expect(clearAdoptedGeneration).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      ok: true,
      acknowledgeable: true,
      appliedSessionCount: 3,
      resultsBySessionId: {
        source: { reconciliationDisposition: 'converged' },
        'sibling-a': { reconciliationDisposition: 'converged' },
        'sibling-b': { reconciliationDisposition: 'converged' },
      },
    });
  });

  it('applies one shared provider surface for all-offline members without restart work', async () => {
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget: {
        ...providerAdoptedTarget,
        proof: { ...providerAdoptedTarget.proof, sharedAuthSurfaceId: 'team' },
      },
    }));
    const recordPendingGeneration = vi.fn(async () => {});
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration,
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
      resolveGenerationApplicationScope: vi.fn(async () => ({
        status: 'supported' as const,
        scope: 'shared_group_auth_surface' as const,
        ownerId: 'claude',
      })),
    });
    const result = await consumer.consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: ['a', 'b', 'c'].map((sessionId) => ({ sessionId, activity: 'offline' as const })),
    });
    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(result).toMatchObject({ appliedSessionCount: 3, restartRequestedSessionCount: 0, skippedIdleSessionCount: 0 });
  });

  it('settles request-time-auth recipients from installed projection without provider apply or restart work', async () => {
    const applyCommittedGeneration = vi.fn();
    const clearAdoptedGeneration = vi.fn();
    const verifySharedGenerationApplication = vi.fn();
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      applyCommittedGeneration,
      clearAdoptedGeneration,
      verifySharedGenerationApplication,
      resolveGenerationApplicationScope: vi.fn(async () => ({
        status: 'supported' as const,
        scope: 'request_time_auth' as const,
        ownerId: 'opencode',
      })),
    });

    const result = await consumer.consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: [
        { sessionId: 'live', activity: 'live' },
        { sessionId: 'idle', activity: 'idle' },
        { sessionId: 'offline', activity: 'offline' },
      ],
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(clearAdoptedGeneration).not.toHaveBeenCalled();
    expect(verifySharedGenerationApplication).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      acknowledgeable: true,
      outcome: 'adopted_current',
      appliedSessionCount: 3,
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 0,
      resultsBySessionId: {
        live: {
          disposition: 'applied_hot',
          reconciliationDisposition: 'converged',
          errorCode: null,
          pendingRecorded: false,
        },
        idle: {
          disposition: 'applied_hot',
          reconciliationDisposition: 'converged',
          errorCode: null,
          pendingRecorded: false,
        },
        offline: {
          disposition: 'applied_hot',
          reconciliationDisposition: 'converged',
          errorCode: null,
          pendingRecorded: false,
        },
      },
    });
  });

  it('fails unavailable application scope closed with zero provider calls', async () => {
    const applyCommittedGeneration = vi.fn();
    const recordPendingGeneration = vi.fn(async () => {});
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration,
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
      resolveGenerationApplicationScope: vi.fn(async () => ({
        status: 'unavailable' as const,
        errorCode: 'generation_application_scope_unavailable',
      })),
    });
    await consumer.consume({
      executionAuthority: 'passive_projection',
      committedGeneration: generation,
      switchReason: 'manual',
      sessions: [{ sessionId: 'unknown', activity: 'live' }],
    });
    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(recordPendingGeneration).not.toHaveBeenCalled();
  });

  it('reports idle/offline exact generation locally and never exposes a selection callback', async () => {
    const applyCommittedGeneration = vi.fn(async (_input: ApplyInput) => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const recordPendingGeneration = vi.fn(async (_input: PendingInput) => {});
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration,
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      // There is deliberately no quota-evidence input: dissemination is already past selection.
      sessions: [
        { sessionId: 'live', activity: 'live' },
        { sessionId: 'idle', activity: 'idle' },
        { sessionId: 'offline', activity: 'offline' },
      ],
    });

    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'live',
      committedGeneration: { decisionId: 'decision-2', decisionCommittedTarget: { generation: 2 } },
    });
    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(result.acknowledgeable).toBe(false);
    expect(result.skippedIdleSessionCount).toBe(2);
    expect(result.resultsBySessionId).toMatchObject({
      live: { disposition: 'applied_hot' },
      idle: { disposition: 'deferred_persisted' },
      offline: { disposition: 'deferred_persisted' },
    });
  });

  it('applies every live group-bound recipient even when it was materially on an older account', async () => {
    const applyCommittedGeneration = vi.fn(async (_input: ApplyInput) => ({
      reconciliationDisposition: 'converged' as const,
      errorCode: null,
      providerAdoptedTarget,
    }));
    const recordPendingGeneration = vi.fn(async (_input: PendingInput) => {});
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration,
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: [{
        sessionId: 'old-account',
        activity: 'live',
      }],
    });

    expect(applyCommittedGeneration).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'old-account',
      committedGeneration: generation,
    }));
    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(result.acknowledgeable).toBe(true);
  });

  it('propagates an authoritative C fact and redistributes it to every live recipient', async () => {
    const generationC = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-3',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup-c',
        generation: 3,
        credentialRevision: 'csr_3123456789ABCDEFGHJKMNPQRS',
      },
    });
    const applied: string[] = [];
    const supersededResult: Awaited<ReturnType<ConsumerDeps['applyCommittedGeneration']>> = {
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: null,
      authoritativeGeneration: generationC,
    };
    const applyCommittedGeneration: ConsumerDeps['applyCommittedGeneration'] = async ({ sessionId, committedGeneration }) => {
        applied.push(`${sessionId}:${committedGeneration.decisionCommittedTarget.generation}`);
        if (sessionId === 'source' && committedGeneration.decisionCommittedTarget.generation === 2) {
          return supersededResult;
        }
        return {
          reconciliationDisposition: 'converged',
          errorCode: null,
          providerAdoptedTarget: {
            ...committedGeneration.decisionCommittedTarget,
            proof: {
              status: 'verified',
              source: 'codex_app_server',
              providerAccountId: 'acct',
              credentialRevision: committedGeneration.decisionCommittedTarget.credentialRevision,
            },
          },
        };
      };
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration: vi.fn(async (_input: PendingInput) => {}),
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: [
        { sessionId: 'source', activity: 'live' },
        { sessionId: 'sibling', activity: 'live' },
      ],
    });

    expect(applied).toEqual(expect.arrayContaining([
      'source:2',
      'sibling:2',
      'source:3',
      'sibling:3',
    ]));
    expect(result.acknowledgeable).toBe(true);
    expect(result.resultsBySessionId.source).toMatchObject({
      reconciliationDisposition: 'converged',
    });
  });

  it('does not acknowledge convergence until the exact adopted proof clears durable pending state', async () => {
    const clearAdoptedGeneration = vi.fn(async () => { throw new Error('metadata unavailable'); });
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration: vi.fn(async () => ({
        reconciliationDisposition: 'converged' as const,
        errorCode: null,
        providerAdoptedTarget,
      })),
      recordPendingGeneration: vi.fn(async () => {}),
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration,
    });

    const result = await consumer.consume({
      executionAuthority: 'runtime_recovery',
      committedGeneration: generation,
      switchReason: 'automatic_runtime_failure',
      sessions: [{ sessionId: 'live', activity: 'live' }],
    });

    expect(clearAdoptedGeneration).toHaveBeenCalledWith({
      sessionId: 'live',
      providerAdoptedTarget,
    });
    expect(result.acknowledgeable).toBe(false);
    expect(result.resultsBySessionId.live).toMatchObject({
      disposition: 'failed',
      reconciliationDisposition: 'failed',
      errorCode: 'provider_adoption_clear_failed',
      pendingRecorded: false,
    });
    expect(result).toMatchObject({ ok: false, failedSessionCount: 1 });
  });

  it('propagates passive projection authority and locally defers a restart-only live recipient', async () => {
    const recordPendingGeneration = vi.fn(async () => {});
    const applyCommittedGeneration: ConsumerDeps['applyCommittedGeneration'] = vi.fn(async (input) => {
      expect(input).not.toHaveProperty('allowRestart');
      return { reconciliationDisposition: 'deferred_restart' as const, errorCode: 'restart_disallowed_by_execution_policy' };
    });
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration,
      recordPendingGeneration,
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    const result = await consumer.consume({
      committedGeneration: generation,
      switchReason: 'manual',
      executionAuthority: 'passive_projection',
      sessions: [{ sessionId: 'reattached-live', activity: 'live' }],
    });

    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(result.acknowledgeable).toBe(false);
    expect(result).toMatchObject({
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 1,
      resultsBySessionId: {
        'reattached-live': { disposition: 'deferred_persisted' },
      },
    });
  });

  it('threads the exact execution authority without deriving a restart boolean', async () => {
    const observed: string[] = [];
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
      ...perSessionGenerationApplicationDeps,
      applyCommittedGeneration: vi.fn(async (input: ApplyInput) => {
        expect(input).not.toHaveProperty('allowRestart');
        observed.push(input.executionAuthority);
        return { reconciliationDisposition: 'deferred_restart' as const, errorCode: null };
      }),
      recordPendingGeneration: vi.fn(async () => {}),
      recordGroupUnavailable: vi.fn(async () => {}),
      clearAdoptedGeneration: vi.fn(async () => {}),
    });

    for (const executionAuthority of ['passive_projection', 'fresh_user_action', 'runtime_recovery'] as const) {
      await consumer.consume({
        committedGeneration: generation,
        switchReason: 'manual',
        executionAuthority,
        sessions: [{ sessionId: executionAuthority, activity: 'live' }],
      });
    }

    expect(observed).toEqual([
      'passive_projection',
      'fresh_user_action',
      'runtime_recovery',
    ]);
  });
});
