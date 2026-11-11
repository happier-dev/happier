import type {
  AgentAcpModelControls,
  AgentProviderBindingAdapter,
  AgentProviderBindingMaterializeInput,
  AgentSessionProviderBinding,
} from '@happier-dev/plugin-sdk/agents/runtime';

export const QWEN_PROVIDER_SECRET_ENV_KEY = 'HAPPIER_QWEN_PROVIDER_API_KEY';
export const QWEN_PROVIDER_SETTINGS_PATH = 'settings.json';
export const QWEN_PROVIDER_OWNED_ENV_KEYS = Object.freeze([QWEN_PROVIDER_SECRET_ENV_KEY, 'QWEN_CODE_SYSTEM_SETTINGS_PATH'] as const);

function sameTransport(left: AgentProviderBindingMaterializeInput['binding']['runtimeCredentialTransport'], right: AgentProviderBindingMaterializeInput['credential'] extends infer T ? T extends { transport: infer U } ? U : never : never): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function assertCredential(input: AgentProviderBindingMaterializeInput, protocol: 'openai-chat' | 'openai-responses'): string {
  if (input.credential.kind !== 'apiKey') throw new Error('Qwen OpenAI transport requires an API key');
  const { transport, value } = input.credential;
  if (!value || !sameTransport(input.binding.runtimeCredentialTransport, transport)
    || !transport.protocols.includes(protocol) || !transport.uses.includes('runtime')
    || transport.destination.kind !== 'httpHeader'
    || transport.destination.name.toLowerCase() !== 'authorization'
    || transport.destination.format !== 'bearer') {
    throw new Error('Qwen Provider binding credential does not match its selected transport');
  }
  return value;
}

export const QWEN_PROVIDER_BINDING_ADAPTER = {
  v: 1,
  adapterVersion: 1,
  prepare: () => ({ v: 1 as const, materialization: 'configFile' as const }),
  materialize(input) {
    if (input.prepared.materialization !== 'configFile') throw new Error('Qwen requires its settings file');
    const protocol = input.binding.endpoint.protocol;
    if (protocol !== 'openai-chat' && protocol !== 'openai-responses') throw new Error('Qwen supports OpenAI Chat or Responses providers only');
    const model = input.binding.selection.model;
    const apiKey = assertCredential(input, protocol);
    const customHeaders = input.binding.endpoint.publicHeaders;
    return {
      v: 1 as const,
      kind: 'configFile' as const,
      nativeHome: true as const,
      env: [{ name: QWEN_PROVIDER_SECRET_ENV_KEY, value: apiKey, source: 'provider' as const },
        { name: 'QWEN_CODE_SYSTEM_SETTINGS_PATH', value: null, source: 'provider' as const }],
      files: [{ relativePath: QWEN_PROVIDER_SETTINGS_PATH, utf8: JSON.stringify({
        $version: 4,
        modelProviders: { openai: [{ id: model.id, envKey: QWEN_PROVIDER_SECRET_ENV_KEY,
          baseUrl: input.binding.endpoint.normalizedUrl,
          ...(protocol === 'openai-responses' ? { wireApi: 'responses' as const } : {}),
          ...(Object.keys(customHeaders).length ? { generationConfig: { customHeaders } } : {}) }] },
        security: { auth: { selectedType: 'openai' } },
        model: { name: model.id, baseUrl: input.binding.endpoint.normalizedUrl },
      }) }],
    };
  },
} satisfies AgentProviderBindingAdapter;

function nativeModelId(modelId: string): string { return `${modelId}(openai)`; }

export function qwenProviderLaunchArgs(binding: AgentSessionProviderBinding): readonly string[] {
  if (binding.materialization.kind !== 'configFile'
    || binding.materialization.relativePaths.length !== 1
    || binding.materialization.relativePaths[0] !== QWEN_PROVIDER_SETTINGS_PATH) {
    throw new Error('Qwen requires its canonical Provider settings file');
  }
  return ['--auth-type', 'openai', '--model', binding.model.id];
}

export function qwenProviderModelControls(binding: AgentSessionProviderBinding): AgentAcpModelControls {
  const canonical = binding.model.id;
  const qualified = nativeModelId(canonical);
  const decode = (id: string) => id === qualified ? canonical : id;
  return {
    catalogConfidence: 'account_unverified',
    projectModel: (_raw, model) => ({ ...model, id: decode(model.id) }),
    projectModelId: ({ modelId }) => decode(modelId),
    projectModelState: ({ normalizedModelState }) => ({
      currentModelId: decode(normalizedModelState.currentModelId),
      availableModels: normalizedModelState.availableModels.filter(model => model.id === qualified)
        .map(model => ({ ...model, id: canonical, name: binding.model.name })),
    }),
    resolveModelUpdate: ({ modelId }) => {
      if (modelId !== canonical && modelId !== qualified) throw new Error('Restart Qwen Code to apply a different Provider model');
      return { modelId: qualified };
    },
  };
}
