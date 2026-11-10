import type { AgentProviderBindingAdapter } from '@happier-dev/plugin-sdk/agents/runtime';
import { PI_CONNECTED_ACCOUNT_MODEL_ENV, PI_DIRECT_AUTH_ENV_KEYS, PI_PROVIDER_SECRET_ENV_KEY } from './launchEnvironment.js';
import { PI_REQUEST_AUTH_CAPABILITY_PATH_ENV, PI_REQUEST_AUTH_PRODUCER_VERSION_ENV } from './auth/services/requestAuth/env.js';

export const PI_PROVIDER_ID = 'happier-provider';
const SECRET_ENV_KEY = PI_PROVIDER_SECRET_ENV_KEY;
export const PI_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  SECRET_ENV_KEY, PI_CONNECTED_ACCOUNT_MODEL_ENV, ...PI_DIRECT_AUTH_ENV_KEYS, PI_REQUEST_AUTH_CAPABILITY_PATH_ENV, PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
]);

// Pi models.json interprets only key/header values as native config expressions.
// Escape literal data so it remains literal under its public template grammar.
function nativeLiteral(value: string): string {
  const escaped = value.replaceAll('$', () => '$$');
  return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

export const PI_PROVIDER_BINDING_ADAPTER = {
  v: 1, adapterVersion: 1,
  prepare: () => ({ v: 1, materialization: 'configFile' }),
  materialize(input) {
    if (input.credential.kind !== 'apiKey') throw new Error('Pi Responses requires a bearer credential');
    const model = input.binding.selection.model;
    const credential = input.credential.value;
    return {
      v: 1, kind: 'configFile', nativeHome: true,
      env: PI_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: name === SECRET_ENV_KEY ? credential : null, source: 'provider' as const })),
      files: [{ relativePath: 'models.json', utf8: JSON.stringify({ providers: { [PI_PROVIDER_ID]: {
        api: 'openai-responses', baseUrl: input.binding.endpoint.normalizedUrl,
        apiKey: '${HAPPIER_PI_PROVIDER_API_KEY}',
        headers: Object.fromEntries(Object.entries(input.binding.endpoint.publicHeaders).map(([name,value]) => [name,nativeLiteral(value)])),
        models: [{ id: model.id, name: model.name, ...(model.capabilities?.reasoningControls === 'supported' ? { reasoning: true } : model.capabilities?.reasoningControls === 'unsupported' ? { reasoning: false } : {}), ...(model.contextWindowTokens === undefined ? {} : { contextWindow: model.contextWindowTokens }) }],
      } } }) }],
    };
  },
} satisfies AgentProviderBindingAdapter;
