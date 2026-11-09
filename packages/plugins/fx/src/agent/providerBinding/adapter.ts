import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';

export const FX_GATEWAY_CONNECTION_URL = 'https://ai-gateway.vercel.sh/coding-agent/v1';
export const FX_PROVIDER_OWNED_ENV_KEYS = [
  'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'FX_PROVIDER', 'FX_MODEL', 'FX_AUTH_MODE',
  'FX_GATEWAY_BASE_URL', 'FX_E2E_GATEWAY_CHAT_URL', 'FX_E2E_GATEWAY_MODELS_URL', 'FX_E2E_GATEWAY_CREDITS_URL',
] as const;

const unsupported = () => new PluginError({ code: 'fx_provider_binding_unsupported',
  message: 'FX supports the Vercel AI Gateway API-key connection. Custom endpoints, headers and credential-free connections require native FX settings and cannot be materialized through process environment.' });

export const FX_PROVIDER_BINDING_ADAPTER = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1, materialization: 'spawnEnv' }),
  materialize(input: AgentProviderBindingMaterializeInput) {
    const { binding, credential } = input;
    // FX's native Gateway driver uses its own Vercel protocol and fixed origin.
    // The declared Chat endpoint identifies the existing Gateway connection;
    // accepting its protocol alone would silently redirect custom connections.
    // Native custom providers require ~/.fx/settings.json, which we never write.
    if (input.prepared.materialization !== 'spawnEnv'
      || binding.contributionKey !== 'happier.provider.vercel-ai-gateway/vercel-ai-gateway'
      || binding.endpoint.endpointTemplateId !== 'vercel-chat'
      || binding.endpoint.protocol !== 'openai-chat'
      || binding.endpoint.normalizedUrl !== FX_GATEWAY_CONNECTION_URL) throw unsupported();
    const attribution: Readonly<Record<string, string>> = { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' };
    if (Object.entries(binding.endpoint.publicHeaders).some(([name, value]) => attribution[name.toLowerCase()] !== value)) throw unsupported();
    if (credential.kind !== 'apiKey' || !credential.value.trim()
      || !credential.transport.protocols.includes('openai-chat') || !credential.transport.uses.includes('runtime')
      || credential.transport.destination.kind !== 'httpHeader'
      || credential.transport.destination.name.toLowerCase() !== 'authorization'
      || credential.transport.destination.format !== 'bearer') throw unsupported();
    // FX_AUTH_MODE=host-managed deliberately sends no local authorization.
    // Local mode uses the selected key; the factory verifies that a saved
    // credential preference did not supersede it before starting ACP.
    const values: Readonly<Record<string, string>> = { AI_GATEWAY_API_KEY: credential.value,
      FX_PROVIDER: 'gateway', FX_MODEL: binding.selection.model.id, FX_AUTH_MODE: 'local' };
    return { v: 1, kind: 'spawnEnv', env: FX_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: values[name] ?? null, source: 'provider' })) };
  },
} satisfies AgentProviderBindingAdapter);
