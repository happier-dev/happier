import type { AgentProviderBindingAdapter, AgentProviderBindingMaterializeInput } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildDroidModelSettings, DROID_PROVIDER_OWNED_ENV_KEYS, DROID_PROVIDER_SETTINGS_PATH } from './settings.js';
export { DROID_PROVIDER_OWNED_ENV_KEYS, DROID_PROVIDER_SECRET_ENV, DROID_PROVIDER_SETTINGS_PATH, droidProviderModelDisplayName } from './settings.js';

const NATIVE_PROVIDER_BY_PROTOCOL = {
  'openai-chat': 'generic-chat-completion-api',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
} as const;

export const DROID_PROVIDER_BINDING_ADAPTER = Object.freeze({
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1, materialization: 'configFile' }),
  materialize(input: AgentProviderBindingMaterializeInput) {
    const protocol = input.binding.endpoint.protocol;
    if (!Object.hasOwn(NATIVE_PROVIDER_BY_PROTOCOL, protocol)) throw new Error('Droid does not support this Provider protocol');
    if (input.prepared.materialization !== 'configFile') throw new Error('Droid requires its session settings file');
    const provider = NATIVE_PROVIDER_BY_PROTOCOL[protocol as keyof typeof NATIVE_PROVIDER_BY_PROTOCOL];
    let secret: string | null = null;
    let authMode: 'bearer' | undefined;
    if (input.credential.kind === 'none') {
      if (input.binding.runtimeCredentialTransport !== null) throw new Error('Droid credential does not match its selected transport');
    } else {
      const { transport, value } = input.credential;
      if (!value || JSON.stringify(transport) !== JSON.stringify(input.binding.runtimeCredentialTransport)
        || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime')
        || transport.destination.kind !== 'httpHeader') throw new Error('Droid credential does not match its selected transport');
      const { name, format } = transport.destination;
      const bearer = name.toLowerCase() === 'authorization' && format === 'bearer';
      if (!(bearer || (protocol === 'anthropic' && name.toLowerCase() === 'x-api-key' && format === 'raw'))) {
        throw new Error('Droid does not support this credential transport');
      }
      if (protocol === 'anthropic' && bearer) authMode = 'bearer';
      secret = value;
    }
    // Factory documents ${VAR} interpolation for apiKey. Only the child
    // environment contains the credential; settings are process-only via --settings.
    // https://docs.factory.com/model-independence/byok
    const settings = buildDroidModelSettings({
      modelId: input.binding.selection.model.id,
      baseUrl: input.binding.endpoint.normalizedUrl,
      provider,
      headers: input.binding.endpoint.publicHeaders,
      hasCredential: secret !== null,
      ...(authMode ? { authMode } : {}),
    });
    return { v: 1, kind: 'configFile',
      env: DROID_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: secret, source: 'provider' })),
      files: [{ relativePath: DROID_PROVIDER_SETTINGS_PATH, utf8: settings }],
    };
  },
} satisfies AgentProviderBindingAdapter);
