import { join } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type {
  AgentAcpModelControls,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { COPILOT_ACP_MODEL_CONTROLS } from '../acp/modelControls.js';
import { COPILOT_CONNECTED_ACCOUNT_PURPOSES, COPILOT_GITHUB_PURPOSE_ID, COPILOT_NATIVE_KEY_PURPOSES } from '../auth/services/accountPurposes.js';
import { COPILOT_AUTH_ENV_VARS, COPILOT_GITHUB_TOKEN_ENV_VAR } from '../auth/services/copilotAuth.js';
import { COPILOT_PROVIDER_OWNED_ENV_KEYS, buildCopilotProviderEnvironment } from '../providerBinding.js';

const PROVIDER_NAME = 'happier-chatgpt';
type CopilotAccountRequest = Pick<AgentSessionOpenRequest, 'providerBinding' | 'connectedAccounts' | 'launchEnvironment'>;

function withAccountEnvironment<T extends CopilotAccountRequest>(
  request: T, environment: Readonly<Record<string, string>>,
): T {
  const removed = new Set<string>([...COPILOT_AUTH_ENV_VARS, ...COPILOT_PROVIDER_OWNED_ENV_KEYS]);
  const values = {
    ...Object.fromEntries(Object.entries(request.launchEnvironment?.values ?? {}).filter(([key]) => !removed.has(key))),
    ...environment,
  };
  return { ...request, launchEnvironment: { values,
    unset: [...new Set([...(request.launchEnvironment?.unset ?? []), ...removed])]
      .filter(key => !Object.hasOwn(values, key)),
  } };
}

/** One static access-token snapshot per native process; the host owns renewal. */
export async function prepareCopilotConnectedAccount<T extends CopilotAccountRequest>(
  request: T,
  context: Pick<AgentRuntimeContext, 'services' | 'signal'>,
  modelId?: string | null,
): Promise<Readonly<{ request: T; models?: AgentAcpModelControls; dispose(): void }>> {
  const accounts = context.services.connectedAccounts;
  const selections = await Promise.all(COPILOT_CONNECTED_ACCOUNT_PURPOSES.map(async declaration => {
    // The host records this selection only after successful launch materialization.
    const admitted = request.connectedAccounts?.find(selection => selection.purpose === declaration.purpose);
    const binding = admitted ?? await accounts.getBinding(declaration.purpose, { signal: context.signal });
    return binding ? { declaration, account: binding.account, admitted: admitted !== undefined } : null;
  }));
  const selected = selections.filter(selection => selection !== null);
  if (selected.length === 0) return { request,
    // Native BYOK choices also lack an exact-account catalog observation.
    ...(request.providerBinding ? { models: { ...COPILOT_ACP_MODEL_CONTROLS, catalogConfidence: 'account_unverified' as const } } : {}),
    dispose() {} };
  if (selected.length > 1 || request.providerBinding) throw new PluginError({
    code: 'copilot_account_provider_conflict',
    message: 'Choose one Connected Account or Provider connection for Copilot.',
  });
  const { declaration, account, admitted } = selected[0]!;
  if (declaration.purpose === COPILOT_GITHUB_PURPOSE_ID) {
    const materialized = admitted
      ? { kind: 'environment' as const, env: request.launchEnvironment?.values ?? {} }
      : await accounts.materialize(declaration.purpose, {
        kind: 'environment', keys: [COPILOT_GITHUB_TOKEN_ENV_VAR],
      }, { signal: context.signal, expectedAccount: account });
    const token = materialized.kind === 'environment' ? materialized.env[COPILOT_GITHUB_TOKEN_ENV_VAR] : undefined;
    if (typeof token !== 'string' || !token.trim()) throw new PluginError({
      code: 'copilot_account_materialization_unavailable',
      message: 'The Copilot GitHub account did not provide a native access token.',
    });
    return { request: withAccountEnvironment(request, { [COPILOT_GITHUB_TOKEN_ENV_VAR]: token }), dispose() {} };
  }
  if (!modelId?.trim() || modelId.trim() === 'default') throw new PluginError({
    code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Choose a model for the Copilot Connected Account.',
    details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
      phase: 'client_start', failureReason: 'model_selection_required', retryable: false } },
  });
  const nativeKey = COPILOT_NATIVE_KEY_PURPOSES.find(row => row.purpose === declaration.purpose);
  if (nativeKey) {
    const baseKey = 'baseUrlEnvironmentKey' in nativeKey ? nativeKey.baseUrlEnvironmentKey : undefined;
    const material = await accounts.materialize(declaration.purpose, { kind: 'environment',
      keys: [nativeKey.environmentKey, ...(baseKey ? [baseKey] : [])],
    }, { signal: context.signal, expectedAccount: account });
    const secret = material.kind === 'environment' ? material.env[nativeKey.environmentKey] : undefined;
    const baseUrl = baseKey && material.kind === 'environment' ? material.env[baseKey] : 'baseUrl' in nativeKey ? nativeKey.baseUrl : undefined;
    if (!secret?.trim() || !baseUrl) throw new PluginError({ code: 'copilot_account_materialization_unavailable', message: 'The selected Copilot account did not provide its native key and endpoint.' });
    return { request: withAccountEnvironment(request, buildCopilotProviderEnvironment({ protocol: nativeKey.protocol,
      baseUrl, modelId, credential: { kind: nativeKey.protocol === 'anthropic' ? 'api-key' : 'bearer', value: secret } })),
      models: { ...COPILOT_ACP_MODEL_CONTROLS, catalogConfidence: 'account_unverified' }, dispose() {} };
  }
  const materialized = await accounts.materialize(declaration.purpose, {
    kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['Authorization', 'ChatGPT-Account-Id'],
  }, { signal: context.signal, expectedAccount: account });
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
  const unavailable = () => new PluginError({
    code: 'copilot_account_model_unavailable', message: 'Copilot did not advertise the selected ChatGPT model.',
  });
  return {
    request: withAccountEnvironment(request, { COPILOT_PROVIDERS_CONFIG: configPath, COPILOT_MODEL: nativeModelId }),
    models: {
      ...COPILOT_ACP_MODEL_CONTROLS,
      // The generated model row is configuration, not an account catalog observation.
      catalogConfidence: 'account_unverified',
      projectModelState({ normalizedModelState }) {
        const model = normalizedModelState.availableModels.find(entry => entry.id === nativeModelId);
        if (!model) throw unavailable();
        return { currentModelId: normalizedModelState.currentModelId === nativeModelId ? modelId : normalizedModelState.currentModelId,
          availableModels: [{ ...model, id: modelId }] };
      },
      projectModelId: ({ modelId: selected }) => selected === nativeModelId ? modelId : selected,
      resolveModelUpdate({ modelId: selected }) {
        if (selected !== modelId && selected !== nativeModelId) throw new PluginError({
          code: 'copilot_account_model_unavailable', message: 'Restart Copilot to apply a different ChatGPT model.',
          details: { status: 'requires_restart' } });
        return { modelId: nativeModelId };
      },
    },
    dispose: directory.cleanup,
  };
}
