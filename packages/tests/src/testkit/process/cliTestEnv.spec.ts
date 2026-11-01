import { expect, it } from 'vitest';

import { sanitizeCliTestEnv } from './cliTestEnv';

it('isolates fixture CLI runs from the parent session input and stack directory', () => {
  const inheritedEnv = Object.freeze({
    PATH: '/usr/bin',
    HAPPIER_DAEMON_PENDING_FIRST_INPUT: JSON.stringify({ text: 'parent session', localId: 'parent-input' }),
    HAPPIER_STACK_INVOKED_CWD: '/parent/workspace',
  });

  expect(sanitizeCliTestEnv(inheritedEnv)).toEqual({ PATH: '/usr/bin' });
});
