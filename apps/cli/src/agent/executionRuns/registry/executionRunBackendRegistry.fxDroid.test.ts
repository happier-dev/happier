import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendFactory } from './executionRunBackendRegistry';

describe('catalog-defined ACP execution-run registration', () => {
  it.each(['fx', 'droid', 'codebuddy'])('uses the generic ACP execution-run factory for %s', (agentId) => {
    expect(getExecutionRunBackendFactory(agentId)).toBeTypeOf('function');
  });
});
