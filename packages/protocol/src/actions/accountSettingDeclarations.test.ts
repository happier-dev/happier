import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { resolveCredentialActionAdmissionV1 } from './decisionAuthority.js';

describe('Account Settings mutation admission', () => {
  it('admits former person-only Settings writes through the ordinary grant and approval policy', () => {
    for (const actionId of [
      'settings.set',
      'settings.reset',
      'settings.invoke',
    ] as const) {
      for (const anchor of [
        'transcript.showToolCalls',
        'delegation.approvalReviewerEnabled',
        'delegation.workDepthLimit',
      ]) {
        expect(
          resolveCredentialActionAdmissionV1({
            spec: getActionSpec(actionId),
            grant: null,
            surface: 'api',
            hasExternalCredential: true,
            authority: 'account_automation',
            actionInput: { anchor },
          }),
          `${actionId}:${anchor}`,
        ).toEqual({ ok: true });
      }
    }
  });
});
