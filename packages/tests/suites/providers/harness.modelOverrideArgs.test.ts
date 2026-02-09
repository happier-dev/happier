import { describe, expect, it } from 'vitest';

import { resolveProviderModelCliArgs } from '../../src/testkit/providers/harness';

describe('providers harness: model startup args', () => {
  it('uses provider-specific model override when present', () => {
    const args = resolveProviderModelCliArgs({
      providerId: 'codex',
      env: {
        HAPPIER_E2E_PROVIDER_MODEL: 'global-default',
        HAPPIER_E2E_PROVIDER_MODEL_CODEX: 'provider-specific',
      },
      nowMs: () => 1700000000000,
    });

    expect(args).toEqual(['--model', 'provider-specific', '--model-updated-at', '1700000000000']);
  });

  it('falls back to global model override when provider override is missing', () => {
    const args = resolveProviderModelCliArgs({
      providerId: 'claude',
      env: {
        HAPPIER_E2E_PROVIDER_MODEL: 'global-default',
      },
      nowMs: () => 1700000000001,
    });

    expect(args).toEqual(['--model', 'global-default', '--model-updated-at', '1700000000001']);
  });

  it('returns no args when no model override is configured', () => {
    const args = resolveProviderModelCliArgs({
      providerId: 'gemini',
      env: {},
      nowMs: () => 1700000000002,
    });

    expect(args).toEqual([]);
  });
});
