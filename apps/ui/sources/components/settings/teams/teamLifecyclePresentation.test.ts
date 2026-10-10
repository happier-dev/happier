import { describe, expect, it } from 'vitest';

import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';

import { teamArchiveConfirmationLines } from './teamLifecyclePresentation';

describe('teamArchiveConfirmationLines', () => {
  const quiet = { members: 8, suspendedMembers: 0, groups: 4, waitingInvitations: 0 };

  it('warns about waiting invitation links only when some would stop working', () => {
    const none = teamArchiveConfirmationLines(teamSummaryFixture({ counts: quiet }));
    const waiting = teamArchiveConfirmationLines(
      teamSummaryFixture({ counts: { ...quiet, waitingInvitations: 2 } }),
    );
    expect(waiting).toHaveLength(none.length + 1);
    // What is kept comes first and the way back comes last, either way.
    expect(waiting[0]).toBe(none[0]);
    expect(waiting.at(-1)).toBe(none.at(-1));
  });

  it('still says what is kept when the viewer cannot read the counts', () => {
    const unknown = teamArchiveConfirmationLines(teamSummaryFixture({ counts: null }));
    expect(unknown.length).toBeGreaterThanOrEqual(2);
    expect(unknown.join('\n')).not.toMatch(/\d/);
  });
});
