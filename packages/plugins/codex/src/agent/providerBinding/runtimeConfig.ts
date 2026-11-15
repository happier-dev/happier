import { z } from 'zod/mini';
import { AgentSessionProviderBindingV1Schema } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  normalizeProviderCredentialHeaderName,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
} from '@happier-dev/plugin-sdk/providers';

const CODEX_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_CODEX_PROVIDER_API_KEY';
export const CODEX_NATIVE_UPSTREAM_CONFIG_ENV = 'HAPPIER_CODEX_NATIVE_UPSTREAM_CONFIG';

/** Native Codex fields shared by Provider bindings and selected account keys. */
export function buildCodexNativeUpstreamProvider(baseUrl: string) {
  return { name: 'Happier provider', base_url: baseUrl, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false } as const;
}

/** ChatGPT Account apps do not belong to an explicitly selected upstream. */
export function buildCodexNativeUpstreamConfig(
  config: CodexProviderBindingEngineConfigV1 | null,
): Record<string, CodexProviderBindingEngineConfigV1['config'][string] | boolean> {
  return config ? { ...config.config, 'features.apps': false } : {};
}

/** Config overrides contain environment references, never credential values. */
export function codexNativeUpstreamConfigOverrides(environment: Readonly<Record<string, string | undefined>>, modelId?: string): string[] {
  const config = readCodexNativeUpstreamConfig(environment);
  if (!config) return [];
  return [...(modelId && modelId !== 'default' ? [`model=${JSON.stringify(modelId)}`] : []),
    `model_provider=${JSON.stringify(config.modelProvider)}`, ...Object.entries(buildCodexNativeUpstreamConfig(config)).flatMap(([path, value]) =>
    typeof value !== 'object' ? [`${path}=${JSON.stringify(value)}`]
      : Object.entries(value).map(([key, field]) => `${path}.${key}=${JSON.stringify(field)}`))];
}

export function readCodexNativeUpstreamConfig(environment: Readonly<Record<string, string | undefined>>): CodexProviderBindingEngineConfigV1 | null {
  const raw = environment[CODEX_NATIVE_UPSTREAM_CONFIG_ENV];
  return raw ? CodexProviderBindingEngineConfigV1Schema.parse(JSON.parse(raw)) : null;
}
const CODEX_MODEL_REASONING_EFFORT_KEY = 'model_reasoning_effort';
const CUSTOM_CODEX_PROVIDER_KEY_PATTERN = /^happier_[a-f0-9]{32}$/u;
const RESERVED_CODEX_PROVIDER_KEYS = new Set(['ollama', 'lmstudio']);

const CodexPublicHeadersV1Schema = ProviderPublicHeadersV1Schema.check(z.superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Codex public headers must be omitted when empty' });
  }
}));

const CodexCredentialEnvHeadersV1Schema = z.record(
  z.string().check(z.minLength(1)),
  z.literal(CODEX_PROVIDER_SECRET_ENV_KEY),
).check(z.superRefine((value, ctx) => {
  const names = Object.keys(value);
  if (names.length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'Codex provider auth must reference exactly one credential header' });
    return;
  }
  try {
    if (normalizeProviderCredentialHeaderName(names[0] ?? '') !== names[0]) {
      ctx.addIssue({ code: 'custom', message: 'Codex credential header names must be canonical' });
    }
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid Codex credential header name',
    });
  }
}));

const CodexProviderInfoV1Schema = z.strictObject({
  name: z.literal('Happier provider'),
  base_url: ProviderEndpointUrlSyntaxSchema,
  wire_api: z.literal('responses'),
  env_key: z.optional(z.literal(CODEX_PROVIDER_SECRET_ENV_KEY)),
  http_headers: z.optional(CodexPublicHeadersV1Schema),
  env_http_headers: z.optional(CodexCredentialEnvHeadersV1Schema),
  requires_openai_auth: z.literal(false),
  supports_websockets: z.literal(false),
}).check(z.superRefine((value, ctx) => {
  if (value.env_key && value.env_http_headers) {
    ctx.addIssue({ code: 'custom', message: 'Codex provider auth must use one environment reference mechanism' });
  }
  if (value.http_headers && value.env_http_headers) {
    const publicNames = new Set(Object.keys(value.http_headers).map((name) => name.toLowerCase()));
    const credentialName = Object.keys(value.env_http_headers)[0]?.toLowerCase();
    if (credentialName && publicNames.has(credentialName)) {
      ctx.addIssue({ code: 'custom', message: 'Codex public and credential headers must not compete' });
    }
  }
}));

export type CodexProviderBindingEngineConfigV1 = {
  v: 1;
  modelProvider: string;
  config: Record<string, 'none' | number | {
    name: 'Happier provider';
    base_url: string;
    wire_api: 'responses';
    env_key?: typeof CODEX_PROVIDER_SECRET_ENV_KEY;
    http_headers?: Record<string, string>;
    env_http_headers?: Record<string, typeof CODEX_PROVIDER_SECRET_ENV_KEY>;
    requires_openai_auth: false;
    supports_websockets: false;
  }>;
};

export const CodexProviderBindingEngineConfigV1Schema: z.ZodMiniType<CodexProviderBindingEngineConfigV1> = z.strictObject({
  v: z.literal(1),
  modelProvider: z.string().check(z.minLength(1), z.maxLength(128)),
  config: z.record(z.string(), z.union([
    CodexProviderInfoV1Schema,
    z.literal('none'),
    z.int().check(z.gt(0)),
  ])),
}).check(z.superRefine((value, ctx) => {
  const keys = Object.keys(value.config);
  for (const key of keys) {
    const field = value.config[key];
    if ((key === CODEX_MODEL_REASONING_EFFORT_KEY) !== (field === 'none')) {
      ctx.addIssue({
        code: 'custom',
        path: ['config', key],
        message: 'Codex reasoning disablement is valid only at model_reasoning_effort',
      });
    }
    if ((key === 'model_context_window') !== (typeof field === 'number')) {
      ctx.addIssue({ code: 'custom', path: ['config', key], message: 'Codex context window is valid only at model_context_window' });
    }
  }
  const providerKeys = keys.filter((key) => key !== CODEX_MODEL_REASONING_EFFORT_KEY && key !== 'model_context_window');
  if (RESERVED_CODEX_PROVIDER_KEYS.has(value.modelProvider)) {
    if (providerKeys.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['config'], message: 'Reserved Codex providers cannot be overridden' });
    }
    return;
  }
  if (!CUSTOM_CODEX_PROVIDER_KEY_PATTERN.test(value.modelProvider)) {
    ctx.addIssue({ code: 'custom', path: ['modelProvider'], message: 'Invalid Happier Codex provider key' });
    return;
  }
  const expectedKey = `model_providers.${value.modelProvider}`;
  if (providerKeys.length !== 1 || providerKeys[0] !== expectedKey) {
    ctx.addIssue({ code: 'custom', path: ['config'], message: 'Codex provider config must contain its exact prepared key' });
  }
}));

export function parseCodexProviderBindingEngineConfigV1(
  input: unknown,
): CodexProviderBindingEngineConfigV1 | null {
  if (input === null) return null;
  const binding = AgentSessionProviderBindingV1Schema.parse(input);
  if (binding.materialization.kind !== 'engineConfig') {
    throw new Error('Codex provider binding materialization must use engine config');
  }
  return CodexProviderBindingEngineConfigV1Schema.parse(binding.materialization.engineConfig);
}
