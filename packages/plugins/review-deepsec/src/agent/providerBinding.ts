import type {
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentSessionProviderBinding,
} from '@happier-dev/plugin-sdk/agents/runtime';

export const DEEPSEC_PROVIDER_ENV_KEYS = Object.freeze([
  'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
] as const);

export function buildDeepSecLaunchEnvironment(values: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  // Empty values suppress repository dotenv and competing ambient credentials,
  // including when the selected route uses a stored native login.
  return Object.freeze(Object.fromEntries(DEEPSEC_PROVIDER_ENV_KEYS.map(name => [name, values[name] ?? ''])));
}

export type DeepSecProviderRoute = Readonly<{
  agent: 'codex';
  provider: 'openai';
  model: string;
  baseUrl: string;
}>;

export function resolveDeepSecProviderRoute(input: Readonly<{
  protocol: string;
  normalizedUrl: string | null;
  model: string;
}>): DeepSecProviderRoute {
  if (input.protocol !== 'openai-responses') {
    throw new Error('DeepSec Provider binding requires OpenAI Responses protocol');
  }
  if (!input.normalizedUrl || !input.model.trim()) throw new Error('DeepSec Provider binding requires an endpoint and model');
  const url = new URL(input.normalizedUrl);
  // DeepSec 2.3.10 codex-sdk.ts appends /v1 unless the supplied URL ends in
  // /v1. Refuse endpoints it would silently rewrite, including query strings.
  if (!/\/v1\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('DeepSec Responses endpoint must end in /v1 without a query or fragment');
  }
  return {
    agent: 'codex',
    provider: 'openai',
    model: input.model,
    baseUrl: input.normalizedUrl,
  };
}

async function materialize(input: AgentProviderBindingMaterializeInput) {
  if (input.prepared.materialization !== 'spawnEnv') throw new Error('DeepSec Provider binding requires a spawn environment');
  const route = resolveDeepSecProviderRoute({ ...input.binding.endpoint, model: input.binding.selection.model.id });
  if (Object.keys(input.binding.endpoint.publicHeaders).length) throw new Error('DeepSec Provider binding cannot preserve custom public headers');
  if (input.credential.kind !== 'apiKey') throw new Error('DeepSec Provider binding requires an API key to suppress native subscription fallback');
  // The host admits the value, protocol and runtime use before materialization;
  // this adapter maps only the native bearer destination it can forward.
  const { transport, value } = input.credential;
  if (transport.destination.kind !== 'httpHeader' || transport.destination.name.toLowerCase() !== 'authorization'
    || transport.destination.format !== 'bearer') {
    throw new Error('DeepSec Provider binding does not support this credential transport');
  }
  const values = buildDeepSecLaunchEnvironment({
    OPENAI_API_KEY: value,
    OPENAI_BASE_URL: route.baseUrl,
  });
  return { v: 1 as const, kind: 'spawnEnv' as const,
    env: DEEPSEC_PROVIDER_ENV_KEYS.map(name => ({ name, value: values[name], source: 'provider' as const })) };
}

export const DEEPSEC_PROVIDER_BINDING_ADAPTER_V1: AgentProviderBindingAdapter = Object.freeze({
  v: 1, adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'spawnEnv' as const }),
  materialize,
});

export function readDeepSecProviderLaunch(binding: AgentSessionProviderBinding, environment: Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}> | undefined) {
  if (binding.materialization.kind !== 'spawnEnv' || binding.upstream.credential !== 'apiKey') {
    throw new Error('DeepSec Provider binding requires a materialized API key environment');
  }
  const route = resolveDeepSecProviderRoute({ ...binding.upstream, model: binding.model.id });
  const unset = new Set(environment?.unset.map(key => key.toUpperCase()));
  const provided = new Map(Object.entries(environment?.values ?? {}).map(([key, value]) => [key.toUpperCase(), value]));
  const key = provided.get('OPENAI_API_KEY');
  if (unset.has('OPENAI_API_KEY') || !key?.trim()) throw new Error('DeepSec Provider credential is unavailable in the admitted launch environment');
  return { route, environment: buildDeepSecLaunchEnvironment({ OPENAI_API_KEY: key, OPENAI_BASE_URL: route.baseUrl }) };
}
