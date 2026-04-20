import { describe, expect, it } from 'vitest';

import { getExecutionRunBackendDescriptor } from './executionRunBackendRegistry';

describe('executionRunBackendRegistry (aliases)', () => {
  it('does not keep codex in the legacy built-in execution-run registry', () => {
    expect(getExecutionRunBackendDescriptor('codex')).toBeNull();
  });

  it('does not keep claude in the legacy built-in execution-run registry', () => {
    expect(getExecutionRunBackendDescriptor('claude')).toBeNull();
    expect(getExecutionRunBackendDescriptor('claude-code')).toBeNull();
  });
});
