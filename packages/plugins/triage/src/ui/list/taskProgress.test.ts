import { describe, expect, it } from 'vitest';

import { readTriageTaskDueV1, readTriageTaskProgressV1 } from './rows.js';

const text = (_key: string, fallback: string, params?: Readonly<Record<string, string | number>>) =>
  fallback.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''));
const ref = { source: { pluginId: 'acme.tracker', localId: 'issues' }, kindId: 'issue', collisionScope: 'acme', entryId: '7' };

describe('a task row\'s Progress hint', () => {
  it('leads with a blocker, then sub-tasks done, then the parent, and says nothing when relations were not read', () => {
    const read = (relations: Parameters<typeof readTriageTaskProgressV1>[0]) => readTriageTaskProgressV1(relations, text)?.label ?? null;
    expect(read({ blockedBy: [ref], children: { total: 5, completed: 3 } })).toBe('3 of 5');
    expect(read({ children: { total: 5, completed: 3 } })).toBe('3 of 5');
    expect(read({ children: { total: 4 } })).toBe('4 sub-tasks');
    expect(read({ parent: ref })).toBe('Sub-task');
    expect(read({})).toBeNull();
    expect(read(null)).toBeNull();
  });
  it('names the blocker when the list knows it, and draws the share of sub-tasks done only when the source counted them', () => {
    const other = { ...ref, entryId: '8' };
    const nameOf = (blocker: typeof ref) => (blocker.entryId === '7' ? 'OPS-1170' : null);
    const blocked = { ready: false, reason: 'blocker_not_terminal' } as const;
    expect(readTriageTaskProgressV1({ blockedBy: [ref] }, text, nameOf, blocked)?.label).toBe('Blocked by OPS-1170');
    expect(readTriageTaskProgressV1({ blockedBy: [ref, other] }, text, nameOf, blocked)?.label).toBe('Blocked');
    expect(readTriageTaskProgressV1({ blockedBy: [other] }, text, nameOf, blocked)?.label).toBe('Blocked');
    expect(readTriageTaskProgressV1(null, text, nameOf, { ready: false, reason: 'blocker_unreadable' })?.label).toBe('Blocker unavailable');
    expect(readTriageTaskProgressV1({ children: { total: 5, completed: 3 } }, text)?.done).toEqual({ completed: 3, total: 5 });
    expect(readTriageTaskProgressV1({ children: { total: 4 } }, text)?.done).toBeUndefined();
  });
});

describe('a task row\'s Due cell', () => {
  const now = new Date(2026, 9, 20, 12, 0).getTime(); // Tuesday noon, local time
  it('reads a calendar date as a day: overdue before today, today, then the weekday this week and the date beyond', () => {
    expect(readTriageTaskDueV1('2026-10-19', 'started', 'en', now, text)).toEqual({ label: 'Overdue · Mon', tone: 'danger' });
    expect(readTriageTaskDueV1('2026-10-20', 'unstarted', 'en', now, text)).toEqual({ label: 'Today', tone: 'warning' });
    expect(readTriageTaskDueV1('2026-10-22', 'unstarted', 'en', now, text)).toEqual({ label: 'Thu', tone: null });
    expect(readTriageTaskDueV1('2026-11-03', 'backlog', 'en', now, text)).toEqual({ label: 'Nov 3', tone: null });
    expect(readTriageTaskDueV1(undefined, 'started', 'en', now, text)).toBeNull();
  });
  it('reads a moment as a moment: past today is overdue, and a finished task is never overdue', () => {
    const earlier = new Date(2026, 9, 20, 9, 0).toISOString();
    const later = new Date(2026, 9, 20, 17, 0).toISOString();
    expect(readTriageTaskDueV1(earlier, 'started', 'en', now, text)?.tone).toBe('danger');
    expect(readTriageTaskDueV1(later, 'started', 'en', now, text)).toEqual({ label: 'Today', tone: 'warning' });
    expect(readTriageTaskDueV1('2026-10-19', 'completed', 'en', now, text)).toEqual({ label: 'Mon', tone: null });
  });
});
