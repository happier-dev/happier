import { describe, expect, it } from 'vitest';
import { projectContributedActionFailure } from './contributedActionFailure';

describe('projectContributedActionFailure', () => {
  it('preserves host schema diagnostics across the public failure boundary', () => {
    const failure = {
      errorCode: 'plugin_action_input_schema_invalid',
      error: 'plugin_action_input_schema_invalid',
      details: { issues: [{ path: ['resource'], code: 'const' }] },
    };
    expect(projectContributedActionFailure(failure).details).toEqual(failure.details);
  });
});
