import { join } from 'node:path';
import type { AgentAcpModelControls, AgentProviderBindingAdapter, AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES } from './auth/services/accountPurposes.js';

const PROVIDER_ID = 'happier-provider';
const SECRET_ENV_KEY = 'HAPPIER_OH_MY_PI_PROVIDER_API_KEY';
const EXTENSION_PATH = 'provider.mjs';
export const OH_MY_PI_PROVIDER_OWNED_ENV_KEYS = Object.freeze([
  SECRET_ENV_KEY, ...OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.map(row => row.launchEnvironmentKey),
]);

export const OH_MY_PI_PROVIDER_BINDING_ADAPTER = {
  v: 1, adapterVersion: 1,
  prepare: () => ({ v: 1, materialization: 'configFile' }),
  materialize(input) {
    if (input.credential.kind !== 'apiKey') throw new Error('Oh My Pi Responses requires a bearer credential');
    const publicHeaders = Object.entries(input.binding.endpoint.publicHeaders);
    // Native string configuration treats an empty environment value as a missing reference.
    if (publicHeaders.some(([, value]) => value === '')) {
      throw new Error('Oh My Pi cannot preserve an empty public header value');
    }
    const model = input.binding.selection.model;
    const credential = input.credential.value;
    const headers = publicHeaders.map(([name, value], index) => ({
      name, value, reference: `HAPPIER_OH_MY_PI_PROVIDER_HEADER_${index}`,
    }));
    const headerEnvironment = Object.fromEntries(headers.map(header => [header.reference, header.value]));
    const config = {
      api: 'openai-responses', baseUrl: input.binding.endpoint.normalizedUrl,
      headers: Object.fromEntries(headers.map(header => [header.name, header.reference])),
      // OMP's native custom-model owner supplies its defaults for omitted facts.
      models: [{ id: model.id, name: model.name, ...(model.capabilities?.reasoningControls === 'supported' ? { reasoning: true } : model.capabilities?.reasoningControls === 'unsupported' ? { reasoning: false } : {}), ...(model.contextWindowTokens === undefined ? {} : { contextWindow: model.contextWindowTokens }) }],
    };
    return {
      v: 1, kind: 'configFile', nativeHome: true,
      env: OH_MY_PI_PROVIDER_OWNED_ENV_KEYS.map(name => ({ name, value: name === SECRET_ENV_KEY ? credential : null, source: 'provider' as const })),
      files: [{ relativePath: EXTENSION_PATH, utf8: `export default function(pi) { Object.assign(process.env, ${JSON.stringify(headerEnvironment)}); pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, { ...${JSON.stringify(config)}, apiKey: ${JSON.stringify(SECRET_ENV_KEY)} }); }\n` }],
    };
  },
} satisfies AgentProviderBindingAdapter;

export function ohMyPiProviderLaunchArgs(binding: AgentSessionProviderBinding | undefined): readonly string[] {
  if (!binding) return [];
  if (binding.materialization.kind !== 'configFile') throw new Error('Oh My Pi requires its Provider configuration');
  // The native loader defers this qualified model until extensions register.
  return ['--extension', join(binding.materialization.rootPath, EXTENSION_PATH), '--model', nativeProviderModelId(binding.model.id)];
}

function nativeProviderModelId(modelId: string): string {
  return `${PROVIDER_ID}/${modelId}`;
}

export function ohMyPiProviderModelControls(binding: AgentSessionProviderBinding | undefined): AgentAcpModelControls {
  if (!binding) return { catalogConfidence: 'account_unverified', projectModel: (_raw, model) => model };
  const canonicalId = binding.model.id;
  const nativeId = nativeProviderModelId(canonicalId);
  const decode = (id: string) => id === nativeId ? canonicalId : id;
  return {
    catalogConfidence: 'account_unverified',
    projectModel: (_raw, model) => model,
    projectModelId: ({ modelId }) => decode(modelId),
    projectModelState: ({ normalizedModelState }) => ({
      currentModelId: decode(normalizedModelState.currentModelId),
      availableModels: normalizedModelState.availableModels.map(model => ({ ...model, id: decode(model.id) })),
    }),
    resolveModelUpdate: ({ modelId }) => {
      if (modelId !== canonicalId && modelId !== nativeId) {
        throw new Error('Oh My Pi model selection does not match the Session Provider binding');
      }
      return { modelId: nativeId };
    },
  };
}
