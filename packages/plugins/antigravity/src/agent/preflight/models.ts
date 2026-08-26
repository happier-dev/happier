import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { ANTIGRAVITY_SDK_ONLY_ENV_KEYS } from '../lifecycle/runtimeEnv.js';
import { ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS } from '../cliPrint/modelsProbePolicy.js';

export type AntigravityPreflightModel = Readonly<{
  id: string;
  name: string;
}>;

function normalizeModelLine(line: string): string | null {
  const normalized = line
    .trim()
    .replace(/^[-*]\s+/u, '')
    .replace(/\s+/gu, ' ');
  if (!normalized) return null;
  if (/^(available models:?|models:?|no models available|none)$/iu.test(normalized)) return null;
  if (/^(error|warning|usage):/iu.test(normalized)) return null;
  return /[a-z0-9]/iu.test(normalized) ? normalized : null;
}

export function buildAntigravityPreflightModelsFromModelsOutput(
  outputRaw: string,
): readonly AntigravityPreflightModel[] | null {
  const seen = new Set<string>();
  const models: AntigravityPreflightModel[] = [];
  for (const line of outputRaw.split('\n')) {
    const label = normalizeModelLine(line);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    models.push({ id: label, name: label });
  }
  return models.length > 0 ? models : null;
}

export const ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  models: Object.freeze({
    command: Object.freeze({
      toolId: 'antigravity-cli',
      args: ANTIGRAVITY_CLI_MODELS_COMMAND_ARGS,
      environmentExcludeKeys: ANTIGRAVITY_SDK_ONLY_ENV_KEYS,
    }),
    parseOutput: ({ stdout, stderr }) =>
      buildAntigravityPreflightModelsFromModelsOutput(stdout)
      ?? buildAntigravityPreflightModelsFromModelsOutput(stderr),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
