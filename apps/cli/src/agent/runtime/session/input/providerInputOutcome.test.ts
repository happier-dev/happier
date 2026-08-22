import { describe, expect, it, vi } from 'vitest';

import { createSessionProviderInputOutcomeNormalizer } from './providerInputOutcome';

describe('createSessionProviderInputOutcomeNormalizer', () => {
  it('normalizes the Plugin SDK legacy identity fields without changing opaque localId bytes', () => {
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
        agentTargetKey: 'backend:codex',
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
          agentTargetKey: 'backend:codex',
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
      type: 'provider_accepted',
      localIds: ['local-1'],
      userMessageSeq: 12,
      userMessageSeqs: [12],
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
      type: 'provider_accepted',
      localIds: ['same-pending-local'],
      userMessageSeq: 42,
    });

    expect(observeSettlement.mock.calls.map(([outcome]) => outcome)).toEqual([
      expect.objectContaining({ kind: 'rejected_before_effect', reason }),
      expect.objectContaining({ kind: 'accepted', localId: 'same-pending-local' }),
    ]);
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
      type: 'provider_accepted',
      localIds: ['unsupported-action-local'],
      userMessageSeq: 43,
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
      type: 'provider_accepted',
      localIds: ['tracked', 'other'],
      userMessageSeq: null,
    });
    observe({
      type: 'provider_accepted',
      localIds: ['untracked'],
      userMessageSeq: null,
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
      type: 'provider_accepted' as const,
      localIds: ['same-local-id'],
      userMessageSeq: null,
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
