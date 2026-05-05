import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendFactory } from './executionRunBackendRegistry';

describe('executionRunBackendRegistry (review engines)', () => {
  it('registers the CodeRabbit execution-run backend factory', () => {
    expect(getExecutionRunBackendFactory('coderabbit')).toEqual(expect.any(Function));
  });

  it('does not expose unknown review backends', () => {
    expect(getExecutionRunBackendFactory('acme.review.backend')).toBeNull();
  });
});
