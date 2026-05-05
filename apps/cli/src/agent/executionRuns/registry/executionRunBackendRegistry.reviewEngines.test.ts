import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendFactory } from './executionRunBackendRegistry';

describe('executionRunBackendRegistry (review engines)', () => {
  it('does not register descriptor-backed review engine factories after runtimeCore convergence', () => {
    expect(getExecutionRunBackendFactory('acme.review.backend')).toBeNull();
  });
});
