import { describe, expect, it } from 'vitest';

import {
  arrangeOfferedChoices,
  resolveOfferedChoiceLayout,
  selectPrimaryOfferedChoice,
  type OfferedPermissionChoice,
} from './offeredChoiceLayout';

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
      selectPrimaryOfferedChoice([
        choice('always', 'approved', 'localPersistent'),
        choice('session', 'approved_for_session', 'session'),
        choice('once', 'approved', 'once'),
        choice('reject', 'denied', 'once'),
      ]),
    ).toBe('once');
    expect(
      selectPrimaryOfferedChoice([
        choice('session', 'approved_for_session', 'session'),
        choice('always', 'approved', 'localPersistent'),
      ]),
    ).toBe('session');
  });

  it('never makes a refusal or a choice the viewer cannot take primary', () => {
    expect(
      selectPrimaryOfferedChoice([
        choice('stop', 'abort', 'once'),
        choice('always', 'approved', 'localPersistent', false),
        choice('session', 'approved_for_session', 'session'),
      ]),
    ).toBe('session');
    expect(
      selectPrimaryOfferedChoice([choice('reject', 'denied', 'once')]),
    ).toBeNull();
  });

  it('shares one line only while the row fits, and always lists on a phone', () => {
    expect(
      resolveOfferedChoiceLayout({
        narrow: false,
        primaryLeadsApprovals: true,
        rowNaturalWidthPx: 480,
        containerWidthPx: 900,
      }),
    ).toBe('row');
    expect(
      resolveOfferedChoiceLayout({
        narrow: false,
        primaryLeadsApprovals: true,
        rowNaturalWidthPx: 960,
        containerWidthPx: 900,
      }),
    ).toBe('list');
    expect(
      resolveOfferedChoiceLayout({
        narrow: true,
        primaryLeadsApprovals: true,
        rowNaturalWidthPx: 200,
        containerWidthPx: 360,
      }),
    ).toBe('list');
    expect(
      resolveOfferedChoiceLayout({
        narrow: false,
        primaryLeadsApprovals: true,
        rowNaturalWidthPx: null,
        containerWidthPx: null,
      }),
    ).toBe('row');
    // A primary that is not the agent's first approval cannot sit at the row's end edge without reordering.
    expect(resolveOfferedChoiceLayout({ narrow: false, primaryLeadsApprovals: false, rowNaturalWidthPx: 480, containerWidthPx: 900 })).toBe('list');
  });

  it('reads the row inward from its end edge in agent order, refusals at the start', () => {
    const arranged = arrangeOfferedChoices([
      choice('once', 'approved', 'once'),
      choice('session', 'approved_for_session', 'session'),
      choice('always', 'approved', 'localPersistent'),
      choice('reject', 'denied', 'once'),
    ]);
    expect(arranged.rowStart.map((c) => c.id)).toEqual(['reject']);
    expect(arranged.rowEnd.map((c) => c.id)).toEqual([
      'always',
      'session',
      'once',
    ]);
    expect(arranged.refusalsTrail).toBe(true);
    expect(
      arrangeOfferedChoices([
        choice('reject', 'denied', 'once'),
        choice('once', 'approved', 'once'),
      ]).refusalsTrail,
    ).toBe(false);
  });
});
