import { describe, expect, it, vi } from 'vitest';

import { createSessionProviderInputOutcomeNormalizer } from './providerInputOutcome';

describe('createSessionProviderInputOutcomeNormalizer', () => {
  it('does not settle Pending or a correlated Follow effect from legacy provider_accepted evidence', () => {
    const observeSettlement = vi.fn();
    const observeAcceptedEffect = vi.fn();
    const observePending = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'pending-local',
        observeProviderInputSettlement: observeSettlement,
      }),
      observeAcceptedEffect,
    });
    const observeFollowEffect = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => false,
        observeProviderInputSettlement: observeSettlement,
      }),
      observeAcceptedEffect,
    });

    // Exercise a stale compiled host caller after the type-level direct cut.
    observePending({
      type: 'provider_accepted',
      localId: 'pending-local',
      userMessageSeq: 41,
    } as never);
    observeFollowEffect({
      type: 'provider_accepted',
      localId: 'session-follow-wake:exact',
      userMessageSeq: null,
    } as never);

    expect(observeSettlement).not.toHaveBeenCalled();
    expect(observeAcceptedEffect).not.toHaveBeenCalled();
  });

  it('fans exact acceptance out to Pending and one correlated host effect', () => {
    const observeSettlement = vi.fn();
    const observeAcceptedEffect = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'accepted-local',
        observeProviderInputSettlement: observeSettlement,
      }),
      observeAcceptedEffect,
    });

    observe({
      type: 'input-accepted',
      localId: 'accepted-local',
      userMessageSeq: 41,
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
      acceptedAtMs: 1234,
    });
    observe({
      type: 'input-accepted',
      localId: 'accepted-local',
      userMessageSeq: 41,
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });

    expect(observeSettlement).toHaveBeenCalledOnce();
    expect(observeSettlement).toHaveBeenCalledWith(expect.objectContaining({ acceptedAtMs: 1234,
      providerTurnId: 'turn-1', providerDeliveryKind: 'newTurn' }));
    expect(observeAcceptedEffect).toHaveBeenCalledExactlyOnceWith('accepted-local');
  });

  it('does not settle exact acceptance without a nonblank provider delivery turn id', () => {
    const observeSettlement = vi.fn();
    const observeAcceptedEffect = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: observeSettlement,
      }),
      observeAcceptedEffect,
    });

    observe({
      type: 'input-accepted',
      localId: 'accepted-local',
      userMessageSeq: 41,
      delivery: { kind: 'newTurn', turnId: '   ' },
    });

    expect(observeSettlement).not.toHaveBeenCalled();
    expect(observeAcceptedEffect).not.toHaveBeenCalled();
  });

  it('settles only the exact registered non-Pending host effect after provider acceptance', () => {
    const observeSettlement = vi.fn();
    const wakeEffect = vi.fn();
    const rejectedEffect = vi.fn();
    const registeredEffects = new Map<string, () => void>([
      ['session-follow-wake:exact', wakeEffect],
      ['session-follow-wake:rejected', rejectedEffect],
    ]);
    const observeAcceptedEffect = vi.fn((localId: string) => {
      const effect = registeredEffects.get(localId);
      if (!effect) return;
      registeredEffects.delete(localId);
      effect();
    });
    const discardAcceptedEffect = vi.fn((localId: string) => {
      registeredEffects.delete(localId);
    });
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => false,
        observeProviderInputSettlement: observeSettlement,
      }),
      observeAcceptedEffect,
      discardAcceptedEffect,
    });

    observe({
      type: 'input-rejected',
      localId: 'session-follow-wake:rejected',
      userMessageSeq: null,
      diagnostic: { code: 'rejected', severity: 'error' },
      retryable: false,
    });
    observe({
      type: 'input-accepted',
      localId: 'arbitrary-local-input',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-arbitrary' },
    });
    observe({
      type: 'input-accepted',
      localId: 'session-follow-wake:exact',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-wake' },
    });
    observe({
      type: 'input-accepted',
      localId: 'session-follow-wake:exact',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-wake-duplicate' },
    });

    expect(observeSettlement).not.toHaveBeenCalled();
    expect(discardAcceptedEffect).toHaveBeenCalledExactlyOnceWith('session-follow-wake:rejected');
    expect(rejectedEffect).not.toHaveBeenCalled();
    expect(wakeEffect).toHaveBeenCalledOnce();
    expect(observeAcceptedEffect).toHaveBeenCalledTimes(3);
  });

  it('does not let a failing Pending observer suppress the same authoritative acceptance effect', () => {
    const observeAcceptedEffect = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: () => {
          throw new Error('pending observer failed');
        },
      }),
      observeAcceptedEffect,
    });

    expect(() => observe({
      type: 'input-accepted',
      localId: 'accepted-local',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-accepted' },
    })).toThrow('pending observer failed');
    expect(observeAcceptedEffect).toHaveBeenCalledExactlyOnceWith('accepted-local');
  });

  it('discards a correlated host effect only on proven pre-effect rejection', () => {
    const discardEffect = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: vi.fn(),
      }),
      discardAcceptedEffect: discardEffect,
    });

    observe({
      type: 'possible_write',
      localId: 'uncertain-local',
      userMessageSeq: null,
      reason: 'provider response was ambiguous',
    });
    observe({
      type: 'rejected_before_write',
      localId: 'rejected-local',
      userMessageSeq: null,
      reason: 'provider_rejected_before_acceptance',
    });

    expect(discardEffect).toHaveBeenCalledExactlyOnceWith('rejected-local');
  });

  it('retains a correlated host effect across a reversible block for later acceptance', () => {
    const discardEffect = vi.fn();
    const observeAcceptedEffect = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: vi.fn(),
      }),
      discardAcceptedEffect: discardEffect,
      observeAcceptedEffect,
    });

    observe({
      type: 'rejected_before_write',
      localId: 'blocked-local',
      userMessageSeq: null,
      reason: 'runtime_config_blocked',
    });
    observe({
      type: 'input-accepted',
      localId: 'blocked-local',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-blocked' },
    });

    expect(discardEffect).not.toHaveBeenCalled();
    expect(observeAcceptedEffect).toHaveBeenCalledExactlyOnceWith('blocked-local');
  });

  it('normalizes host-local identity fields without changing opaque localId bytes', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === ' opaque-local-id ',
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'possible_write',
      localInputIds: [' opaque-local-id '],
      userMessageSeq: null,
      reason: 'provider response was ambiguous',
    });

    expect(observeSettlement).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'effect_may_have_occurred',
      localId: ' opaque-local-id ',
    }));
  });

  it('normalizes exact singleton outcomes and keeps acceptance terminal after a later provider failure', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'local-1',
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'input-accepted',
      localId: 'local-1',
      userMessageSeq: 41,
      userMessageSeqs: [41],
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    observe({
      type: 'input-delivery-failed',
      localId: 'local-1',
      userMessageSeq: 41,
      userMessageSeqs: [41],
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
      issue: { code: 'later_failure', severity: 'error' },
      duplicateRisk: 'possible',
    });

    expect(observeSettlement).toHaveBeenCalledTimes(1);
    expect(observeSettlement).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'local-1',
      userMessageSeq: 41,
      userMessageSeqs: [41],
      providerTurnId: 'turn-1',
      providerDeliveryKind: 'newTurn',
    });
  });

  it('joins the dispatch-time structured model snapshot only to exact provider acceptance', () => {
    const observeSettlement = vi.fn();
    const takeAppliedModel = vi.fn(() => ({
      provider: 'codex',
      selection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'gpt-5.6-terra',
      },
    }));
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: observeSettlement,
      }),
      takeAppliedModel,
    });

    observe({
      type: 'input-accepted',
      localInputId: 'accepted-local',
      userMessageSeq: 41,
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });

    expect(takeAppliedModel).toHaveBeenCalledWith('accepted-local');
    expect(observeSettlement).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'accepted',
      localId: 'accepted-local',
      appliedModel: {
        provider: 'codex',
        selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5.6-terra',
        },
      },
    }));
  });

  it('accepts the Plugin SDK exact outcome field without a host-side identity rename', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'sdk-local-1',
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'input-accepted',
      localInputId: 'sdk-local-1',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-sdk-1' },
    });

    expect(observeSettlement).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'accepted',
      localId: 'sdk-local-1',
      providerTurnId: 'turn-sdk-1',
    }));
  });

  it('keeps custody nonterminal, persists ambiguity, and accepts later exact evidence', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'custody_observed',
      localIds: ['local-1'],
      userMessageSeq: 12,
      userMessageSeqs: [12],
    });
    expect(observeSettlement).not.toHaveBeenCalled();

    observe({
      type: 'possible_write',
      localIds: ['local-1'],
      userMessageSeq: 12,
      userMessageSeqs: [12],
      reason: 'terminal result was not observable',
    });
    observe({
      type: 'input-accepted',
      localId: 'local-1',
      userMessageSeq: 12,
      userMessageSeqs: [12],
      delivery: { kind: 'newTurn', turnId: 'turn-local-1' },
    });

    expect(observeSettlement.mock.calls).toEqual([
      [{
        kind: 'effect_may_have_occurred',
        localId: 'local-1',
        userMessageSeq: 12,
        userMessageSeqs: [12],
        issue: { code: 'terminal result was not observable', severity: 'error' },
        detail: 'terminal result was not observable',
      }],
      [{
        kind: 'accepted',
        localId: 'local-1',
        userMessageSeq: 12,
        userMessageSeqs: [12],
        providerTurnId: 'turn-local-1',
        providerDeliveryKind: 'newTurn',
      }],
    ]);
  });

  it('does not downgrade adapter-reported ambiguity when a later generic host rejection arrives', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'ambiguous-steer',
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'input-custody-unknown',
      localInputId: 'ambiguous-steer',
      userMessageSeq: 27,
      userMessageSeqs: [27],
      issue: { code: 'provider_response_lost', severity: 'error' },
    });
    observe({
      type: 'rejected_before_write',
      localIds: ['ambiguous-steer'],
      userMessageSeq: 27,
      userMessageSeqs: [27],
      reason: 'generic_host_throw',
    });

    expect(observeSettlement).toHaveBeenCalledTimes(1);
    expect(observeSettlement).toHaveBeenCalledWith({
      kind: 'effect_may_have_occurred',
      localId: 'ambiguous-steer',
      userMessageSeq: 27,
      userMessageSeqs: [27],
      issue: { code: 'provider_response_lost', severity: 'error' },
    });
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)('keeps reversible %s blocking nonterminal so exact acceptance can follow', (reason) => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'rejected_before_write',
      localIds: ['same-pending-local'],
      userMessageSeq: 42,
      reason,
    });
    observe({
      type: 'input-accepted',
      localId: 'same-pending-local',
      userMessageSeq: 42,
      delivery: { kind: 'newTurn', turnId: `turn-${reason}` },
    });

    expect(observeSettlement.mock.calls.map(([outcome]) => outcome)).toEqual([
      expect.objectContaining({ kind: 'rejected_before_effect', reason }),
      expect.objectContaining({ kind: 'accepted', localId: 'same-pending-local' }),
    ]);
  });

  it('keeps a provider-reported retryable pre-effect rejection nonterminal for later exact acceptance', () => {
    const observeSettlement = vi.fn();
    const discardAcceptedEffect = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: observeSettlement,
      }),
      discardAcceptedEffect,
    });

    observe({
      type: 'input-rejected',
      localId: 'retryable-native-rejection',
      userMessageSeq: 44,
      diagnostic: { code: 'provider_temporarily_unavailable', severity: 'error' },
      retryable: true,
    });
    observe({
      type: 'input-accepted',
      localId: 'retryable-native-rejection',
      userMessageSeq: 44,
      delivery: { kind: 'newTurn', turnId: 'turn-after-retryable-rejection' },
    });

    expect(observeSettlement.mock.calls.map(([outcome]) => outcome)).toEqual([
      expect.objectContaining({
        kind: 'rejected_before_effect',
        localId: 'retryable-native-rejection',
        retryable: true,
      }),
      expect.objectContaining({
        kind: 'accepted',
        localId: 'retryable-native-rejection',
        providerTurnId: 'turn-after-retryable-rejection',
      }),
    ]);
    expect(discardAcceptedEffect).not.toHaveBeenCalled();
  });

  it('preserves exact pre-provider admission proof on the canonical rejection settlement', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'admission-unavailable-local',
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'input-rejected-before-provider',
      localId: 'admission-unavailable-local',
      userMessageSeq: 42,
      userMessageSeqs: [42],
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: {
        code: 'daemon_turn_admission_unavailable',
        severity: 'error',
      },
      retryable: true,
      retireLocalCustodyAfterDurableBlock: true,
    });

    expect(observeSettlement).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      localId: 'admission-unavailable-local',
      userMessageSeq: 42,
      userMessageSeqs: [42],
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: {
        code: 'daemon_turn_admission_unavailable',
        severity: 'error',
      },
      retryable: true,
      retireLocalCustodyAfterDurableBlock: true,
    });
  });

  it('maps unsupported provider action to an irreversible exact pre-effect rejection', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'rejected_before_write',
      localIds: ['unsupported-action-local'],
      userMessageSeq: 43,
      reason: 'unsupported_action',
    });
    observe({
      type: 'input-accepted',
      localId: 'unsupported-action-local',
      userMessageSeq: 43,
      delivery: { kind: 'newTurn', turnId: 'turn-unsupported-action' },
    });

    expect(observeSettlement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'rejected_before_effect',
      localId: 'unsupported-action-local',
      reason: 'unsupported_action',
    }));
  });

  it('rejects plural or untracked identities without settling', () => {
    const observeSettlement = vi.fn();
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId: 'session-1',
        hasPendingProviderInput: (localId) => localId === 'tracked',
        observeProviderInputSettlement: observeSettlement,
      }),
    });

    observe({
      type: 'possible_write',
      localIds: ['tracked', 'other'],
      userMessageSeq: null,
      reason: 'plural identity cannot settle',
    });
    observe({
      type: 'input-accepted',
      localId: 'untracked',
      userMessageSeq: null,
      delivery: { kind: 'newTurn', turnId: 'turn-untracked' },
    });

    expect(observeSettlement).not.toHaveBeenCalled();
  });

  it('does not carry terminal state across a Happier session swap', () => {
    const observed: Array<Readonly<{ sessionId: string; kind: string }>> = [];
    let sessionId = 'session-1';
    const observe = createSessionProviderInputOutcomeNormalizer({
      getTarget: () => ({
        sessionId,
        hasPendingProviderInput: () => true,
        observeProviderInputSettlement: (outcome) => observed.push({ sessionId, kind: outcome.kind }),
      }),
    });

    const accepted = {
      type: 'input-accepted' as const,
      localId: 'same-local-id',
      userMessageSeq: null,
      delivery: { kind: 'newTurn' as const, turnId: 'turn-same-local-id' },
    };
    observe(accepted);
    sessionId = 'session-2';
    observe(accepted);

    expect(observed).toEqual([
      { sessionId: 'session-1', kind: 'accepted' },
      { sessionId: 'session-2', kind: 'accepted' },
    ]);
  });
});
