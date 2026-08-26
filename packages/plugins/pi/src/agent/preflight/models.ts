import type { AgentSessionModel } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { PI_LAUNCH_ENV_KEYS } from '../launchEnvironment.js';
import { createPiModelCatalogEntry } from '../models/catalog.js';

export type PiPreflightModel = AgentSessionModel;

const PI_CLI_MODELS_COMMAND_ARGS = ['--list-models'] as const;
function readThinkingSupport(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'yes') return true;
  if (normalized === 'no') return false;
  return null;
}

export function buildPiPreflightModelsFromListModelsOutput(outputRaw: string): readonly PiPreflightModel[] | null {
  const lines = outputRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const models: PiPreflightModel[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('provider') && lower.includes('model')) continue;

    const parts = line.split(/\s+/).filter(Boolean);
    const provider = parts[0]?.trim();
    const model = parts[1]?.trim();
    if (!provider || !model) continue;

    const supportsThinking = readThinkingSupport(parts[4]);
    const entry = createPiModelCatalogEntry({
      provider,
      modelId: model,
      name: model,
      supportsThinking: supportsThinking === true,
    });
    if (entry) models.push(entry);
  }

  return models.length > 0 ? models : null;
}

export const PI_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  models: Object.freeze({
    command: Object.freeze({
      toolId: 'pi-cli',
      args: PI_CLI_MODELS_COMMAND_ARGS,
      environmentKeys: PI_LAUNCH_ENV_KEYS,
    }),
    parseOutput: ({ stdout, stderr }) =>
      buildPiPreflightModelsFromListModelsOutput(stdout)
      ?? buildPiPreflightModelsFromListModelsOutput(stderr),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
