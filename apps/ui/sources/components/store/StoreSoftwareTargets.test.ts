import { describe, expect, it } from 'vitest';

import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

import { t } from '@/text';

import {
  foldOfflineSoftwareTargets,
  softwareMachinesUnreachableLine,
  type SoftwareMachineTarget,
} from './StoreSoftwareTargets';

function target(
  machineId: string,
  online: boolean | null,
): SoftwareMachineTarget {
  const machine: ReachMachine = {
    machineId,
    platform: 'posix',
    agentIds: [],
    name: machineId,
    online,
    offline: online === false,
    lastSeenAt: null,
  };
  return {
    machine,
    target: { scope: null, machine: { serverIdentityId: 'home', machineId } },
  };
}

describe('foldOfflineSoftwareTargets', () => {
  it('keeps reachable and unknown Machines, and folds offline ones behind one count', () => {
    const fold = foldOfflineSoftwareTargets(
      [
        target('a', true),
        target('b', null),
        target('c', false),
        target('d', false),
      ],
      new Set(),
    );
    expect(fold.shown.map((entry) => entry.machine.machineId)).toEqual([
      'a',
      'b',
    ]);
    expect(fold.offline.map((entry) => entry.machine.machineId)).toEqual([
      'c',
      'd',
    ]);
  });

  it('keeps an offline Machine that is already turned on, so it can be turned off', () => {
    const fold = foldOfflineSoftwareTargets(
      [target('a', true), target('c', false)],
      new Set(['c']),
    );
    expect(fold.shown.map((entry) => entry.machine.machineId)).toEqual([
      'a',
      'c',
    ]);
    expect(fold.offline).toEqual([]);
  });
});

describe('softwareMachinesUnreachableLine', () => {
  it('offers no line while any Machine can be chosen, or when there is none to name', () => {
    expect(softwareMachinesUnreachableLine({ targets: [target('a', false), target('b', true)] })).toBeNull();
    expect(softwareMachinesUnreachableLine({ targets: [] })).toBeNull();
  });

  it('says why the only Machine cannot be read, instead of a chooser that cannot succeed', () => {
    expect(softwareMachinesUnreachableLine({ targets: [target('Build box', false)] }))
      .toBe(t('capabilities.store.softwarePage.offline', { machine: 'Build box' }));
    expect(softwareMachinesUnreachableLine({ targets: [target('Build box', null)] }))
      .toBe(t('capabilities.store.softwarePage.unknown', { machine: 'Build box' }));
  });

  it('says once that none of several Machines can be read', () => {
    expect(softwareMachinesUnreachableLine({ targets: [target('a', false), target('b', null)] }))
      .toBe(t('capabilities.store.softwarePage.noneReachable'));
  });
});
