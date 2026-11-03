import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { resolveSpokenActionOutcome } from './spokenActionOutcome';

describe('spoken Action owner outcomes', () => {
  it.each([
    { t: 'approval_request_decide', args: { artifactId: 'request-1', decision: 'approve' } },
    { t: 'action_execute', args: { actionId: 'approval.request.decide', input: { artifactId: 'request-1', decision: 'approve' } } },
    { t: 'settings_set', args: { anchor: 'voiceConversations.verbosity', value: 'short' } },
    { t: 'action_execute', args: { actionId: 'settings.set', input: { anchor: 'voiceConversations.verbosity', value: 'short' } } },
  ])('describes a canceled operation without asserting a request disposition: $t $args.actionId', action => {
    expect(resolveSpokenActionOutcome({ ...action,
      result: { ok: false, errorCode: 'cancelled', error: 'cancelled' },
    })).toBe(t('voiceSurface.actionCanceled'));
  });

  it.each([false, true])('preserves a confirmed canceled request disposition (envelope=%s)', envelope => {
    const input = { artifactId: 'request-1', decision: 'cancel' };
    const result = { status: 'canceled' };
    expect(resolveSpokenActionOutcome({
      t: envelope ? 'action_execute' : 'approval_request_decide',
      args: envelope ? { actionId: 'approval.request.decide', input } : input,
      result: envelope ? { ok: true, result } : { ok: true, ...result },
    })).toBe(t('approvals.status.canceled'));
  });

  it.each([
    { t: 'approval_request_decide', args: { artifactId: 'request-1', decision: 'approve' } },
    { t: 'action_execute', args: { actionId: 'approval.request.decide', input: { artifactId: 'request-1', decision: 'approve' } } },
  ])('explains a present-user refusal without claiming a lookup or decision failed: $t', action => {
    expect(resolveSpokenActionOutcome({ ...action,
      result: { ok: false, errorCode: 'present_user_required', error: 'present_user_required' },
    })).toBe(t('voiceSurface.approvalTapRequired'));
  });
});
