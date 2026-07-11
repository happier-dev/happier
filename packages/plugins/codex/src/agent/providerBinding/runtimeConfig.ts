import { z } from 'zod';
import {
  normalizeProviderCredentialHeaderName,
  ProviderEndpointUrlSyntaxSchema,
  ProviderPublicHeadersV1Schema,
} from '@happier-dev/protocol';

const CODEX_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_CODEX_PROVIDER_API_KEY';
const CUSTOM_CODEX_PROVIDER_KEY_PATTERN = /^happier_[a-f0-9]{32}$/u;
const RESERVED_CODEX_PROVIDER_KEYS = new Set(['ollama', 'lmstudio']);

const CodexPublicHeadersV1Schema = ProviderPublicHeadersV1Schema.superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Codex public headers must be omitted when empty' });
  }
});

const CodexCredentialEnvHeadersV1Schema = z.record(
  z.string().min(1),
  z.literal(CODEX_PROVIDER_SECRET_ENV_KEY),
).superRefine((value, ctx) => {
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
});

const CodexProviderInfoV1Schema = z.object({
  name: z.literal('Happier provider'),
  base_url: ProviderEndpointUrlSyntaxSchema,
  wire_api: z.literal('responses'),
  env_key: z.literal(CODEX_PROVIDER_SECRET_ENV_KEY).optional(),
  http_headers: CodexPublicHeadersV1Schema.optional(),
  env_http_headers: CodexCredentialEnvHeadersV1Schema.optional(),
  requires_openai_auth: z.literal(false),
  supports_websockets: z.literal(false),
}).strict().superRefine((value, ctx) => {
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
});

export const CodexProviderBindingEngineConfigV1Schema = z.object({
  v: z.literal(1),
  modelProvider: z.string().min(1).max(128),
  config: z.record(z.string(), CodexProviderInfoV1Schema),
}).strict().superRefine((value, ctx) => {
  const keys = Object.keys(value.config);
  if (RESERVED_CODEX_PROVIDER_KEYS.has(value.modelProvider)) {
    if (keys.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['config'], message: 'Reserved Codex providers cannot be overridden' });
    }
    return;
  }
  if (!CUSTOM_CODEX_PROVIDER_KEY_PATTERN.test(value.modelProvider)) {
    ctx.addIssue({ code: 'custom', path: ['modelProvider'], message: 'Invalid Happier Codex provider key' });
    return;
  }
  const expectedKey = `model_providers.${value.modelProvider}`;
  if (keys.length !== 1 || keys[0] !== expectedKey) {
    ctx.addIssue({ code: 'custom', path: ['config'], message: 'Codex provider config must contain its exact prepared key' });
  }
});

export type CodexProviderBindingEngineConfigV1 = z.infer<typeof CodexProviderBindingEngineConfigV1Schema>;
