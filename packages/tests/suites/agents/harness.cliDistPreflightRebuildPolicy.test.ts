import { describe, expect, it } from 'vitest';

import { resolveCliDistPreflightAllowRebuild } from '../../src/testkit/providers/harness';

describe('providers harness: cli dist preflight rebuild policy', () => {
  it('defaults to allowing preflight rebuilds', () => {
    delete process.env.HAPPIER_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD;
    delete process.env.HAPPY_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD;

    expect(resolveCliDistPreflightAllowRebuild()).toBe(true);
  });

  it('accepts explicit disable flag via HAPPIER/HAPPY aliases', () => {
    process.env.HAPPIER_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD = '0';
    expect(resolveCliDistPreflightAllowRebuild()).toBe(false);

    delete process.env.HAPPIER_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD;
    process.env.HAPPY_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD = 'no';
    expect(resolveCliDistPreflightAllowRebuild()).toBe(false);
  });
});
