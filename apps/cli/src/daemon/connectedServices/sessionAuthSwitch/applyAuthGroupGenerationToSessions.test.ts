import { describe, expect, it, vi } from 'vitest';

import { applyConnectedServiceAuthGroupGenerationToSessions } from './applyAuthGroupGenerationToSessions';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  type ConnectedServiceAuthGroupCommittedGenerationFact,
} from './connectedServiceAuthSwitchOutcome';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { mapCommittedGenerationApplyResult } from '../accountGroups/generation/mapCommittedGenerationApplyResult';

const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';

function converged(fact: ConnectedServiceAuthGroupCommittedGenerationFact) {
  return {
    reconciliationDisposition: 'converged' as const,
    errorCode: null,
    providerAdoptedTarget: {
      ...fact.decisionCommittedTarget,
      proof: {
        status: 'verified' as const,
        source: 'test_verification',
        credentialRevision: fact.decisionCommittedTarget.credentialRevision,
      },
    },
  };
}

function deferred() {
  type Result = ReturnType<typeof converged>;
  let resolve: (value: Result) => void = () => {};
  const promise = new Promise<Result>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function sharedVerificationDeps() {
  return {
    verifySharedGenerationApplication: async () => null,
  };
}

describe('applyConnectedServiceAuthGroupGenerationToSessions', () => {
  const manualGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
    decisionId: 'manual-7',
    provenance: 'manual',
    decisionCommittedTarget: {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'next',
      generation: 7,
      credentialRevision,
    },
  });
  it('accepts one immutable committed generation and reports every non-converged recipient locally', async () => {
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-once',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'next',
        generation: 2,
        credentialRevision,
      },
    });
    const selectionCalls: string[] = [];
    const applied: string[] = [];
    const pending: string[] = [];

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: Array.from({ length: 5 }, (_, index) => ({
        sessionId: `session-${index}`,
        fromProfileId: 'source',
      })),
      applyCommittedGeneration: async ({ sessionId, committedGeneration: exactFact }) => {
        applied.push(`${sessionId}:${exactFact.decisionId}:${exactFact.decisionCommittedTarget.generation}`);
        return sessionId === 'session-4'
          ? { reconciliationDisposition: 'deferred_restart' as const, errorCode: null }
          : converged(exactFact);
      },
      recordPendingGeneration: async ({ sessionId, committedGeneration: exactFact }) => {
        pending.push(`${sessionId}:${exactFact.decisionId}:${exactFact.decisionCommittedTarget.generation}`);
      },
      clearAdoptedGeneration: async () => {},
    });

    // There is deliberately no selector/committer callback in the recipient API.
    expect(selectionCalls).toEqual([]);
    expect(applied).toHaveLength(5);
    expect(new Set(applied.map((value) => value.split(':').slice(1).join(':')))).toEqual(
      new Set(['decision-once:2']),
    );
    expect(pending).toEqual([]);
    expect(result.resultsBySessionId?.['session-4']).toMatchObject({
      reconciliationDisposition: 'deferred_restart',
      pendingRecorded: false,
    });
    expect(result).toMatchObject({
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 1,
    });
  });

  it('does not invoke the retired pending persistence dependency', async () => {
    const committedGeneration = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-persist-failure',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'next',
        generation: 3,
        credentialRevision,
      },
    });
    const recordPendingGeneration = vi.fn(async () => {
      throw new Error('disk unavailable');
    });

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'source' }],
      applyCommittedGeneration: async () => ({
        reconciliationDisposition: 'deferred_restart',
        errorCode: null,
      }),
      recordPendingGeneration,
      clearAdoptedGeneration: async () => {},
    });

    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(result.resultsBySessionId?.['session-1']).toEqual({
      reconciliationDisposition: 'deferred_restart',
      errorCode: null,
      pendingRecorded: false,
    });
    expect(result.failures).toEqual([]);
  });

  it('reports an exact clear CAS supersession as typed non-convergence without overwriting newer pending state', async () => {
    const recordPendingGeneration = vi.fn(async () => {});
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'old' }],
      applyCommittedGeneration: async () => converged(manualGeneration),
      recordPendingGeneration,
      clearAdoptedGeneration: async () => ({ status: 'superseded' as const }),
    });

    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, appliedSessionCount: 0, failedSessionCount: 1 });
    expect(result.resultsBySessionId?.['session-1']).toEqual({
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: 'provider_adoption_clear_superseded',
      pendingRecorded: true,
    });
  });

  it('boundedly redistributes the authoritative generation when B is superseded by C during apply', async () => {
    const generationB = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup-b',
        generation: 2,
        credentialRevision,
      },
    });
    const generationC = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-c',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'backup-c',
        generation: 3,
        credentialRevision,
      },
    });
    const applied: string[] = [];
    const pending: string[] = [];

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: generationB,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [
        { sessionId: 'session-1', fromProfileId: 'source' },
        { sessionId: 'session-2', fromProfileId: 'source' },
      ],
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
        applied.push(`${sessionId}:${committedGeneration.decisionCommittedTarget.generation}`);
        if (sessionId === 'session-1' && committedGeneration.decisionCommittedTarget.generation === 2) {
          return {
            reconciliationDisposition: 'superseded_after_apply',
            errorCode: null,
            authoritativeGeneration: generationC,
          };
        }
        return converged(committedGeneration);
      },
      recordPendingGeneration: async ({ committedGeneration }) => {
        pending.push(`${committedGeneration.decisionCommittedTarget.profileId}:${committedGeneration.decisionCommittedTarget.generation}`);
      },
      clearAdoptedGeneration: async () => {},
    });

    expect(applied).toEqual(expect.arrayContaining([
      'session-1:2',
      'session-2:2',
      'session-1:3',
      'session-2:3',
    ]));
    expect(pending).not.toContain('backup-b:2');
    expect(result.appliedSessionCount).toBe(2);
    expect(result.failedSessionCount).toBe(0);
  });

  it('re-applies C when its projection already advanced the cursor before the real B apply observes supersession', async () => {
    const generationB = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b-after-projection-c',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex', groupId: 'team', profileId: 'backup-b', generation: 2, credentialRevision,
      },
    });
    const authoritativeState = {
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'backup-c',
      generation: 3,
      credentialRevision,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, strategy: 'priority' as const },
      members: [],
      memberStatesByProfileId: new Map(),
    };
    const runtimeEpochs: string[] = ['backup-c:3'];
    const coordinatorStatuses: string[] = [];
    const coordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => 1_000,
      quotaFreshnessMs: 60_000,
      loadState: async () => authoritativeState,
      commitSwitch: async () => authoritativeState,
      applyGeneration: async ({ activeProfileId, generation, credentialRevision: appliedRevision }) => {
        if (activeProfileId === null || appliedRevision == null) {
          throw new Error('Exact generation application fixture requires a complete auth epoch');
        }
        runtimeEpochs.push(`${activeProfileId}:${generation}`);
        return {
          ok: true as const,
          mode: 'hot_apply' as const,
          providerApplication: 'applied' as const,
          verificationByServiceId: {
            'openai-codex': {
              status: 'verified' as const,
              proofStrength: 'exact' as const,
              providerAccountId: activeProfileId,
              generationApplication: {
                serviceId: 'openai-codex' as const,
                groupId: 'team',
                profileId: activeProfileId,
                generation,
                credentialRevision: appliedRevision,
                credentialFingerprint: `${activeProfileId}:${generation}`,
              },
            },
          },
        };
      },
    });

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: generationB,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'source' }],
      applyCommittedGeneration: async ({ sessionId, committedGeneration }) => {
        const coordinatorResult = await coordinator.applyCommittedGeneration({
          sessionId,
          ...committedGeneration.decisionCommittedTarget,
          activeProfileId: committedGeneration.decisionCommittedTarget.profileId,
          reason: committedGeneration.provenance,
        });
        coordinatorStatuses.push(coordinatorResult.status);
        return mapCommittedGenerationApplyResult({ committedGeneration, result: coordinatorResult });
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    // C was already projected and acknowledged before this call. The real coordinator applies stale
    // B, then reloads server C and reports supersession; no later projection edge is guaranteed.
    expect(coordinatorStatuses).toEqual(['superseded_after_apply', 'observed_generation']);
    expect(runtimeEpochs).toEqual(['backup-c:3', 'backup-b:2', 'backup-c:3']);
    expect(result).toMatchObject({ ok: true, appliedSessionCount: 1, failedSessionCount: 0 });
  });

  it('redistributes an authoritative revision-only epoch at the same group generation', async () => {
    const initial = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'revision-a',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'work',
        generation: 2,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const authoritative = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'revision-b',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'work',
        generation: 2,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    const appliedRevisions: Array<string | null> = [];

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: initial,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'work' }],
      applyCommittedGeneration: async ({ committedGeneration }) => {
        const revision = committedGeneration.decisionCommittedTarget.credentialRevision;
        appliedRevisions.push(revision);
        return revision === initial.decisionCommittedTarget.credentialRevision
          ? { reconciliationDisposition: 'superseded_after_apply', errorCode: null, authoritativeGeneration: authoritative }
          : converged(committedGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    expect(appliedRevisions).toEqual([
      'csr_aaaaaaaaaaaaaaaaaaaaaa',
      'csr_bbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(result.failedSessionCount).toBe(0);
  });

  it('keeps shared provider owners and per-session runtimes as distinct application effects', async () => {
    const applied: string[] = [];
    const cleared: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [
        { sessionId: 'claude-a', fromProfileId: 'old-a', applicationScope: 'shared_group_auth_surface', applicationOwnerId: 'claude' },
        { sessionId: 'claude-b', fromProfileId: 'old-b', applicationScope: 'shared_group_auth_surface', applicationOwnerId: 'claude' },
        { sessionId: 'other-a', fromProfileId: 'old', applicationScope: 'shared_group_auth_surface', applicationOwnerId: 'other-provider' },
        { sessionId: 'direct-a', fromProfileId: 'direct-old', applicationScope: 'per_session_runtime', applicationOwnerId: 'direct-a' },
      ],
      applyCommittedGeneration: async ({ sessionId }) => {
        applied.push(sessionId);
        return converged(manualGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async ({ sessionId }) => { cleared.push(sessionId); },
    });

    expect(applied).toHaveLength(3);
    expect(applied).toEqual(expect.arrayContaining(['claude-a', 'other-a', 'direct-a']));
    expect(cleared.sort()).toEqual(['claude-a', 'claude-b', 'direct-a', 'other-a']);
    expect(result.appliedSessionCount).toBe(4);
  });

  it('fences every live shared-owner sibling before one shared effect and releases each exact admission after proof', async () => {
    const events: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: ['claude-a', 'claude-b', 'claude-c'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applyCommittedGeneration: async (applyInput) => {
        const cohortSessionIds = applyInput.applicationCohortSessionIds ?? [applyInput.sessionId];
        for (const sessionId of cohortSessionIds) events.push(`enforce:${sessionId}`);
        events.push(`effect:${applyInput.sessionId}`);
        return converged(manualGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async ({ sessionId }) => { events.push(`clear:${sessionId}`); },
    });

    expect(result.appliedSessionCount).toBe(3);
    expect(events).toEqual([
      'enforce:claude-a',
      'enforce:claude-b',
      'enforce:claude-c',
      'effect:claude-a',
      'clear:claude-a',
      'clear:claude-b',
      'clear:claude-c',
    ]);
  });

  it('does not report a one-target shared application converged when its exact clear is superseded', async () => {
    const pendingGenerationBySessionId = new Map([['a', 8]]);
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [{
        sessionId: 'a',
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'claude',
      }],
      applyCommittedGeneration: async () => converged(manualGeneration),
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async ({ sessionId }) => (
        pendingGenerationBySessionId.get(sessionId) === 8
          ? { status: 'superseded' as const }
          : { status: 'cleared' as const }
      ),
    });

    expect(pendingGenerationBySessionId.get('a')).toBe(8);
    expect(result).toMatchObject({
      ok: false,
      appliedSessionCount: 0,
      failedSessionCount: 1,
      resultsBySessionId: {
        a: {
          reconciliationDisposition: 'superseded_after_apply',
          errorCode: 'provider_adoption_clear_superseded',
          pendingRecorded: true,
        },
      },
    });
  });

  it('maps every shared recipient clear as superseded when newer pending generations survive', async () => {
    const pendingGenerationBySessionId = new Map([['a', 8], ['b', 8], ['c', 8]]);
    const cleared: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: ['a', 'b', 'c'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applyCommittedGeneration: async () => converged(manualGeneration),
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async ({ sessionId }) => {
        cleared.push(sessionId);
        return pendingGenerationBySessionId.get(sessionId) === 8
          ? { status: 'superseded' as const }
          : { status: 'cleared' as const };
      },
    });

    expect(cleared.sort()).toEqual(['a', 'b', 'c']);
    expect([...pendingGenerationBySessionId.values()]).toEqual([8, 8, 8]);
    expect(result).toMatchObject({ ok: false, appliedSessionCount: 0, failedSessionCount: 3 });
    expect(result.resultsBySessionId).toEqual({
      a: {
        reconciliationDisposition: 'superseded_after_apply',
        errorCode: 'provider_adoption_clear_superseded',
        pendingRecorded: true,
      },
      b: {
        reconciliationDisposition: 'superseded_after_apply',
        errorCode: 'provider_adoption_clear_superseded',
        pendingRecorded: true,
      },
      c: {
        reconciliationDisposition: 'superseded_after_apply',
        errorCode: 'provider_adoption_clear_superseded',
        pendingRecorded: true,
      },
    });
  });

  it('reports one shared representative failure for every bound session without another provider apply', async () => {
    const applyCommittedGeneration = vi.fn(async () => ({
      reconciliationDisposition: 'failed' as const,
      errorCode: 'provider_application_failed',
    }));
    const pending: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: ['a', 'b', 'c'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applyCommittedGeneration,
      recordPendingGeneration: async ({ sessionId }) => { pending.push(sessionId); },
      clearAdoptedGeneration: async () => {},
    });

    expect(applyCommittedGeneration).toHaveBeenCalledTimes(1);
    expect(pending).toEqual([]);
    expect(result.failedSessionCount).toBe(3);
    expect(result.resultsBySessionId?.b).toMatchObject({
      reconciliationDisposition: 'failed',
      errorCode: 'provider_application_failed',
      pendingRecorded: false,
    });
  });

  it('re-enters one shared provider application per superseding epoch and adopts the final proof N times', async () => {
    const generationC = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'shared-c',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        ...manualGeneration.decisionCommittedTarget,
        profileId: 'final',
        generation: 8,
      },
    });
    const appliedGenerations: number[] = [];
    const cleared: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...sharedVerificationDeps(),
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: ['a', 'b', 'c'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      applyCommittedGeneration: async ({ committedGeneration }) => {
        appliedGenerations.push(committedGeneration.decisionCommittedTarget.generation);
        return committedGeneration.decisionCommittedTarget.generation === 7
          ? { reconciliationDisposition: 'superseded_after_apply' as const, errorCode: null, authoritativeGeneration: generationC }
          : converged(committedGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async ({ sessionId }) => { cleared.push(sessionId); },
    });

    expect(appliedGenerations).toEqual([7, 8]);
    expect(cleared.sort()).toEqual(['a', 'b', 'c']);
    expect(result.appliedSessionCount).toBe(3);
  });

  it('recovers a lost shared-effect response through exact provider verification without receipt I/O or a duplicate effect', async () => {
    let providerTarget: ReturnType<typeof converged>['providerAdoptedTarget'] | null = null;
    const providerEffects: ConnectedServiceAuthGroupCommittedGenerationFact[] = [];
    const applyCommittedGeneration = vi.fn(async ({ committedGeneration }: Readonly<{
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    }>) => {
      providerEffects.push(committedGeneration);
      providerTarget = converged(committedGeneration).providerAdoptedTarget;
      throw new Error('provider response lost after effect');
    });
    const verifySharedGenerationApplication = vi.fn(async ({
      committedGeneration,
      applicationOwnerId,
    }: Readonly<{
      committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
      applicationOwnerId: string;
    }>) => {
      expect(applicationOwnerId).toBe('claude');
      expect(committedGeneration.decisionCommittedTarget).toEqual({
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'next',
        generation: 7,
        credentialRevision,
      });
      return providerTarget;
    });
    const input = {
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: ['a', 'b'].map((sessionId) => ({
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      })),
      verifySharedGenerationApplication,
      applyCommittedGeneration,
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    } as const;

    const lostResponse = await applyConnectedServiceAuthGroupGenerationToSessions(input);
    expect(lostResponse.failedSessionCount).toBe(2);

    const recovered = await applyConnectedServiceAuthGroupGenerationToSessions(input);

    expect(providerEffects).toEqual([manualGeneration]);
    expect(applyCommittedGeneration).toHaveBeenCalledTimes(1);
    expect(verifySharedGenerationApplication).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({ ok: true, appliedSessionCount: 2, failedSessionCount: 0 });
  });

  it('does not let obsolete receipt persistence failure overturn an exact provider application', async () => {
    const verifySharedGenerationApplication = vi.fn(async () => null);
    const applyCommittedGeneration = vi.fn(async () => converged(manualGeneration));
    const obsoleteReceiptPersistence = {
      recordSharedApplicationReceipt: vi.fn(async () => {
        throw new Error('metadata unavailable');
      }),
    };
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      ...obsoleteReceiptPersistence,
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{
        sessionId: 'a',
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'claude',
      }],
      verifySharedGenerationApplication,
      applyCommittedGeneration,
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    expect(verifySharedGenerationApplication).toHaveBeenCalledOnce();
    expect(applyCommittedGeneration).toHaveBeenCalledOnce();
    expect(obsoleteReceiptPersistence.recordSharedApplicationReceipt).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.appliedSessionCount).toBe(1);
  });

  it('single-flights concurrent duplicate deliveries for the same exact shared epoch', async () => {
    const gate = deferred();
    const applyCommittedGeneration = vi.fn(async () => await gate.promise);
    const verifySharedGenerationApplication = vi.fn(async () => null);
    const buildInput = (sessionId: string) => ({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure' as const,
      executionAuthority: 'runtime_recovery' as const,
      targets: [{
        sessionId,
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'claude',
      }],
      verifySharedGenerationApplication,
      applyCommittedGeneration,
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    const first = applyConnectedServiceAuthGroupGenerationToSessions(buildInput('a'));
    const second = applyConnectedServiceAuthGroupGenerationToSessions(buildInput('b'));
    await vi.waitFor(() => expect(applyCommittedGeneration).toHaveBeenCalledTimes(1));
    gate.resolve(converged(manualGeneration));
    const results = await Promise.all([first, second]);

    expect(verifySharedGenerationApplication).toHaveBeenCalledTimes(1);
    expect(applyCommittedGeneration).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.appliedSessionCount)).toEqual([1, 1]);
  });

  it('fails shared scopes locally before provider mechanics when exact verification wiring is absent', async () => {
    const applyCommittedGeneration = vi.fn(async () => converged(manualGeneration));
    const pending: string[] = [];
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{
        sessionId: 'a',
        fromProfileId: 'old',
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'claude',
      }],
      applyCommittedGeneration,
      recordPendingGeneration: async ({ sessionId }) => { pending.push(sessionId); },
      clearAdoptedGeneration: async () => {},
    });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(pending).toEqual([]);
    expect(result.resultsBySessionId?.a).toMatchObject({
      reconciliationDisposition: 'failed',
      errorCode: 'shared_application_verification_wiring_missing',
      pendingRecorded: false,
    });
  });

  it('reports local non-convergence when redistribution reaches its bound', async () => {
    const initial = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-1',
      provenance: 'hard_limit',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'profile-1',
        generation: 1,
        credentialRevision,
      },
    });

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: initial,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      targets: [{ sessionId: 'session-1', fromProfileId: 'source' }],
      applyCommittedGeneration: async ({ committedGeneration }) => {
        const generation = committedGeneration.decisionCommittedTarget.generation + 1;
        return {
          reconciliationDisposition: 'superseded_after_apply',
          errorCode: null,
          authoritativeGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
            decisionId: `decision-${generation}`,
            provenance: 'reconciliation',
            decisionCommittedTarget: {
              serviceId: 'openai-codex',
              groupId: 'team',
              profileId: `profile-${generation}`,
              generation,
              credentialRevision,
            },
          }),
        };
      },
      recordPendingGeneration: async () => {
        throw new Error('disk unavailable');
      },
      clearAdoptedGeneration: async () => {},
    });

    expect(result.resultsBySessionId?.['session-1']).toEqual({
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: 'generation_redistribution_limit_reached',
      pendingRecorded: false,
    });
    expect(result.failures).toEqual([{
      sessionId: 'session-1',
      errorCode: 'generation_redistribution_limit_reached',
    }]);
  });
  it('fans out to sessions in parallel instead of serializing turn-boundary deferrals', async () => {
    // Live incident 2026-07-10: the sequential loop meant N mid-turn sessions cost N × the 60s
    // deferral window, guaranteeing the client ack aborted and the UI reported divergence on every
    // pool switch. Sessions are independent (per-session FSM locks); the fan-out must overlap them.
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [
        { sessionId: 'sess_1', fromProfileId: 'prev' },
        { sessionId: 'sess_2', fromProfileId: null },
      ],
      applyCommittedGeneration: async (input) => {
        started.push(input.sessionId);
        return input.sessionId === 'sess_1' ? first.promise : second.promise;
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    // Both applies must have STARTED before either resolves — the sequential shape never starts
    // the second until the first settles.
    await Promise.resolve();
    expect(started.sort()).toEqual(['sess_1', 'sess_2']);

    first.resolve(converged(manualGeneration));
    second.resolve(converged(manualGeneration));
    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      appliedSessionCount: 2,
      restartRequestedSessionCount: 0,
      skippedIdleSessionCount: 0,
      failedSessionCount: 0,
      failures: [],
    });
  });

  it('does not start provider apply or durable failure writes when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const applyCommittedGeneration = vi.fn(async () => converged(manualGeneration));
    const recordPendingGeneration = vi.fn(async () => {});
    const clearAdoptedGeneration = vi.fn(async () => {});

    await expect(applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: [{ sessionId: 'session-1', fromProfileId: null }],
      applyCommittedGeneration,
      recordPendingGeneration,
      clearAdoptedGeneration,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(applyCommittedGeneration).not.toHaveBeenCalled();
    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(clearAdoptedGeneration).not.toHaveBeenCalled();
  });

  it('joins an in-flight provider apply but starts no persistence after abort', async () => {
    const controller = new AbortController();
    const apply = deferred();
    const recordPendingGeneration = vi.fn(async () => {});
    const clearAdoptedGeneration = vi.fn(async () => {});
    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: [
        { sessionId: 'session-1', fromProfileId: null },
        { sessionId: 'session-2', fromProfileId: null },
        { sessionId: 'session-3', fromProfileId: null },
        { sessionId: 'session-4', fromProfileId: null },
        { sessionId: 'session-queued', fromProfileId: null },
      ],
      applyCommittedGeneration: vi.fn(async () => await apply.promise),
      recordPendingGeneration,
      clearAdoptedGeneration,
    });

    await Promise.resolve();
    controller.abort();
    apply.resolve(converged(manualGeneration));

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(recordPendingGeneration).not.toHaveBeenCalled();
    expect(clearAdoptedGeneration).not.toHaveBeenCalled();
  });

  it('does not clear adoption when abort arrives after provider success', async () => {
    const controller = new AbortController();
    const clearAdoptedGeneration = vi.fn(async () => {});

    await expect(applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: [{
        sessionId: 'session-1',
        fromProfileId: null,
        applicationScope: 'shared_group_auth_surface',
        applicationOwnerId: 'shared-owner',
      }],
      applyCommittedGeneration: async () => {
        controller.abort();
        return converged(manualGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration,
      ...sharedVerificationDeps(),
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(clearAdoptedGeneration).not.toHaveBeenCalled();
  });

  it('stops shared sibling expansion when abort follows the representative clear', async () => {
    const controller = new AbortController();
    const cleared: string[] = [];
    const resultPromise = applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'automatic_runtime_failure',
      executionAuthority: 'runtime_recovery',
      signal: controller.signal,
      targets: ['representative', 'sibling-1', 'sibling-2'].map((sessionId) => ({
        sessionId,
        fromProfileId: null,
        applicationScope: 'shared_group_auth_surface' as const,
        applicationOwnerId: 'shared-owner',
      })),
      applyCommittedGeneration: async () => converged(manualGeneration),
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async ({ sessionId }) => {
        cleared.push(sessionId);
        if (sessionId === 'representative') controller.abort();
      },
      ...sharedVerificationDeps(),
    });

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cleared).toEqual(['representative']);
  });

  it('records per-session failures without aborting the other sessions', async () => {
    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets: [
        { sessionId: 'sess_ok', fromProfileId: null },
        { sessionId: 'sess_fail', fromProfileId: null },
        { sessionId: 'sess_throw', fromProfileId: null },
      ],
      applyCommittedGeneration: async (input) => {
        if (input.sessionId === 'sess_fail') return { reconciliationDisposition: 'failed', errorCode: 'restart_failed' };
        if (input.sessionId === 'sess_throw') throw new Error('boom');
        return converged(manualGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.appliedSessionCount).toBe(1);
    expect(result.failedSessionCount).toBe(2);
    expect(result.failures).toEqual(expect.arrayContaining([
      { sessionId: 'sess_fail', errorCode: 'restart_failed' },
      { sessionId: 'sess_throw', errorCode: 'apply_generation_threw' },
    ]));
  });

  it('bounds fan-out concurrency so a large pool cannot thundering-herd restarts', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const targets = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `sess_${index}`,
      fromProfileId: null,
    }));

    const result = await applyConnectedServiceAuthGroupGenerationToSessions({
      committedGeneration: manualGeneration,
      switchReason: 'manual',
      executionAuthority: 'fresh_user_action',
      targets,
      applyCommittedGeneration: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return converged(manualGeneration);
      },
      recordPendingGeneration: async () => {},
      clearAdoptedGeneration: async () => {},
    });

    expect(result.appliedSessionCount).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
