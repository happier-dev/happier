import { describe, expect, it } from 'vitest';

import { evaluatePermissionResponseAuthorityV1 } from './index.js';

describe('permission response durable grant authority', () => {
  it.each([
    { nativeScope: 'localPersistent' as const, response: {} },
    { response: { execPolicyAmendment: { command: ['echo', 'hi'] } } },
    { response: { updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] } },
    { response: { allowedTools: ['Bash'] } },
    { response: { allowTools: ['Bash'] } },
    { response: { mode: 'acceptEdits' as const } },
  ])('admits every durable carrier only for the attributed owner: %j', request => {
    for (const relationship of ['sharedApprover', null, undefined] as const) {
      expect(evaluatePermissionResponseAuthorityV1({ ...request, relationship }))
        .toEqual({ allowed: false, reason: 'owner_required' });
    }
    expect(evaluatePermissionResponseAuthorityV1({ ...request, relationship: 'owner' }))
      .toEqual({ allowed: true });
  });

  it.each(['once', 'session'] as const)('preserves shared approver decisions with %s scope and no durable carrier', nativeScope => {
    expect(evaluatePermissionResponseAuthorityV1({ response: {}, nativeScope, relationship: 'sharedApprover' }))
      .toEqual({ allowed: true });
  });
});
