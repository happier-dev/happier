import { describe, expect, it } from 'vitest';
import * as inventory from './index.js';

describe('machine local-service summary', () => {
  it('admits an explicit zero only in a ready daemon summary and rejects malformed projections', () => {
    const ready = { v: 1, state: 'ready', runningCount: 0 };
    expect(inventory.LocalServiceMachineSummaryV1Schema.parse(ready)).toEqual(ready);
    expect(inventory.LocalServiceMachineSummaryV1Schema.parse({ v: 1, state: 'unknown' })).toEqual({ v: 1, state: 'unknown' });
    for (const summary of [undefined, {}, { v: 1, state: 'ready' }, { v: 1, state: 'error', runningCount: 0 }, { v: 1, state: 'ready', runningCount: -1 }, { v: 1, state: 'unknown', runningCount: 0 }]) {
      expect(inventory.LocalServiceMachineSummaryV1Schema.safeParse(summary).success).toBe(false);
    }
  });

});
