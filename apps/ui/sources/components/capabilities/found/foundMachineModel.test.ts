import { describe, expect, it } from 'vitest';

import { foldQuietFoundMachines, partitionFoundMachines, resolveFoundMachineBody } from './foundMachineModel';

describe('Found machine sections', () => {
  const rows = ['a', 'b'];

  it('says what it is doing before anything is known, and keeps the last known rows through a failed read', () => {
    expect(resolveFoundMachineBody({ failure: null, items: null })).toEqual({ kind: 'looking' });
    expect(resolveFoundMachineBody({ failure: 'failed', items: null })).toEqual({ kind: 'failed' });
    expect(resolveFoundMachineBody({ failure: 'older_machine', items: rows })).toEqual({ kind: 'older_machine' });
    expect(resolveFoundMachineBody({ failure: 'failed', items: rows })).toEqual({ kind: 'rows', items: rows });
    expect(resolveFoundMachineBody({ failure: null, items: [] })).toEqual({ kind: 'empty' });
  });

  it('names machines that cannot be read now and that nothing is known about once, as a count, and keeps every other machine', () => {
    const machines = [
      { id: 'on', online: true }, { id: 'off-known', online: false }, { id: 'off-unknown-1', online: false }, { id: 'presence-unknown', online: null },
    ];
    const { sections, unseenOffline } = partitionFoundMachines(machines, (machine) => machine.id === 'off-known');
    expect(sections.map((machine) => machine.id)).toEqual(['on', 'off-known']);
    expect(unseenOffline).toBe(2);
  });

  it('folds the machines with nothing to show into counts, keeping every machine with something to say', () => {
    const machines = ['rows', 'empty-1', 'looking', 'failed', 'empty-2', 'empty-with-note'];
    const quiet = (id: string) => (id.startsWith('empty-with') ? null : id.startsWith('empty') ? 'empty' as const : id === 'looking' ? 'looking' as const : null);
    expect(foldQuietFoundMachines(machines, quiet)).toEqual({
      sections: ['rows', 'failed', 'empty-with-note'], empty: 2, looking: 1,
    });
  });
});
