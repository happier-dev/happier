import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentRuntimeContext, AgentRuntimeFactory, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

import { DROID_ACP_COMMAND } from '../preflight.js';
import { DROID_PROVIDER_SETTINGS_PATH, droidProviderModelDisplayName } from '../providerBinding/adapter.js';
import { DROID_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';
import { prepareDroidConnectedAccount, type DroidConnectedAccountLaunch } from './connectedAccount.js';
export { droidExternalSessionsContribution } from '../externalSessions/contribution.js';

function launch<TRequest extends AgentSessionOpenRequest | AgentExecutionRunOpenRequest>(request: TRequest, customModel?: DroidConnectedAccountLaunch<TRequest>['customModel']) {
  const binding = request.providerBinding;
  const args: string[] = [...DROID_ACP_COMMAND.args];
  const definition: NonNullable<AgentAcpRuntimeOptions['definition']> = { modelConfigOptionId: 'model', mcp: { policy: 'pass_through' } };
  if (!binding && !customModel) return { request, options: { transport: { kind: 'stdio' as const, executable: { kind: 'systemTool' as const, id: DROID_ACP_COMMAND.toolId }, args }, definition } };
  let settingsPath = customModel?.settingsPath;
  if (binding) {
    const materialization = binding.materialization;
    if (materialization.kind !== 'configFile' || materialization.relativePaths.length !== 1
      || materialization.relativePaths[0] !== DROID_PROVIDER_SETTINGS_PATH) throw new Error('Droid requires its canonical Provider settings file');
    settingsPath = join(materialization.rootPath, DROID_PROVIDER_SETTINGS_PATH);
  }
  const model = customModel?.model ?? binding!.model;
  if (!request.configuration) throw new Error('Droid requires the host-projected Agent session configuration');
  // --settings merges this file for this process without writing user settings.
  // https://docs.factory.com/droid-cli/cli-reference
  args.push('--settings', settingsPath!);
  let advertisedNativeModelId: string | null = null;
  const unavailable = () => new PluginError({ code: 'droid_provider_model_unavailable', message: 'Droid did not advertise the selected Provider model unambiguously.' });
  return {
    request: { ...request, configuration: { ...request.configuration, model: { ...request.configuration.model, value: model.id } } },
    options: { transport: { kind: 'stdio' as const, executable: { kind: 'systemTool' as const, id: DROID_ACP_COMMAND.toolId }, args },
      definition: { ...definition, models: {
        projectModel: (_raw, normalized) => normalized,
        projectModelState({ normalizedModelState }) {
          const matches = normalizedModelState.availableModels.filter(option => option.id.startsWith('custom:') && option.name === droidProviderModelDisplayName(model.id));
          if (matches.length !== 1) throw unavailable();
          advertisedNativeModelId = matches[0]!.id;
          return { ...normalizedModelState,
            currentModelId: normalizedModelState.currentModelId === advertisedNativeModelId ? model.id : normalizedModelState.currentModelId,
            availableModels: normalizedModelState.availableModels
              .filter(option => option.id === advertisedNativeModelId)
              .map(option => option.id === advertisedNativeModelId ? { ...option, id: model.id, name: model.name } : option),
          };
        },
        projectModelId: ({ modelId }) => modelId === advertisedNativeModelId ? model.id : modelId,
        resolveModelUpdate({ modelId, modelState }) {
          if (advertisedNativeModelId === null || !modelState?.availableModels.some(option => option.id === model.id && option.name === model.name)
            || (modelId !== model.id && modelId !== advertisedNativeModelId)) throw unavailable();
          return { modelId: advertisedNativeModelId };
        },
      } },
    } satisfies AgentAcpRuntimeOptions,
  };
}

type DisposeReason = Parameters<AgentSessionRuntime['dispose']>[0];

async function openDroid<Request extends AgentSessionOpenRequest | AgentExecutionRunOpenRequest, Runtime extends { dispose(reason?: DisposeReason): void | Promise<void> }>(
  request: Request,
  context: Pick<AgentRuntimeContext, 'services' | 'signal'>,
  open: (prepared: ReturnType<typeof launch<Request>>) => Promise<Runtime> | Runtime,
): Promise<Runtime> {
  const account = await prepareDroidConnectedAccount(request, context);
  try {
    const runtime = await open(launch(account.request, account.customModel));
    if (!account.customModel) return runtime;
    // Canonical ACP handles use closure methods and live getters on frozen
    // objects. Preserve descriptors without snapshotting negotiated capabilities.
    return Object.create(Object.getPrototypeOf(runtime), {
      ...Object.getOwnPropertyDescriptors(runtime),
      dispose: { enumerable: true, async value(reason?: DisposeReason) {
        try { await runtime.dispose(reason); } finally { account.dispose(); }
      } },
    });
  } catch (error) {
    account.dispose();
    throw error;
  }
}

export const createDroidAgentRuntime: AgentRuntimeFactory = () => ({ surfaces: { terminal: DROID_TERMINAL_CONTRIBUTION }, sessions: {
  open(request, context) {
    return openDroid(request, context, prepared => context.protocols.acp.open(prepared.request, prepared.options));
  },
  executionRunContextV1: {
    open(request, context) {
      return openDroid(request, context, prepared => context.protocols.acp.openExecutionRunV1(prepared.request, prepared.options));
    },
    openConversation(request, context) {
      if (!context.protocols.acp.openExecutionRunConversationV1) throw new PluginError({ code: 'execution_run_protocol_unsupported', message: 'This host does not support retained detached ACP conversations.' });
      return openDroid(request, context, prepared => context.protocols.acp.openExecutionRunConversationV1!(prepared.request, prepared.options));
    },
  },
} });
