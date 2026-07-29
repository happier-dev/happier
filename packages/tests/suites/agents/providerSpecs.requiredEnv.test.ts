import { describe, expect, it } from 'vitest';

import { E2eCliProviderSpecV1Schema } from '@happier-dev/protocol';

describe('providers: providerSpec requiredEnv', () => {
  it('preserves requiredEnv keys from providerSpec.json', () => {
    const parsed = E2eCliProviderSpecV1Schema.parse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      requiredEnv: ['OPENAI_API_KEY'],
      cli: {
        subcommand: 'example',
      },
    });

    expect(parsed.requiredEnv).toEqual(['OPENAI_API_KEY']);
  });

  it('accepts multiple requiredEnv keys', () => {
    const parsed = E2eCliProviderSpecV1Schema.parse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      requiredEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
      cli: {
        subcommand: 'example',
      },
    });

    expect(parsed.requiredEnv).toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY']);
  });

  it('rejects invalid requiredEnv shape', () => {
    const parsed = E2eCliProviderSpecV1Schema.safeParse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      requiredEnv: 'OPENAI_API_KEY',
      cli: {
        subcommand: 'example',
      },
    });

    expect(parsed.success).toBe(false);
  });
});
