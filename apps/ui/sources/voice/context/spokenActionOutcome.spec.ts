import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { resolveSpokenActionOutcome } from './spokenActionOutcome';

describe('spoken Action owner outcomes', () => {
  it.each([false, true])('reports only admission for an asynchronous send (envelope=%s)', envelope => {
    const input = { message: 'Write a file', reply: 'none' };
    const result = { status: 'accepted', localId: 'message-1' };
    expect(resolveSpokenActionOutcome({ t: envelope ? 'action_execute' : 'sendSessionMessage',
      args: envelope ? { actionId: 'session.message.send', input } : input,
      result: envelope ? { ok: true, result } : { ok: true, ...result },
    })).toBe(t('session.askRecord.sent'));
  });

  it.each(['wait', 'return'])('leaves requested answers with the reply owner (reply=%s)', reply => {
    expect(resolveSpokenActionOutcome({ t: 'sendSessionMessage', args: { message: 'Answer me', reply },
      result: { ok: true, status: 'accepted', localId: 'message-1' },
    })).toBeNull();
  });

  it('does not turn unknown send custody into delivery or approval', () => {
    expect(resolveSpokenActionOutcome({ t: 'sendSessionMessage', args: { message: 'Write a file' },
      result: { ok: true, status: 'outcomeUnknown', localId: 'message-1', code: 'session_input_pending' },
    })).toBe(t('session.askRecord.unsure'));
  });

  it('reports a fanout as sent only when every destination accepted it', () => {
    const accepted = { target: { serverId: 'home', sessionId: 'worker' },
      result: { ok: true, result: { status: 'accepted', localId: 'message-1' } } };
    const unknown = { target: { serverId: 'home', sessionId: 'other' },
      result: { ok: true, result: { status: 'outcomeUnknown', localId: 'message-2', code: 'session_input_pending' } } };
    const entry = { t: 'sendSessionMessage', args: { message: 'Write a file' } };
    expect(resolveSpokenActionOutcome({ ...entry,
      result: { ok: true, kind: 'fanout', results: [accepted] },
    })).toBe(t('session.askRecord.sent'));
    expect(resolveSpokenActionOutcome({ ...entry,
      result: { ok: true, kind: 'fanout', results: [accepted, unknown] },
    })).toBe(t('session.askRecord.unsure'));
  });

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
