import { describe, expect, it } from 'vitest';

import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';

describe('resolveStackProcessKindOverrideForSessionSpawn', () => {
  it('returns empty when no stack env file is present', () => {
    expect(resolveStackProcessKindOverrideForSessionSpawn({})).toEqual({});
    expect(resolveStackProcessKindOverrideForSessionSpawn({ HAPPIER_STACK_ENV_FILE: '' })).toEqual({});
    expect(resolveStackProcessKindOverrideForSessionSpawn({ HAPPIER_STACK_ENV_FILE: '   ' })).toEqual({});
  });

  it('forces HAPPIER_STACK_PROCESS_KIND=session when a stack env file is present', () => {
    expect(
      resolveStackProcessKindOverrideForSessionSpawn({
        HAPPIER_STACK_ENV_FILE: '/tmp/stack.env',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      }),
    ).toEqual({ HAPPIER_STACK_PROCESS_KIND: 'session' });

    expect(
      resolveStackProcessKindOverrideForSessionSpawn({
        HAPPIER_STACK_ENV_FILE: '/tmp/stack.env',
        HAPPIER_STACK_PROCESS_KIND: 'session',
      }),
    ).toEqual({ HAPPIER_STACK_PROCESS_KIND: 'session' });
  });
});

