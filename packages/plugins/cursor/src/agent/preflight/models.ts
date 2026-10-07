import type { AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsCommandV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { parseCursorCliModelsOutput } from '../cli/models.js';
import { buildCursorAcpArgs, CURSOR_ACP_RUNTIME_DEFINITION } from '../acp/connection.js';
import { buildCursorEndpointArgs, resolveCursorRuntimeSettingsFromValues } from '../settings.js';

export type CursorPreflightModel = Readonly<{
  id: string;
  name: string;
}>;

const CURSOR_CLI_MODELS_COMMAND_ARGS = ['models'] as const;
export function buildCursorPreflightModelsFromModelsOutput(output: string): readonly CursorPreflightModel[] | null {
  const models = parseCursorCliModelsOutput(output).map((model) => ({
    id: model.id,
    name: model.name,
  }));
  return models.length > 0 ? models : null;
}

const selectedTools = Object.freeze({
  commandToolIds: Object.freeze(['cursor-agent', 'cursor-agent-no-fallback']),
  resolveCommandToolId: ({ pluginSettings }: Parameters<NonNullable<NonNullable<AgentPreflightSessionControlsContributionV1['models']>['resolveCommandToolId']>>[0]) =>
    resolveCursorRuntimeSettingsFromValues(pluginSettings?.daemon).agentFallbackEnabled ? 'cursor-agent' : 'cursor-agent-no-fallback',
});
const prepareModels: NonNullable<AgentPreflightSessionControlsCommandV1['prepareCommand']> = ({ pluginSettings }) => {
  const settings = resolveCursorRuntimeSettingsFromValues(pluginSettings?.daemon);
  return { args: [...buildCursorEndpointArgs(settings.apiEndpoint), ...CURSOR_CLI_MODELS_COMMAND_ARGS], ...(settings.binaryPath ? { preferredPath: settings.binaryPath } : {}) };
};
const prepareCatalogs: NonNullable<AgentPreflightSessionControlsCommandV1['prepareCommand']> = ({ pluginSettings }) => {
  const settings = resolveCursorRuntimeSettingsFromValues(pluginSettings?.daemon);
  return { args: buildCursorAcpArgs(null, settings.apiEndpoint), ...(settings.binaryPath ? { preferredPath: settings.binaryPath } : {}) };
};
export const CURSOR_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  catalogs: Object.freeze({
    kind: 'acp' as const,
    ...selectedTools,
    command: Object.freeze({ toolId: 'cursor-agent', args: Object.freeze(['acp']), prepareCommand: prepareCatalogs }),
    authenticationMethodId: CURSOR_ACP_RUNTIME_DEFINITION.auth.methodId,
  }),
  models: Object.freeze({
    ...selectedTools,
    command: Object.freeze({
      toolId: 'cursor-agent',
      args: CURSOR_CLI_MODELS_COMMAND_ARGS,
      ci: 'omit',
      prepareCommand: prepareModels,
    }),
    parseOutput: ({ stdout, stderr }) =>
      buildCursorPreflightModelsFromModelsOutput(stdout)
      ?? buildCursorPreflightModelsFromModelsOutput(stderr),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
