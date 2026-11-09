import { describe, expect, it } from 'vitest';
import { MachineGuardActivityEntryV1Schema, MachineGuardActivityStoredReadV1Schema, isGuardActionEntry } from './activityV1.js';

const entry = { v: 1, id: 'stop', at: 1, kind: 'stopped_session', rule: 'idle_sessions', outcome: 'done',
  attribution: { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'install' },
  subject: { kind: 'session', sessionId: 'session', title: 'Private title' },
  wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 'session' } }] } as const;
describe('Machine Guard Activity V1', () => {
  it('retains named historical receipts and admits an explicitly untitled Session', () => {
    expect(MachineGuardActivityStoredReadV1Schema.parse(entry).subject).toEqual(entry.subject);
    const untitled = { ...entry, subject: { ...entry.subject, title: null } };
    expect(MachineGuardActivityEntryV1Schema.parse(untitled).subject).toEqual(untitled.subject);
    expect(MachineGuardActivityStoredReadV1Schema.parse(untitled).subject).toEqual(untitled.subject);
  });
  it('closes write envelopes and executable references while dropping only unknown stored presentation facts', () => {
    expect(MachineGuardActivityEntryV1Schema.safeParse(entry).success).toBe(true);
    expect(MachineGuardActivityEntryV1Schema.safeParse({ ...entry, future: true }).success).toBe(false);
    expect(MachineGuardActivityEntryV1Schema.safeParse({ ...entry, wayBack: [{ ...entry.wayBack[0], actionId: 'arbitrary.shell' }] }).success).toBe(false);
    const stored = MachineGuardActivityStoredReadV1Schema.parse({ ...entry, future: true,
      subject: { ...entry.subject, future: true }, attribution: { ...entry.attribution, future: true } });
    expect(stored).toEqual(entry);
    expect(MachineGuardActivityStoredReadV1Schema.safeParse({ ...entry, at: '1' }).success).toBe(false);
  });
  it('requires references for undo and typed causes for failed starts', () => {
    expect(MachineGuardActivityEntryV1Schema.safeParse({ ...entry, kind: 'undone' }).success).toBe(false);
    expect(MachineGuardActivityEntryV1Schema.safeParse({ ...entry, kind: 'undone', ref: 'original' }).success).toBe(true);
    expect(MachineGuardActivityEntryV1Schema.safeParse({ ...entry, kind: 'start_failed' }).success).toBe(false);
    expect(MachineGuardActivityEntryV1Schema.safeParse({ ...entry, kind: 'start_failed', failure: { reason: 'no_ptys' }, nextStep: 'close_idle_terminals' }).success).toBe(true);
  });
  it('limits the automatic-action summary to successful guard stops, not notices or cleanup', () => {
    const parsed = MachineGuardActivityEntryV1Schema.parse(entry);
    expect(isGuardActionEntry(parsed)).toBe(true);
    for (const kind of ['housekeeping', 'trash_moved', 'closed_terminal', 'stop_failed', 'kept_running', 'undone', 'system_oom_kill'] as const) {
      expect(isGuardActionEntry({ ...parsed, kind })).toBe(false);
    }
    expect(isGuardActionEntry({ ...parsed, rule: 'approved_proposal' })).toBe(false);
    expect(isGuardActionEntry({ ...parsed, outcome: 'failed' })).toBe(false);
    expect(isGuardActionEntry({ ...parsed, outcome: 'did_not_help' })).toBe(true);
  });
});
