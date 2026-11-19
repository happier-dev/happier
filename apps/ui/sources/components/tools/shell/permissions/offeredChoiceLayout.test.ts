import { describe, expect, it } from 'vitest';

import { selectPrimaryPermissionChoice } from '@/sync/ops/sessionPermissionChoices';

import type { OfferedPermissionChoice } from './offeredChoiceLayout';

function choice(
  id: string,
  decision: OfferedPermissionChoice['decision'],
  scope: OfferedPermissionChoice['scope'],
  allowed = true,
): OfferedPermissionChoice {
  return {
    id,
    label: id,
    decision,
    scope,
    response: { nativeChoice: { requirementId: 'r', choiceId: id } },
    ...(allowed
      ? {}
      : {
          availability: {
            choiceId: id,
            allowed: false,
            reason: 'owner_required' as const,
          },
        }),
  };
}

describe('offered choice layout rules', () => {
  it('makes the narrowest-scope allow primary, whatever its place in the agent order', () => {
    expect(
      selectPrimaryPermissionChoice([
        choice('always', 'approved', 'localPersistent'),
        choice('session', 'approved_for_session', 'session'),
        choice('once', 'approved', 'once'),
        choice('reject', 'denied', 'once'),
      ]),
    ).toBe('once');
    expect(
      selectPrimaryPermissionChoice([
        choice('session', 'approved_for_session', 'session'),
        choice('always', 'approved', 'localPersistent'),
      ]),
    ).toBe('session');
  });

  it('never makes a refusal or a choice the viewer cannot take primary', () => {
    expect(
      selectPrimaryPermissionChoice([
        choice('stop', 'abort', 'once'),
        choice('always', 'approved', 'localPersistent', false),
        choice('session', 'approved_for_session', 'session'),
      ]),
    ).toBe('session');
    expect(
      selectPrimaryPermissionChoice([choice('reject', 'denied', 'once')]),
    ).toBeNull();
  });

});
