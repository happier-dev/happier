import { describe, expect, it } from 'vitest';

import { readSessionApprovalConsentActionIdV1 } from './sessionApprovalConsentPolicyV1.js';

describe('readSessionApprovalConsentActionIdV1', () => {
  it('names a built-in Action by its own id', () => {
    expect(
      readSessionApprovalConsentActionIdV1({
        actionId: 'deployments.deploy',
        actionArgs: {},
      }),
    ).toBe('deployments.deploy');
  });

  it('names a contributed Action by its qualified id, never the invoke carrier', () => {
    expect(
      readSessionApprovalConsentActionIdV1({
        actionId: 'action.invoke',
        actionArgs: {
          action: { pluginId: 'acme.tools', localId: 'publish' },
          input: {},
        },
      }),
    ).toBe('acme.tools/actions/publish');
    expect(
      readSessionApprovalConsentActionIdV1({
        actionId: 'action.invoke',
        actionArgs: {},
      }),
    ).toBeNull();
  });

  it('offers no Session row where the policy owner decides elsewhere', () => {
    expect(
      readSessionApprovalConsentActionIdV1({
        actionId: 'actions.policy.set',
        actionArgs: {},
      }),
    ).toBeNull();
    expect(
      readSessionApprovalConsentActionIdV1({
        actionId: 'approval.request.list',
        actionArgs: {},
      }),
    ).toBeNull();
  });
});
