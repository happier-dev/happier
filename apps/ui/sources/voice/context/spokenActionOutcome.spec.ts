import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { resolveSpokenActionOutcome } from './spokenActionOutcome';

describe('spoken Action owner outcomes', () => {
  it.each([
    { t: 'approval_request_decide', args: { artifactId: 'request-1', decision: 'approve' } },
    { t: 'action_execute', args: { actionId: 'approval.request.decide', input: { artifactId: 'request-1', decision: 'approve' } } },
  ])('explains a present-user refusal without claiming a lookup or decision failed: $t', action => {
    expect(resolveSpokenActionOutcome({ ...action,
      result: { ok: false, errorCode: 'present_user_required', error: 'present_user_required' },
    })).toBe(t('voiceSurface.approvalTapRequired'));
  });
});
