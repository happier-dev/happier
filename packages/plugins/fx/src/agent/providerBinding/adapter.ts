import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';

export const FX_GATEWAY_CONNECTION_URL = 'https://ai-gateway.vercel.sh/coding-agent/v1';
export const FX_PROVIDER_OWNED_ENV_KEYS = [
  'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'HAPPIER_FX_PROVIDER_API_KEY', 'FX_PROVIDER', 'FX_MODEL', 'FX_AUTH_MODE', 'FX_HOME',
  'FX_GATEWAY_BASE_URL', 'FX_E2E_GATEWAY_CHAT_URL', 'FX_E2E_GATEWAY_MODELS_URL', 'FX_E2E_GATEWAY_CREDITS_URL',
] as const;

/** Native configured-provider settings shared by Provider and account launch. */
export function buildFxConfiguredProviderSettings(input: Readonly<{ modelId: string; baseUrl: string; hasCredential: boolean }>) {
  return { provider: 'happier', models: { happier: input.modelId },
    providers: { happier: { protocol: 'openai-chat-completions', base_url: input.baseUrl,
      auth: input.hasCredential ? { type: 'bearer', env: 'HAPPIER_FX_PROVIDER_API_KEY' } : { type: 'none' }, tool_choice_mode: 'omit' } } };
}

const unsupported = () => new PluginError({ code: 'fx_provider_binding_unsupported',
  message: 'FX supports Chat Completions endpoints with no authentication or a bearer API key. Custom headers and additional credentials are unsupported.' });

export const FX_PROVIDER_BINDING_ADAPTER = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1, materialization: 'configFile' }),
  materialize(input: AgentProviderBindingMaterializeInput) {
    const { binding, credential } = input;
    if (input.prepared.materialization !== 'configFile' || binding.endpoint.protocol !== 'openai-chat') throw unsupported();
    // Only this exact existing contribution selects FX's proprietary Gateway
    // driver. Ordinary Chat endpoints use native configured-provider settings.
    const gateway = binding.contributionKey === 'happier.provider.vercel-ai-gateway/vercel-ai-gateway'
      && binding.endpoint.endpointTemplateId === 'vercel-chat'
      && binding.endpoint.normalizedUrl === FX_GATEWAY_CONNECTION_URL;
    const attribution: Readonly<Record<string, string>> = { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' };
    if (Object.entries(binding.endpoint.publicHeaders).some(([name, value]) => !gateway || attribution[name.toLowerCase()] !== value)) throw unsupported();
    if (credential.kind === 'apiKey') {
      if (!credential.value.trim() || credential.additionalCredentials?.length || credential.transport.additionalCredentials?.length
        || !credential.transport.protocols.includes('openai-chat') || !credential.transport.uses.includes('runtime')
        || credential.transport.destination.kind !== 'httpHeader'
        || credential.transport.destination.name.toLowerCase() !== 'authorization'
        || credential.transport.destination.format !== 'bearer') throw unsupported();
    } else if (gateway) throw unsupported();
    const provider = gateway ? 'gateway' : 'happier';
    const settings = gateway ? {
      provider, credential_source: 'ai_gateway_api_key', models: { [provider]: binding.selection.model.id },
    } : buildFxConfiguredProviderSettings({ modelId: binding.selection.model.id,
      baseUrl: binding.endpoint.normalizedUrl, hasCredential: credential.kind !== 'none' });
    // Native saved model preferences take precedence over FX_MODEL. Overlay
    // selected settings in the host-owned home while retaining native history.
    const values: Readonly<Record<string, string>> = {
      ...(credential.kind === 'apiKey' ? { [gateway ? 'AI_GATEWAY_API_KEY' : 'HAPPIER_FX_PROVIDER_API_KEY']: credential.value } : {}),
      FX_PROVIDER: provider, FX_MODEL: binding.selection.model.id, FX_AUTH_MODE: 'local',
    };
    return { v: 1, kind: 'configFile', nativeHome: true,
      files: [{ relativePath: '.fx/settings.json', utf8: JSON.stringify(settings), merge: 'jsonObject' }],
      env: FX_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: values[name] ?? null, source: 'provider' })),
    };
  },
} satisfies AgentProviderBindingAdapter);
