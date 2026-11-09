import { join } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type {
  AgentAcpModelControls,
  AgentExecutionRunOpenRequest,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { COPILOT_ACP_MODEL_CONTROLS } from '../acp/modelControls.js';
import { COPILOT_OPENAI_CODEX_PURPOSE_ID } from '../auth/services/accountPurposes.js';
import { COPILOT_PROVIDER_OWNED_ENV_KEYS } from '../providerBinding.js';

const PROVIDER_NAME = 'happier-chatgpt';

/** One static access-token snapshot per native process; the host owns renewal. */
export async function prepareCopilotConnectedAccount<T extends AgentSessionOpenRequest | AgentExecutionRunOpenRequest>(
  request: T,
  context: Pick<AgentRuntimeContext, 'services' | 'signal'>,
): Promise<Readonly<{ request: T; models?: AgentAcpModelControls; dispose(): void }>> {
  const accounts = context.services.connectedAccounts;
  const binding = await accounts.getBinding(COPILOT_OPENAI_CODEX_PURPOSE_ID, { signal: context.signal });
  if (!binding) return { request, dispose() {} };
  if (request.providerBinding) throw new PluginError({
    code: 'copilot_account_provider_conflict',
    message: 'Choose either a Connected Account or a Provider connection for Copilot.',
  });
  const selection = request.configuration?.model;
  const modelId = selection?.value;
  if (!modelId?.trim() || selection?.selectionSource !== 'explicit') throw new PluginError({
    code: 'copilot_account_model_required',
    message: 'Choose an explicit model for the Copilot ChatGPT account.',
  });
  const materialized = await accounts.materialize(COPILOT_OPENAI_CODEX_PURPOSE_ID, {
    kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['Authorization', 'ChatGPT-Account-Id'],
  }, { signal: context.signal, expectedAccount: binding.account });
  if (materialized.kind !== 'httpHeaders') throw new PluginError({
    code: 'copilot_account_materialization_unavailable',
    message: 'The Copilot ChatGPT account did not provide request headers.',
  });
  const headers = new Headers(materialized.headers);
  const authorization = headers.get('authorization');
  const accountId = headers.get('chatgpt-account-id');
  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim() || !accountId?.trim()) throw new PluginError({
    code: 'copilot_account_materialization_unavailable',
    message: 'The Copilot ChatGPT account did not provide bearer access and account identity headers.',
  });
  const nativeModelId = `${PROVIDER_NAME}/${modelId}`;
  const directory = createSecureTempDirectorySync({ prefix: 'copilot-chatgpt' });
  const configPath = join(directory.path, 'providers.json');
  try {
    await writeAtomicTextFile({ path: configPath, mode: 0o600, contents: JSON.stringify({
      providers: [{ name: PROVIDER_NAME, type: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex',
        bearerToken: authorization.slice(7), wireApi: 'responses',
        headers: { 'chatgpt-account-id': accountId, 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' } }],
      // Copilot 1.0.107 documents nonnegative counts. Zero omits the Responses
      // max_output_tokens field, which the subscription endpoint rejects.
      // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
      models: [{ id: modelId, provider: PROVIDER_NAME, maxOutputTokens: 0 }],
    }) });
  } catch (error) { directory.cleanup(); throw error; }
  const removed = new Set<string>(COPILOT_PROVIDER_OWNED_ENV_KEYS);
  const values = {
    ...Object.fromEntries(Object.entries(request.launchEnvironment?.values ?? {}).filter(([key]) => !removed.has(key))),
    COPILOT_PROVIDERS_CONFIG: configPath,
    COPILOT_MODEL: nativeModelId,
  };
  const materializedKeys = new Set(Object.keys(values));
  const unavailable = () => new PluginError({
    code: 'copilot_account_model_unavailable', message: 'Copilot did not advertise the selected ChatGPT model.',
  });
  return {
    request: { ...request, launchEnvironment: { values,
      unset: [...new Set([...(request.launchEnvironment?.unset ?? []), ...COPILOT_PROVIDER_OWNED_ENV_KEYS])]
        .filter(key => !materializedKeys.has(key)),
    } },
    models: {
      ...COPILOT_ACP_MODEL_CONTROLS,
      projectModelState({ normalizedModelState }) {
        const model = normalizedModelState.availableModels.find(entry => entry.id === nativeModelId);
        if (!model) throw unavailable();
        return { currentModelId: normalizedModelState.currentModelId === nativeModelId ? modelId : normalizedModelState.currentModelId,
          availableModels: [{ ...model, id: modelId }] };
      },
      projectModelId: ({ modelId: selected }) => selected === nativeModelId ? modelId : selected,
      resolveModelUpdate({ modelId: selected }) {
        if (selected !== modelId && selected !== nativeModelId) throw unavailable();
        return { modelId: nativeModelId };
      },
    },
    dispose: directory.cleanup,
  };
}
