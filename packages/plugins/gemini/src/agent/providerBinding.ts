import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';

export const GEMINI_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_CLI_CUSTOM_HEADERS',
  'GEMINI_API_KEY_AUTH_MECHANISM', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA',
  'GEMINI_CLI_AUTH_OVERRIDE',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS',
  'HAPPIER_GEMINI_ACP_AUTH_METHOD', 'HAPPIER_GEMINI_ACP_AUTH_META',
] as const);

function materialize(input: AgentProviderBindingMaterializeInput) {
  if (input.prepared.materialization !== 'spawnEnv' || input.binding.endpoint.protocol !== 'gemini') {
    throw new Error('Gemini Provider binding requires the Gemini wire protocol and spawn environment');
  }
  if (input.credential.kind !== 'apiKey') throw new Error('Gemini Provider binding requires an API key');
  // Native resolveModel/defaultModelConfigs may reinterpret these public IDs.
  // Keep a Provider selection literal; never reproduce native rollout routing.
  if (['auto', 'pro', 'flash', 'flash-lite', 'auto-gemini-2.5', 'auto-gemini-3', 'none',
    'gemini-3-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-3.1-flash-lite']
    .includes(input.binding.selection.model.id)) {
    throw new Error('Gemini cannot preserve this literal model selection');
  }
  const { transport, value } = input.credential;
  if (!value || JSON.stringify(transport) !== JSON.stringify(input.binding.runtimeCredentialTransport)
    || !transport.protocols.includes('gemini') || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader' || transport.destination.name.toLowerCase() !== 'x-goog-api-key'
    || transport.destination.format !== 'raw') {
    throw new Error('Gemini Provider binding does not support this credential transport');
  }
  const headers = Object.entries(input.binding.endpoint.publicHeaders);
  if (headers.some(([name]) => name.toLowerCase() === 'x-goog-api-key')) {
    throw new Error('Gemini Provider public header competes with its credential');
  }
  // Native comma-separated headers have no escaping for a comma followed by
  // another header-like token. Refuse that ambiguous shape instead of changing it.
  if (headers.some(([, headerValue]) => /,(?=\s*[\w!#$%&'*+.^`|~-]+\s*:)/u.test(headerValue))) {
    throw new Error('Gemini cannot preserve this public header value');
  }
  const values: Readonly<Record<string, string | null>> = {
    GEMINI_API_KEY: value,
    GEMINI_MODEL: input.binding.selection.model.id,
    GOOGLE_GEMINI_BASE_URL: input.binding.endpoint.normalizedUrl,
    GEMINI_CLI_CUSTOM_HEADERS: headers.length ? headers.map(([name, headerValue]) => `${name}: ${headerValue}`).join(', ') : null,
  };
  return { v: 1 as const, kind: 'spawnEnv' as const,
    env: GEMINI_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: values[name] ?? null, source: 'provider' as const })) };
}

/** Gemini CLI's native GoogleGenAI client consumes only Gemini wire requests. */
export const GEMINI_PROVIDER_BINDING_ADAPTER_V1: AgentProviderBindingAdapter = Object.freeze({
  v: 1, adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'spawnEnv' as const }),
  materialize,
});
