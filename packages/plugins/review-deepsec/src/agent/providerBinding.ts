import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentExecutionRunOpenRequest, AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

export const DEEPSEC_PROVIDER_ENV_KEYS = Object.freeze([
  'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
] as const);

export function buildDeepSecLaunchEnvironment(values: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  // Empty values suppress repository dotenv and competing ambient credentials,
  // including when the selected route uses a stored native login.
  return Object.freeze({ ...values, ...Object.fromEntries(DEEPSEC_PROVIDER_ENV_KEYS.map(name => [name, values[name] ?? ''])) });
}

export function readDeepSecLaunchEnvironment(environment: AgentExecutionRunOpenRequest['launchEnvironment']) {
  const unset = new Set(environment?.unset.map(key => key.toUpperCase()));
  return Object.fromEntries(Object.entries(environment?.values ?? {})
    .map(([key, value]) => [key, unset.has(key.toUpperCase()) ? '' : value]));
}

export function omitDeepSecProviderEnvironment(values: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(values).filter(([key]) =>
    !DEEPSEC_PROVIDER_ENV_KEYS.some(owned => owned === key.toUpperCase())));
}

export type DeepSecProviderRoute = Readonly<{
  model: string;
  baseUrl: string;
}> & (Readonly<{ agent: 'codex'; provider: 'openai' }> | Readonly<{ agent: 'claude'; provider: 'anthropic' }>);

function isConfigObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

export function resolveDeepSecProviderRoute(input: Readonly<{
  protocol: string;
  normalizedUrl: string | null;
  model: string;
}>): DeepSecProviderRoute {
  if (input.protocol !== 'openai-responses') {
    throw new PluginError({ code: 'deepsec_provider_transport_unsupported', message: 'DeepSec Codex requires OpenAI Responses protocol.' });
  }
  if (!input.normalizedUrl || !input.model.trim()) throw new Error('DeepSec Provider binding requires an endpoint and model');
  const url = new URL(input.normalizedUrl);
  // DeepSec 2.3.10 codex-sdk.ts appends /v1 unless the supplied URL ends in
  // /v1. Refuse endpoints it would silently rewrite, including query strings.
  if (!/\/v1\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new PluginError({ code: 'deepsec_provider_endpoint_unsupported', message: 'DeepSec Responses endpoint must end in /v1 without a query or fragment' });
  }
  return {
    agent: 'codex',
    provider: 'openai',
    model: input.model,
    baseUrl: input.normalizedUrl,
  };
}

/** Consume the runner owner's materialization; DeepSec does not read Codex
 * config.toml, so its SDK needs the selected bearer under OPENAI_API_KEY. */
export function readDeepSecProviderLaunch(binding: AgentSessionProviderBinding, environment: Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}> | undefined) {
  const values = readDeepSecLaunchEnvironment(environment);
  const nativeValues = omitDeepSecProviderEnvironment(values);
  const unsupported = () => new PluginError({ code: 'deepsec_provider_transport_unsupported',
    message: 'DeepSec cannot preserve the selected runner Provider transport. Choose another model access route.' });
  if (binding.upstream.protocol === 'anthropic' && binding.materialization.kind === 'spawnEnv') {
    if (!binding.upstream.normalizedUrl || values.ANTHROPIC_CUSTOM_HEADERS
      || !(values.ANTHROPIC_API_KEY || values.ANTHROPIC_AUTH_TOKEN)) throw unsupported();
    const route: DeepSecProviderRoute = { agent: 'claude', provider: 'anthropic', model: binding.model.id,
      baseUrl: binding.upstream.normalizedUrl };
    return { route, environment: buildDeepSecLaunchEnvironment({ ...nativeValues,
      ANTHROPIC_API_KEY: values.ANTHROPIC_API_KEY ?? '', ANTHROPIC_AUTH_TOKEN: values.ANTHROPIC_AUTH_TOKEN ?? '',
      ANTHROPIC_BASE_URL: route.baseUrl }) };
  }
  const route = resolveDeepSecProviderRoute({ ...binding.upstream, model: binding.model.id });
  let key = values.OPENAI_API_KEY;
  if (binding.materialization.kind === 'engineConfig') {
    const { modelProvider, config } = binding.materialization.engineConfig;
    if (typeof modelProvider !== 'string' || !isConfigObject(config)) throw unsupported();
    const provider = config[`model_providers.${modelProvider}`];
    if (!isConfigObject(provider)
      || typeof provider.env_key !== 'string' || provider.http_headers || provider.env_http_headers) throw unsupported();
    key = values[provider.env_key];
  } else if (binding.materialization.kind !== 'spawnEnv') throw unsupported();
  if (!key?.trim()) throw unsupported();
  return { route, environment: buildDeepSecLaunchEnvironment({ ...nativeValues,
    OPENAI_API_KEY: key, OPENAI_BASE_URL: route.baseUrl }) };
}
