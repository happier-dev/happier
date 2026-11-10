import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpModelControls, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, ANTHROPIC_API_KEY_ENV } from '@happier-dev/plugins-claude/connected-account-service';
import { OPENAI_CONNECTED_ACCOUNT_SERVICE, OPENAI_SELECTED_API_KEY_ENV } from '@happier-dev/plugins-openai/connected-account-service';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE, GEMINI_API_KEY_ENV } from '@happier-dev/plugins-gemini/connected-account-service';

export const QWEN_ACCOUNT_SOURCES = [
  { purpose: 'anthropic-api-key', service: ANTHROPIC_CONNECTED_ACCOUNT_SERVICE, protocol: 'anthropic', key: ANTHROPIC_API_KEY_ENV, baseUrl: 'https://api.anthropic.com/v1' },
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, protocol: 'openai', key: OPENAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.openai.com/v1' },
  { purpose: 'google-model', service: GEMINI_CONNECTED_ACCOUNT_SERVICE, protocol: 'gemini', key: GEMINI_API_KEY_ENV, baseUrl: null },
] as const;

export const QWEN_ACCOUNT_ENV_KEYS = ['QWEN_CODE_SYSTEM_SETTINGS_PATH', ANTHROPIC_API_KEY_ENV, 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', OPENAI_SELECTED_API_KEY_ENV, 'OPENAI_BASE_URL', 'OPENAI_MODEL', GEMINI_API_KEY_ENV, 'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;

export async function prepareQwenConnectedAccount(
  request: Pick<AgentSessionOpenRequest, 'configuration' | 'providerBinding'>,
  context: Readonly<{ services: { connectedAccounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> }; signal?: AbortSignal }>,
) {
  const accounts = context.services.connectedAccounts;
  const selections = [];
  for (const source of QWEN_ACCOUNT_SOURCES) {
    const binding = await accounts.getBinding(source.purpose, { signal: context.signal });
    if (binding) selections.push({ source, binding });
  }
  if (selections.length === 0) return null;
  if (selections.length > 1 || request.providerBinding) throw new PluginError({ code: 'qwen_connected_account_conflict',
    message: 'Select one connected model account or Provider for Qwen Code.' });
  const modelId = request.configuration?.model.value?.trim();
  if (!modelId || modelId === 'default') throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Select an explicit model before starting Qwen Code with a connected account.',
    details: { failureCause: { code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
      failureReason: 'model_selection_required', retryable: false } } });
  const { source, binding } = selections[0]!;
  const materialized = await accounts.materialize(source.purpose, { kind: 'environment',
    keys: source.protocol === 'gemini' ? [GEMINI_API_KEY_ENV, 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'] : [source.key],
  }, { signal: context.signal, expectedAccount: binding.account });
  if (materialized.kind !== 'environment') throw new PluginError({ code: 'qwen_account_materialization_invalid', message: 'The selected account did not supply native authentication.' });
  const vertex = source.protocol === 'gemini' && materialized.env.GOOGLE_GENAI_USE_VERTEXAI === '1';
  if (!vertex && !materialized.env[source.key]) throw new PluginError({ code: 'qwen_account_materialization_invalid', message: 'The selected account did not supply its API key.' });
  const directory = createSecureTempDirectorySync({ prefix: 'qwen-account-settings' });
  try {
    const env: Record<string, string> = Object.fromEntries(QWEN_ACCOUNT_ENV_KEYS.map(key => [key, '']));
    Object.assign(env, materialized.env);
    const protocol = vertex ? 'vertex-ai' : source.protocol;
    if (vertex) {
      const files = await accounts.materialize(source.purpose, { kind: 'files', fileIds: ['google-service-account.json'] },
        { signal: context.signal, expectedAccount: binding.account });
      const credentials = files.kind === 'files' ? files.files['google-service-account.json'] : undefined;
      if (!credentials) throw new PluginError({ code: 'qwen_account_materialization_invalid', message: 'The selected service account did not supply its credential file.' });
      env.GOOGLE_APPLICATION_CREDENTIALS = writeSecureTempTextFileSync({ prefix: 'google-service-account', suffix: '.json',
        tmpDir: directory.path, contents: new TextDecoder().decode(credentials) });
    }
    // Qwen Code 0.25.3 system settings replace modelProviders after user/project
    // settings. An explicit envKey prevents saved credentials from taking over;
    // Vertex ADC requires no envKey and an empty saved API-key override.
    env.QWEN_CODE_SYSTEM_SETTINGS_PATH = writeSecureTempTextFileSync({ prefix: 'settings', suffix: '.json', tmpDir: directory.path,
      contents: JSON.stringify({ $version: 4, modelProviders: { [protocol]: [{ id: modelId,
        ...(!vertex ? { envKey: source.key } : {}), ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}) }] },
      security: { auth: { selectedType: protocol, apiKey: '' } }, model: { name: modelId, baseUrl: source.baseUrl ?? '' } }) });
    // Qwen 0.25.3 qualifies ACP model IDs with auth type. This overlay has one
    // selected entry, so its native option is the nonambiguous legacy form.
    const nativeModelId = `${modelId}(${protocol})`;
    const publicModelId = (id: string) => id === nativeModelId ? modelId : id;
    const models: AgentAcpModelControls = {
      catalogConfidence: 'account_unverified',
      projectModel: (_raw, normalized) => ({ ...normalized, id: publicModelId(normalized.id) }),
      projectModelId: ({ modelId: id }) => publicModelId(id),
      projectModelState: ({ normalizedModelState }) => ({ ...normalizedModelState,
        currentModelId: publicModelId(normalizedModelState.currentModelId),
        availableModels: normalizedModelState.availableModels.filter(model => model.id === modelId) }),
      resolveModelUpdate: ({ modelId: next }) => {
        if (next !== modelId) throw new PluginError({ code: 'qwen_account_model_restart_required',
          message: 'Restart Qwen Code with the selected model to change models.', details: { status: 'requires_restart' } });
        return { modelId: nativeModelId };
      },
    };
    return { env, args: ['--auth-type', protocol, '--model', modelId], models, dispose: () => directory.cleanup() };
  } catch (error) { directory.cleanup(); throw error; }
}
