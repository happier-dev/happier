import { describe, expect, it } from 'vitest';

import { resolveMachineIdCandidatesFromSettings } from '../../src/testkit/providers/scenarioCatalog';

describe('scenarioCatalog machine id candidate resolution', () => {
  it('prioritizes direct machineId, then active server mapping, then remaining mappings', () => {
    const ids = resolveMachineIdCandidatesFromSettings({
      machineId: 'direct-id',
      activeServerId: 'srv-2',
      machineIdByServerId: {
        'srv-1': 'mapped-1',
        'srv-2': 'mapped-2',
        'srv-3': 'mapped-3',
      },
    });

    expect(ids).toEqual(['direct-id', 'mapped-2', 'mapped-1', 'mapped-3']);
  });

  it('deduplicates and drops empty values', () => {
    const ids = resolveMachineIdCandidatesFromSettings({
      machineId: 'same-id',
      activeServerId: 'srv-1',
      machineIdByServerId: {
        'srv-1': 'same-id',
        'srv-2': ' ',
        'srv-3': 'other-id',
      },
    });

    expect(ids).toEqual(['same-id', 'other-id']);
  });
});
