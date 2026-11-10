import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { prepareOhMyPiQualifiedAccounts } from '../auth/services/preparation.js';
import { OH_MY_PI_SYSTEM_TOOL_ID } from '../systemTool.js';

type OhMyPiPreflightModelOption = Readonly<{
  id: string;
  name: string;
  type: 'select';
  currentValue: string;
  options: readonly Readonly<{ value: string; name: string }>[];
}>;

export type OhMyPiPreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  modelOptions?: readonly OhMyPiPreflightModelOption[];
}>;

export const OH_MY_PI_ACP_COMMAND = Object.freeze({ toolId: OH_MY_PI_SYSTEM_TOOL_ID, args: Object.freeze(['acp']) });

export const OH_MY_PI_CLI_MODELS_COMMAND_ARGS = Object.freeze(['models', '--json']);

export function buildOhMyPiPreflightModelsFromListModelsOutput(
  outputRaw: string,
): readonly OhMyPiPreflightModel[] | null {
  let output: unknown;
  try { output = JSON.parse(outputRaw); } catch { return null; }
  if (!output || typeof output !== 'object' || !('models' in output) || !Array.isArray(output.models)) return null;
  const models: OhMyPiPreflightModel[] = [];
  // Native AuthStorage filters configured candidates, not account entitlement.
  const entries: readonly unknown[] = output.models;
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Readonly<Record<string, unknown>>;
    if (entry.kind !== 'chat') continue;
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
    const model = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!provider || !model) continue;
    const thinkingValues: readonly unknown[] = Array.isArray(entry.thinking) ? entry.thinking : [];
    const thinking = thinkingValues.filter((value): value is string => typeof value === 'string' && value.length > 0);
    models.push({
      id: `${provider}/${model}`,
      name: model,
      description: provider,
      ...(thinking.length > 0 ? { modelOptions: [{
        id: 'reasoning_effort', name: 'Thinking', type: 'select',
        currentValue: thinking.includes('medium') ? 'medium' : thinking[0]!,
        options: thinking.map((value) => ({ value, name: value })),
      } satisfies OhMyPiPreflightModelOption] } : {}),
    });
  }

  return models.length > 0 ? models : null;
}

export const OH_MY_PI_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  prepareLaunchEnvironment: async ({ environment, connectedAccounts, signal }) => {
    const prepared = await prepareOhMyPiQualifiedAccounts({
      launchEnvironment: { values: environment, unset: [] },
    }, { signal, services: { connectedAccounts } });
    return { catalogConfidence: 'account_unverified' as const, environment: prepared.request.launchEnvironment.values,
      unset: prepared.request.launchEnvironment.unset, dispose: prepared.cleanup };
  },
  catalogs: Object.freeze({ kind: 'acp' as const, command: OH_MY_PI_ACP_COMMAND }),
  models: Object.freeze({
    command: Object.freeze({ toolId: OH_MY_PI_SYSTEM_TOOL_ID, args: OH_MY_PI_CLI_MODELS_COMMAND_ARGS }),
    parseOutput: ({ stdout, stderr }) => {
      const availableModels = buildOhMyPiPreflightModelsFromListModelsOutput(stdout)
        ?? buildOhMyPiPreflightModelsFromListModelsOutput(stderr);
      return availableModels ? { availableModels, source: 'static' as const } : null;
    },
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
