import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendDescriptor } from './executionRunBackendRegistry';

describe('executionRunBackendRegistry (aliases)', () => {
  it('aliases claude-code to claude', () => {
    const claude = getExecutionRunBackendDescriptor('claude');
    expect(claude).not.toBeNull();

    const claudeCode = getExecutionRunBackendDescriptor('claude-code');
    expect(claudeCode).toBe(claude);
  });
});
