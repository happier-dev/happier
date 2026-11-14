import { describe, expect, it } from 'vitest';

import {
  isPendingDeliveryProviderEffectPossibleV1,
  isPendingDeliveryStatusTransitionAllowedV1,
  normalizePendingDeliveryStatusV1,
  parsePendingDeliveryStatusV1,
  PendingDeliveryFailureV1Schema,
  projectPendingDeliveryFailureCauseV1,
  pendingDeliveryStatusV1ToPersistedFields,
  shouldExposePendingDeliveryInDiscardedHistoryV1,
  type PendingDeliveryStatusV1,
} from './pendingDeliveryStatusV1.js';

describe('PendingDeliveryStatusV1', () => {
  it('preserves authoritative target unavailability as a pre-effect block', () => {
    const status = normalizePendingDeliveryStatusV1({ status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'session_input_target_unavailable' });
    expect(status).toEqual({ status: 'blocked', reason: 'session_input_target_unavailable' });
    expect(isPendingDeliveryProviderEffectPossibleV1(status)).toBe(false);
  });
  it('round-trips typed delivery statuses through existing persisted fields', () => {
    const statuses = [
      { status: 'queued' },
      { status: 'delivering', detail: 'awaiting_acceptance' },
      { status: 'external_handoff' },
      { status: 'blocked', reason: 'runtime_config_blocked' },
      { status: 'discarded', reason: 'manual' },
      { status: 'discarded', reason: null },
    ] as const;

    for (const status of statuses) {
      expect(normalizePendingDeliveryStatusV1(pendingDeliveryStatusV1ToPersistedFields(status))).toEqual(status);
      expect(parsePendingDeliveryStatusV1(status)).toEqual(status);
    }
  });

  it('normalizes malformed persisted fields fail-closed over legacy raw columns', () => {
    expect(normalizePendingDeliveryStatusV1({ status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future' }))
      .toEqual({ status: 'blocked', reason: 'unknown' });
    expect(normalizePendingDeliveryStatusV1({ status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: 'payload_too_large' }))
      .toEqual({ status: 'delivering', detail: 'awaiting_acceptance' });
    expect(normalizePendingDeliveryStatusV1({ status: 'unknown', deliveryState: 'blocked', deliveryBlockedReason: 'payload_too_large' }))
      .toEqual({ status: 'queued' });
    expect(normalizePendingDeliveryStatusV1({
      status: 'queued',
      deliveryState: 'blocked',
      deliveryBlockedReason: 'provider_acceptance_timeout',
    })).toEqual({ status: 'blocked', reason: 'unknown' });
  });

  it('reads additive delivering detail while preserving old and unknown projections', () => {
    expect(parsePendingDeliveryStatusV1({ status: 'delivering' })).toEqual({ status: 'delivering' });
    expect(parsePendingDeliveryStatusV1({ status: 'delivering', detail: 'custody_observed' })).toEqual({
      status: 'delivering',
      detail: 'custody_observed',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'delivering', detail: 'awaiting_acceptance' })).toEqual({
      status: 'delivering',
      detail: 'awaiting_acceptance',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'delivering', detail: 'future_detail' })).toEqual({
      status: 'delivering',
    });
  });

  it('keeps custody detail descriptive instead of persisting it as delivery authority', () => {
    const persisted = pendingDeliveryStatusV1ToPersistedFields({
      status: 'delivering',
      detail: 'custody_observed',
    });

    expect(persisted).toEqual({
      status: 'queued',
      deliveryState: 'delivering',
      deliveryBlockedReason: null,
      discardedReason: null,
    });
    expect(normalizePendingDeliveryStatusV1(persisted)).toEqual({
      status: 'delivering',
      detail: 'awaiting_acceptance',
    });
  });

  it('allows direct provider acceptance from live custody and archived uncertainty but never queued', () => {
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'delivering' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'delivering', detail: 'custody_observed' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'external_handoff' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'blocked', reason: 'delivery_outcome_uncertain' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'queued' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(false);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'discarded', reason: 'dismissed_uncertain' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'discarded', reason: 'resent_as_new' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'discarded', reason: 'manual' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(false);
  });

  it('keeps archived uncertainty non-restorable', () => {
    for (const reason of ['dismissed_uncertain', 'resent_as_new'] as const) {
      expect(isPendingDeliveryStatusTransitionAllowedV1(
        { status: 'discarded', reason },
        { status: 'queued' },
      )).toBe(false);
    }
  });

  it.each([
    [{ status: 'discarded', reason: 'resent_as_new' }, false],
    [{ status: 'discarded', reason: 'session_input_muted' }, false],
    [{ status: 'discarded', reason: 'dismissed_uncertain' }, true],
    [{ status: 'discarded', reason: 'manual' }, true],
    [{ status: 'discarded', reason: null }, true],
    [{ status: 'queued' }, false],
  ] satisfies readonly (readonly [PendingDeliveryStatusV1, boolean])[])(
    'classifies %# discarded-history visibility',
    (status, visible) => {
      expect(shouldExposePendingDeliveryInDiscardedHistoryV1(status)).toBe(visible);
    },
  );

  it.each([
    [{ status: 'queued' }, false],
    [{ status: 'delivering' }, true],
    [{ status: 'delivering', detail: 'custody_observed' }, true],
    [{ status: 'delivering', detail: 'awaiting_acceptance' }, true],
    [{ status: 'external_handoff' }, true],
    [{ status: 'blocked', reason: 'ambiguous_terminal_delivery' }, true],
    [{ status: 'blocked', reason: 'delivery_outcome_uncertain' }, true],
    [{ status: 'blocked', reason: 'unknown' }, true],
    [{ status: 'blocked', reason: 'provider_rejected_before_acceptance' }, false],
    [{ status: 'blocked', reason: 'provider_unavailable_before_acceptance' }, false],
    [{ status: 'discarded', reason: null }, false],
  ] satisfies readonly (readonly [PendingDeliveryStatusV1, boolean])[])(
    'classifies %# provider-effect possibility',
    (status, possible) => {
      expect(isPendingDeliveryProviderEffectPossibleV1(status)).toBe(possible);
    },
  );

});

describe('PendingDeliveryFailureV1 cause', () => {
  const launchError = { kind: 'launch_error', code: 'CHILD_EXITED_BEFORE_WEBHOOK',
    message: 'Runner exited in /home/alice/private-repo', rpcErrorCode: 'RPC_OUTCOME_UNKNOWN',
    childExit: { code: 1, signal: null, stderrHead: 'Error: cannot read /home/alice/private-repo/.env',
      cause: { kind: 'module_not_found', specifierBasename: 'secret-module' } },
    spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE', nativeErrno: -24, cwd: '/home/alice/private-repo' },
    failureCause: { code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
      failureReason: 'model_selection_required', retryable: false, providerErrorCode: 'model_not_found',
      providerErrorMessage: 'Model gpt-x is not available for /home/alice' },
    profileRefusal: { profileId: 'work-profile', reason: 'profile_resume_unavailable' },
    uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity',
      source: 'spawn_resume', agentId: 'gemini', retryable: false, suggestedActions: ['resume_current_account'],
      diagnostics: { note: 'session at ~/private-repo' } },
  } as const;

  it('projects a full local spawn detail into typed fields only', () => {
    const cause = projectPendingDeliveryFailureCauseV1(launchError);
    expect(cause).toEqual({ kind: 'launch_error', code: 'CHILD_EXITED_BEFORE_WEBHOOK', rpcErrorCode: 'RPC_OUTCOME_UNKNOWN',
      childExit: { code: 1, signal: null },
      spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE' },
      failureCause: { code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
        failureReason: 'model_selection_required', retryable: false, providerErrorCode: 'model_not_found' },
      uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity',
        source: 'spawn_resume', retryable: false, suggestedActions: ['resume_current_account'] } });
    expect(JSON.stringify(cause)).not.toMatch(/alice|private-repo|secret-module|work-profile|gpt-x/u);
    expect(PendingDeliveryFailureV1Schema.parse({ code: 'resume_failed', errorDetail: cause }))
      .toEqual({ code: 'resume_failed', errorDetail: cause });
    expect(projectPendingDeliveryFailureCauseV1({ kind: 'spawn_failure', reason: 'process_limit', errno: 'EAGAIN',
      cwd: '/home/alice/private-repo' })).toEqual({ kind: 'spawn_failure', reason: 'process_limit', errno: 'EAGAIN' });
    expect(projectPendingDeliveryFailureCauseV1({ kind: 'connected_service_resume_unreachable',
      continuityErrorCode: 'provider_session_state_unavailable_for_resume', failurePhase: 'continuity', agentId: 'gemini',
      reason: 'gemini_resume_unreachable', uxDiagnostic: launchError.uxDiagnostic }))
      .toEqual({ kind: 'connected_service_resume_unreachable', uxDiagnostic: { code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity', source: 'spawn_resume', retryable: false, suggestedActions: ['resume_current_account'] } });
    expect(projectPendingDeliveryFailureCauseV1({ kind: 'launch_retired', spawnNonce: 'nonce', wrapperPid: 7 }))
      .toEqual({ kind: 'launch_retired' });
  });

  it.each([
    { kind: 'launch_error', code: 'spawn_failed', message: 'free text' },
    { kind: 'launch_error', code: 'spawn_failed', childExit: { code: 1, signal: null, stderrHead: 'stderr' } },
    { kind: 'launch_error', code: 'spawn_failed', spawnFailure: { reason: 'other', cwd: '/home/alice' } },
    { kind: 'launch_error', code: 'spawn_failed', uxDiagnostic: { ...launchError.uxDiagnostic } },
    { kind: 'launch_error', code: 'spawn_failed', failureCause: { phase: 'turn', failureReason: 'unknown', providerErrorMessage: 'x' } },
    { kind: 'launch_retired', spawnNonce: 'nonce' },
    { kind: 'not_a_kind' },
  ])('rejects a cause carrying free text or unknown fields (%j)', errorDetail => {
    expect(PendingDeliveryFailureV1Schema.safeParse({ code: 'resume_failed', errorDetail }).success).toBe(false);
  });
});
