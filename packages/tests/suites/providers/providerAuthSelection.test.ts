import { describe, expect, it } from 'vitest';

import { resolveProviderAuthOverlay } from '../../src/testkit/providers/harness/providerAuthOverlay';

describe('providers: auth overlay selection', () => {
  it('selects env overlay when any requiredAnyOf bucket is satisfied', () => {
    const out = resolveProviderAuthOverlay({
      auth: {
        mode: 'auto',
        env: { requiredAnyOf: [['OPENAI_API_KEY'], ['CODEX_API_KEY']], env: { NO_BROWSER: '1' } },
        host: { envUnset: ['NO_BROWSER'] },
      },
      baseEnv: { OPENAI_API_KEY: 'sk-test' },
    });

    expect(out.mode).toBe('env');
    expect(out.env.NO_BROWSER).toBe('1');
  });

  it('falls back to host overlay when env requirements are not satisfied', () => {
    const out = resolveProviderAuthOverlay({
      auth: {
        mode: 'auto',
        env: { requiredAnyOf: [['OPENAI_API_KEY'], ['CODEX_API_KEY']], env: { NO_BROWSER: '1' } },
        host: { envUnset: ['NO_BROWSER'] },
      },
      baseEnv: { NO_BROWSER: '1' },
    });

    expect(out.mode).toBe('host');
    expect(out.env.NO_BROWSER).toBeUndefined();
  });

  it('fails fast in env mode when required env vars are missing', () => {
    expect(() =>
      resolveProviderAuthOverlay({
        auth: {
          mode: 'env',
          env: { requiredAll: ['OPENAI_API_KEY'] },
          host: { envUnset: ['NO_BROWSER'] },
        },
        baseEnv: {},
      }),
    ).toThrow(/Missing required env/);
  });

  it('falls back to host mode in auto mode when env requirements fail and no host overlay exists', () => {
    const out = resolveProviderAuthOverlay({
      auth: {
        mode: 'auto',
        env: { requiredAnyOf: [['KIMI_API_KEY'], ['OPENAI_API_KEY']] },
      },
      baseEnv: {},
    });

    expect(out.mode).toBe('host');
    expect(out.env).toEqual({});
  });
});
