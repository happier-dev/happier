import { describe, expect, it } from 'vitest';

import { CodexProviderBindingEngineConfigV1Schema } from './runtimeConfig.js';

const custom = {
  v: 1,
  modelProvider: 'happier_0123456789abcdef0123456789abcdef',
  config: {
    'model_providers.happier_0123456789abcdef0123456789abcdef': {
      name: 'Happier provider',
      base_url: 'https://provider.example/v1',
      wire_api: 'responses',
      env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY',
      requires_openai_auth: false,
      supports_websockets: false,
    },
  },
} as const;

describe('Codex provider-binding runtime config', () => {
  it('accepts exact custom and reserved adapter outputs', () => {
    expect(CodexProviderBindingEngineConfigV1Schema.parse(custom)).toEqual(custom);
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        'model_providers.happier_0123456789abcdef0123456789abcdef': {
          ...custom.config['model_providers.happier_0123456789abcdef0123456789abcdef'],
          env_key: undefined,
          http_headers: { 'x-provider-title': 'Happier' },
          env_http_headers: { 'x-api-key': 'HAPPIER_CODEX_PROVIDER_API_KEY' },
        },
      },
    }).success).toBe(true);
    expect(CodexProviderBindingEngineConfigV1Schema.parse({
      v: 1,
      modelProvider: 'ollama',
      config: {},
    })).toEqual({ v: 1, modelProvider: 'ollama', config: {} });
  });

  it('rejects unknown fields, mutable auth toggles, and mismatched config keys', () => {
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        ...custom.config,
        'model_providers.other': custom.config['model_providers.happier_0123456789abcdef0123456789abcdef'],
      },
    }).success).toBe(false);
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        'model_providers.happier_0123456789abcdef0123456789abcdef': {
          ...custom.config['model_providers.happier_0123456789abcdef0123456789abcdef'],
          requires_openai_auth: true,
        },
      },
    }).success).toBe(false);
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      websocketMode: true,
    }).success).toBe(false);
  });

  it('rejects endpoint URLs outside the canonical provider safety syntax', () => {
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        'model_providers.happier_0123456789abcdef0123456789abcdef': {
          ...custom.config['model_providers.happier_0123456789abcdef0123456789abcdef'],
          base_url: 'ftp://provider.example/models',
        },
      },
    }).success).toBe(false);
  });

  it('rejects header shapes that the Codex adapter cannot emit', () => {
    const provider = custom.config['model_providers.happier_0123456789abcdef0123456789abcdef'];

    for (const invalidProvider of [
      {
        ...provider,
        http_headers: { authorization: 'static-secret' },
      },
      {
        ...provider,
        env_key: undefined,
        env_http_headers: {
          'x-api-key': 'HAPPIER_CODEX_PROVIDER_API_KEY',
          'x-second-key': 'HAPPIER_CODEX_PROVIDER_API_KEY',
        },
      },
      {
        ...provider,
        env_key: undefined,
        http_headers: { 'x-api-key': 'public-value' },
        env_http_headers: { 'x-api-key': 'HAPPIER_CODEX_PROVIDER_API_KEY' },
      },
    ]) {
      expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
        ...custom,
        config: {
          'model_providers.happier_0123456789abcdef0123456789abcdef': invalidProvider,
        },
      }).success).toBe(false);
    }
  });
});
