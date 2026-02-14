import { describe, expect, it } from 'vitest';

import { CHECKLIST_IDS } from './checklistIds';
import { checklists } from './checklists';

describe('capabilities checklists', () => {
  it('includes tool.executionRuns in MACHINE_DETAILS checklist', () => {
    const entries = checklists[CHECKLIST_IDS.MACHINE_DETAILS] ?? [];
    expect(entries.some((e) => e.id === 'tool.executionRuns')).toBe(true);
  });
});

