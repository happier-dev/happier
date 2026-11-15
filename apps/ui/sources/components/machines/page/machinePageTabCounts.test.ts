import { describe, expect, it } from 'vitest';

import { machinePageTabCounts } from './machinePageTabCounts';

const updates = (pendingSecurity: number) => ({
  status: 'drifted' as const,
  backend: 'apt',
  pendingSecurity,
  pendingAll: pendingSecurity + 4,
});

describe('Machine page tab counts (lab mOv "Services 9", "Security • 3")', () => {
  it('counts the services quietly and the waiting security updates as needing the person', () => {
    const counts = machinePageTabCounts({
      online: true,
      managedServices: { running: 9, failing: 0 },
      updates: updates(3),
    });
    expect(counts.get('services')).toEqual({ count: '9' });
    expect(counts.get('security')).toEqual({
      count: '3',
      countTone: 'warning',
    });
  });

  it('says how many services fail, as the needs-you count, when some do', () => {
    const counts = machinePageTabCounts({
      online: true,
      managedServices: { running: 2, failing: 1 },
      updates: null,
    });
    expect(counts.get('services')).toEqual({ count: '1', countTone: 'danger' });
    expect(counts.has('security')).toBe(false);
  });

  it("shows no count it cannot stand behind: nothing reported, nothing waiting, or an offline Machine's last answer", () => {
    expect(
      machinePageTabCounts({
        online: true,
        managedServices: null,
        updates: updates(0),
      }).size,
    ).toBe(0);
    expect(
      machinePageTabCounts({
        online: true,
        managedServices: { running: 0, failing: 0 },
        updates: null,
      }).size,
    ).toBe(0);
    expect(
      machinePageTabCounts({
        online: false,
        managedServices: { running: 9, failing: 1 },
        updates: updates(3),
      }).size,
    ).toBe(0);
  });
});
