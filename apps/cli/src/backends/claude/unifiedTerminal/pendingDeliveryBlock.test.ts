import { describe, expect, it } from 'vitest';

import {
  resolveClaudeUnifiedPendingDeliveryBlock,
  resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker,
} from './pendingDeliveryBlock';
import { ClaudeUnifiedTerminalInjectionFailureError } from './terminalInjectionFailureError';

describe('resolveClaudeUnifiedPendingDeliveryBlock', () => {
  it('does not create pending-delivery authority from elapsed provider-acceptance time', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: ['pending-local-timeout', 'pending-local-timeout', 'pending-local-2'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toBeNull();
  });

  it.each(['host_unreachable', 'verification_failed'] as const)(
    'classifies recoverable after-enter %s ambiguity as ambiguous blocked pending delivery',
    (reason) => {
      const error = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_ambiguous',
        reason,
        phase: 'after_enter_unknown',
        duplicateRisk: 'possible',
        recoverable: true,
        userMessageLocalIds: ['pending-local-visible-after-enter'],
      });

      expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
        localIds: ['pending-local-visible-after-enter'],
        reason: 'ambiguous_terminal_delivery',
      });
    },
  );

  it('does not classify provider acceptance timeouts without pending local ids', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: [],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toBeNull();
  });

  it('preserves deterministic oversized prompt classification', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'payload_too_large',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: true,
      userMessageLocalIds: ['pending-local-too-large'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-too-large'],
      reason: 'payload_too_large',
    });
  });

  it('classifies an exact pre-write steer with no active target as steering unavailable', () => {
    const error = new ClaudeUnifiedTerminalInjectionFailureError({
      batch: {
        message: 'steer this active turn',
        origin: { kind: 'ui_pending' },
        pendingProviderAction: 'steer',
        userMessageLocalIds: ['pending-local-steer'],
      },
      failureState: 'failed_terminal',
      result: {
        status: 'failed',
        reason: 'no_target',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
      },
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-steer'],
      reason: 'steering_unavailable',
    });
  });

  it.each([
    ['possible duplicate risk', { duplicateRisk: 'possible' }],
    ['after-write failure', { phase: 'after_write_before_enter' }],
    ['recoverable failure', { recoverable: true }],
    ['missing pending identity', { userMessageLocalIds: [] }],
    ['missing exact action provenance', { pendingProviderAction: undefined }],
    ['another exact action', { pendingProviderAction: 'interrupt_and_send' }],
  ])('does not reinterpret neighboring no-target failure with %s as steering unavailable', (_label, override) => {
    const error = Object.assign(new Error('Claude unified terminal steer target is unavailable'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'no_target',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: false,
      pendingProviderAction: 'steer',
      userMessageLocalIds: ['pending-local-steer'],
      ...override,
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toBeNull();
  });

  it('classifies host loss after writing a pending prompt as blocked pending delivery', () => {
    const error = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'host_unreachable',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      recoverable: true,
      userMessageLocalIds: ['pending-local-host-lost'],
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
      localIds: ['pending-local-host-lost'],
      reason: 'terminal_host_unreachable',
    });
  });

  it.each(['timeout', 'verification_failed'] as const)(
    'classifies pre-Enter %s after prompt bytes reached the composer as uncertain delivery',
    (reason) => {
      const error = Object.assign(new Error('Claude unified terminal prompt was staged but not submitted'), {
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_ambiguous',
        reason,
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        recoverable: true,
        userMessageLocalIds: ['pending-local-staged'],
      });

      expect(resolveClaudeUnifiedPendingDeliveryBlock(error)).toEqual({
        localIds: ['pending-local-staged'],
        reason: 'delivery_outcome_uncertain',
      });
    },
  );

  it('maps sustained head blockers to retryable pending delivery block reasons', () => {
    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-draft', ' pending-local-draft\n', 'pending-local-draft', 'pending-local-2'],
      blocker: {
        kind: 'terminal_user_draft',
        source: 'draft_guard',
        guardStatus: 'foreign_draft',
        draftLength: 12,
      },
    })).toEqual({
      localIds: ['pending-local-draft', ' pending-local-draft\n', 'pending-local-2'],
      reason: 'terminal_composer_draft',
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-runtime-config'],
      blocker: {
        kind: 'runtime_config_blocked',
        source: 'runtime_control',
        blockedReason: 'user_draft',
      },
    })).toEqual({
      localIds: ['pending-local-runtime-config'],
      reason: 'runtime_config_blocked',
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-provider-unavailable'],
      blocker: {
        kind: 'provider_unavailable',
        source: 'draft_guard',
        detail: 'claude_usage_limit_dialog',
      },
    })).toEqual({
      localIds: ['pending-local-provider-unavailable'],
      reason: 'provider_unavailable_before_acceptance',
    });

    expect(resolveClaudeUnifiedPendingDeliveryBlockForDeliveryBlocker({
      localIds: ['pending-local-dialog'],
      blocker: {
        kind: 'terminal_busy',
        source: 'readiness',
        detail: 'safeguard_pause_dialog',
      },
    })).toEqual({
      localIds: ['pending-local-dialog'],
      reason: 'runtime_config_blocked',
    });
  });
});
