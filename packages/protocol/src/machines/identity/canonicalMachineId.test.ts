import { expect, it } from 'vitest';
import { resolveCanonicalMachineId, type MachineReplacementRecord } from './canonicalMachineId.js';

it.each([1, 16, 64])('resolves %i replacement links with one visit per row', links => {
  const rows = Array.from({ length: links + 1 }, (_, i) => ({
    id: `machine-${i}`,
    replacedByMachineId: i < links ? `machine-${i + 1}` : null,
  }));
  const visits: string[] = [];
  class CountedMachineIndex extends Map<string, MachineReplacementRecord> {
    override get(id: string) {
      visits.push(id);
      return super.get(id);
    }
  }
  const index = new CountedMachineIndex(rows.map(row => [row.id, row]));
  const expected = { machineId: `machine-${links}`, reason: 'replacement', chain: rows.map(row => row.id) };
  expect(resolveCanonicalMachineId('machine-0', rows)).toEqual(expected);
  expect(resolveCanonicalMachineId('machine-0', index)).toEqual(expected);
  expect(visits).toEqual(expected.chain);
});

it('returns null when exact stored ids form a cycle after normalizing replacement targets', () => {
  expect(resolveCanonicalMachineId('machine-a', [
    { id: 'machine-a', replacedByMachineId: 'machine-b' },
    { id: 'machine-b', replacedByMachineId: 'machine-a ' },
    { id: 'machine-a ', replacedByMachineId: null },
  ])).toBeNull();
});
