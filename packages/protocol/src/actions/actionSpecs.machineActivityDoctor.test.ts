import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

describe('Machine Activity and Doctor Action contracts', () => {
  it('accepts the continuation from a partial Fleet Activity page on the Agent surface', () => {
    const spec = getActionSpec('machines.activity.list');
    const cursor = { requestedAtMs: 123, id: 'operation:operation-1' };
    const page = {
      items: [],
      nextCursor: cursor,
      coverage: 'partial',
      unavailableSources: [{ kind: 'machine', id: 'machine-1', code: 'machine_offline' }],
    };
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.outputSchema?.parse(page)).toEqual(page);
    expect(spec.inputSchema.parse({ limit: 2, cursor })).toEqual({ limit: 2, cursor });
  });

  it('accepts a Machine Doctor refresh for one Machine and rejects an untyped diagnostics result', () => {
    const spec = getActionSpec('machines.doctor.snapshot');
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.inputSchema.parse({ machineId: 'machine-1', refresh: true })).toEqual({
      machineId: 'machine-1',
      refresh: true,
    });
    expect(spec.outputSchema?.safeParse({ status: 'ready', snapshot: { arbitraryDiagnostics: true } }).success)
      .toBe(false);
  });
});
