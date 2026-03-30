import { describe, expect, it } from 'vitest';

import { resolveCodexRequestedDirectory } from './resolveCodexRequestedDirectory';

describe('resolveCodexRequestedDirectory', () => {
  it('prefers the explicit directory when provided', () => {
    expect(resolveCodexRequestedDirectory({
      directory: '  /tmp/explicit  ',
      env: { HAPPIER_STACK_INVOKED_CWD: '/tmp/invoked' },
      cwd: '/tmp/stack-workspace',
    })).toBe('/tmp/explicit');
  });

  it('uses HAPPIER_STACK_INVOKED_CWD when directory is omitted', () => {
    expect(resolveCodexRequestedDirectory({
      env: { HAPPIER_STACK_INVOKED_CWD: '/tmp/invoked' },
      cwd: '/tmp/stack-workspace',
    })).toBe('/tmp/invoked');
  });
});

