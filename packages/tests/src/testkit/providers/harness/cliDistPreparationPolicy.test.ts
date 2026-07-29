import { describe, expect, it } from 'vitest';

import { shouldPrepareProviderCliDist } from './cliDistPreparationPolicy';

describe('shouldPrepareProviderCliDist', () => {
  it.each([
    ['primary source-entrypoint flag', { NODE_ENV: 'test', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' }],
    ['legacy source-entrypoint flag', { NODE_ENV: 'test', HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: 'true' }],
  ])('skips CLI dist preparation for %s', (_label, env) => {
    expect(shouldPrepareProviderCliDist(env)).toBe(false);
  });

  it('retains CLI dist preparation in built-entrypoint mode', () => {
    expect(shouldPrepareProviderCliDist({ NODE_ENV: 'test' })).toBe(true);
  });
});
