import { describe, expect, it } from 'vitest';

import { E2eCliProviderSpecV1Schema } from '@happier-dev/protocol';

describe('providers: providerSpec auth', () => {
  it('supports auth mode overlays with requiredAnyOf env', () => {
    const parsed = E2eCliProviderSpecV1Schema.safeParse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      cli: { subcommand: 'example' },
      auth: {
        mode: 'auto',
        env: {
          requiredAnyOf: [['OPENAI_API_KEY'], ['CODEX_API_KEY']],
          env: { NO_BROWSER: '1' },
        },
        host: {
          envUnset: ['NO_BROWSER'],
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.auth?.mode).toBe('auto');
    expect(parsed.data.auth?.env?.requiredAnyOf).toEqual([['OPENAI_API_KEY'], ['CODEX_API_KEY']]);
    expect(parsed.data.auth?.env?.env?.NO_BROWSER).toBe('1');
    expect(parsed.data.auth?.host?.envUnset).toEqual(['NO_BROWSER']);
  });

  it('accepts host-only auth overlay with explicit mode', () => {
    const parsed = E2eCliProviderSpecV1Schema.safeParse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      auth: {
        mode: 'host',
        host: {
          envUnset: ['NO_BROWSER'],
        },
      },
      cli: { subcommand: 'example' },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.auth?.mode).toBe('host');
    expect(parsed.data.auth?.host?.envUnset).toEqual(['NO_BROWSER']);
  });

  it('rejects invalid requiredAnyOf shape', () => {
    const parsed = E2eCliProviderSpecV1Schema.safeParse({
      v: 1,
      id: 'example',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_EXAMPLE',
      protocol: 'acp',
      traceProvider: 'example',
      auth: {
        mode: 'auto',
        env: {
          requiredAnyOf: ['OPENAI_API_KEY'],
        },
      },
      cli: { subcommand: 'example' },
    });

    expect(parsed.success).toBe(false);
  });
});
