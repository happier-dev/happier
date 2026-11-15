import { describe, expect, it } from 'vitest';

import {
  buildCodexNativeUpstreamProvider,
  CODEX_NATIVE_UPSTREAM_CONFIG_ENV,
  CodexProviderBindingEngineConfigV1Schema,
  codexNativeUpstreamConfigOverrides,
} from './runtimeConfig.js';

describe('Codex upstream launch config', () => {
  it('excludes inherited ChatGPT apps from a selected custom endpoint', () => {
    const baseUrl = 'https://gateway.example/v1';
    const modelProvider = `happier_${'a'.repeat(32)}`;
    const overrides = codexNativeUpstreamConfigOverrides({
      [CODEX_NATIVE_UPSTREAM_CONFIG_ENV]: JSON.stringify({
        v: 1, modelProvider,
        config: { [`model_providers.${modelProvider}`]: buildCodexNativeUpstreamProvider(baseUrl) },
      }),
    });

    expect(overrides).toContain('features.apps=false');
    expect(overrides).toContain(`model_providers.${modelProvider}.base_url=${JSON.stringify(baseUrl)}`);
  });

  it('also excludes apps for a reserved local provider', () => {
    expect(codexNativeUpstreamConfigOverrides({
      [CODEX_NATIVE_UPSTREAM_CONFIG_ENV]: JSON.stringify({ v: 1, modelProvider: 'ollama', config: {} }),
    })).toContain('features.apps=false');
  });

  it('retains native OpenAI account configuration when no upstream is selected', () => {
    expect(codexNativeUpstreamConfigOverrides({})).toEqual([]);
  });
});

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
  it('accepts positive model windows only at their native config key', () => {
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({ ...custom,
      config: { ...custom.config, model_context_window: 1_048_576 },
    }).success).toBe(true);
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({ v: 1, modelProvider: 'ollama',
      config: { model_context_window: 32_768 },
    }).success).toBe(true);
    for (const window of [0, -1, 1.5, '1048576']) {
      expect(CodexProviderBindingEngineConfigV1Schema.safeParse({ ...custom,
        config: { ...custom.config, model_context_window: window },
      }).success).toBe(false);
    }
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({ ...custom,
      config: { ...custom.config, arbitrary_limit: 1_048_576 },
    }).success).toBe(false);
  });

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
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        ...custom.config,
        model_reasoning_effort: 'none',
      },
    }).success).toBe(true);
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      v: 1,
      modelProvider: 'ollama',
      config: { model_reasoning_effort: 'none' },
    }).success).toBe(true);
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
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        ...custom.config,
        model_reasoning_effort: 'high',
      },
    }).success).toBe(false);
    expect(CodexProviderBindingEngineConfigV1Schema.safeParse({
      ...custom,
      config: {
        ...custom.config,
        unrelated: 'none',
      },
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
