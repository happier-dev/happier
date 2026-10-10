import { describe, expect, it } from 'vitest';
import { TriageMountedUiInputV1Schema } from './mountedUiProtocol.js';

describe('mounted source-panel intents', () => {
  it('admits linked-session selection without admitting an unaddressed or empty selection', () => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'detail', operation: {
      kind: 'selectLinkedSession', sessionId: 'session-other',
    } }).success).toBe(true);
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'detail', operation: {
      kind: 'selectLinkedSession', sessionId: '',
    } }).success).toBe(false);
  });
  it.each([
    { kind: 'selectSourceOccurrence', occurrenceId: 'second' },
    { kind: 'setSourceOrdering', order: 'spread' },
    { kind: 'revealSourceUser', occurrenceId: 'second', revealed: false },
  ])('admits $kind on the existing mounted corridor', (operation) => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'mounted-page', operation }).success).toBe(true);
  });
  it.each([
    { kind: 'insertSelectedEvidence', occurrenceId: 'second' },
    { kind: 'revealSourceUser', occurrenceId: 'second', revealed: true },
  ])('does not admit approval-bearing $kind through the ordinary mounted Action', (operation) => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'mounted-page', operation }).success).toBe(false);
  });
});
