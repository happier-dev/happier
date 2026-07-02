type PiPreflightModelOption = Readonly<{
  id: string;
  name: string;
  type: 'select';
  currentValue: string;
  options: readonly Readonly<{ value: string; name: string }>[];
}>;

export type PiPreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  modelOptions?: readonly PiPreflightModelOption[];
}>;

const PI_THINKING_MODEL_OPTION: PiPreflightModelOption = Object.freeze({
  id: 'reasoning_effort',
  name: 'Thinking',
  type: 'select',
  currentValue: 'medium',
  options: Object.freeze([
    Object.freeze({ value: 'low', name: 'Low' }),
    Object.freeze({ value: 'medium', name: 'Medium' }),
    Object.freeze({ value: 'high', name: 'High' }),
    Object.freeze({ value: 'xhigh', name: 'Max' }),
  ]),
});

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
    models.push({
      id: `${provider}/${model}`,
      name: model,
      description: provider,
      ...(supportsThinking === true ? { modelOptions: [PI_THINKING_MODEL_OPTION] } : {}),
    });
  }

  return models.length > 0 ? models : null;
}

export const PI_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  failureCacheStrategy: 'cooldown',
  cliModelsCommandArgs: ['--list-models'],
  probeModelsCommandArgs: ['--list-models'],
  probeModelsFromCommandOutput: ({ output }: Readonly<{ output: string }>) =>
    buildPiPreflightModelsFromListModelsOutput(output),
} as const);
