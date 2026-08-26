import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export type AuggiePreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

const AUGGIE_CLI_MODELS_COMMAND_ARGS = ['model', 'list', '--json'] as const;
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAuggieModel(value: unknown): AuggiePreflightModel | null {
  if (!isRecord(value)) return null;
  const id = readString(value.shortName) ?? readString(value.id);
  const name = readString(value.displayName) ?? id;
  if (!id || !name) return null;
  const description = readString(value.description);
  return {
    id,
    name,
    ...(description ? { description } : {}),
  };
}

export function buildAuggiePreflightModelsFromModelListJson(outputRaw: string): readonly AuggiePreflightModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputRaw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const models = parsed.models.flatMap((model): AuggiePreflightModel[] => {
    const parsedModel = parseAuggieModel(model);
    return parsedModel ? [parsedModel] : [];
  });
  return models.length > 0 ? models : null;
}

export const AUGGIE_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  models: Object.freeze({
    command: Object.freeze({ toolId: 'auggie-cli', args: AUGGIE_CLI_MODELS_COMMAND_ARGS }),
    parseOutput: ({ stdout, stderr }) =>
      buildAuggiePreflightModelsFromModelListJson(stdout)
      ?? buildAuggiePreflightModelsFromModelListJson(stderr),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
