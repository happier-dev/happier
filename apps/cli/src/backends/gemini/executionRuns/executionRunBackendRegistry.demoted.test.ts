import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';

describe('gemini execution-run legacy registry', () => {
  it('does not keep gemini in the legacy built-in execution-run registry', () => {
    expect(getExecutionRunBackendDescriptor('gemini')).toBeNull();
  });
});
