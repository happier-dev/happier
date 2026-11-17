import { describe, expect, it } from 'vitest';
import { listActionSpecs } from '../actionSpecs.js';

describe('retired deployment query Action', () => {
  it('removes the legacy query from the public catalogue', () => {
    expect(listActionSpecs().some(spec => String(spec.id) === 'deployments.data.query')).toBe(false);
  });
});
