import { describe, expect, it } from 'vitest';
import { captureStepKind } from './model.js';

describe('captured request steps', () => {
  // DESIGN-1118-B S1: a slow step says what kind of work it was.
  it('names a step by what it was: a query, an external call, or work in the app', () => {
    expect(captureStepKind({ kind: 'query', spanKind: null })).toBe('query');
    expect(captureStepKind({ kind: 'span', spanKind: 3 })).toBe('external');
    expect(captureStepKind({ kind: 'span', spanKind: 1 })).toBe('app');
    expect(captureStepKind({ kind: 'span', spanKind: null })).toBe('app');
  });
});
