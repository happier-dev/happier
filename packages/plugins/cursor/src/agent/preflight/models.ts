import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { parseCursorCliModelsOutput } from '../cli/models.js';

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

export const CURSOR_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  models: Object.freeze({
    command: Object.freeze({
      toolId: 'cursor-agent',
      args: CURSOR_CLI_MODELS_COMMAND_ARGS,
      ci: 'omit',
    }),
    parseOutput: ({ stdout, stderr }) =>
      buildCursorPreflightModelsFromModelsOutput(stdout)
      ?? buildCursorPreflightModelsFromModelsOutput(stderr),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
