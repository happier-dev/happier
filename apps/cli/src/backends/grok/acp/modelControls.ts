import type {
  AcpSessionModelAdapter,
  SessionConfigOption,
  SessionModel,
} from '@/agent/acp/AcpBackend';

const REASONING_EFFORT_OPTION_ID = 'reasoning_effort';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

function formatEffortLabel(value: string): string {
  if (value === 'xhigh') return 'XHigh';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function projectGrokReasoningEffortOption(rawModel: Readonly<Record<string, unknown>>): SessionConfigOption | null {
  const meta = asRecord(rawModel.meta);
  if (meta?.supportsReasoningEffort !== true) return null;

  const currentValue = readNonBlankString(meta.reasoningEffort);
  if (!currentValue || !Array.isArray(meta.reasoningEfforts) || meta.reasoningEfforts.length === 0) return null;

  const options: Array<{ value: string; name: string; description?: string }> = [];
  const seen = new Set<string>();
  for (const rawOption of meta.reasoningEfforts) {
    const option = asRecord(rawOption);
    if (!option) return null;
    const value = readNonBlankString(option.value);
    if (!value || seen.has(value)) return null;
    const rawLabel = option.label;
    const label = rawLabel === undefined ? formatEffortLabel(value) : readNonBlankString(rawLabel);
    if (!label) return null;
    const rawDescription = option.description;
    const description = rawDescription === undefined ? null : readNonBlankString(rawDescription);
    if (rawDescription !== undefined && !description) return null;
    seen.add(value);
    options.push({ value, name: label, ...(description ? { description } : {}) });
  }
  if (!seen.has(currentValue)) return null;

  return {
    id: REASONING_EFFORT_OPTION_ID,
    name: 'Reasoning effort',
    type: 'select',
    currentValue,
    options,
  };
}

function findCurrentModel(modelState: Parameters<NonNullable<AcpSessionModelAdapter['resolveConfigOptionModelUpdate']>>[0]['modelState']): SessionModel | null {
  if (!modelState) return null;
  return modelState.availableModels.find((model) => model.id === modelState.currentModelId) ?? null;
}

export const grokSessionModelAdapter: AcpSessionModelAdapter = {
  projectModelOptions: ({ rawModel, normalizedModelOptions }) => {
    const retainedOptions = normalizedModelOptions.filter((option) => option.id !== REASONING_EFFORT_OPTION_ID);
    const reasoningEffort = projectGrokReasoningEffortOption(rawModel);
    return reasoningEffort ? [...retainedOptions, reasoningEffort] : retainedOptions;
  },
  resolveConfigOptionModelUpdate: ({ configId, value, modelState }) => {
    if (configId !== REASONING_EFFORT_OPTION_ID) return undefined;
    if (typeof value !== 'string') {
      throw new Error('Grok reasoning effort must be a string');
    }

    const currentModel = findCurrentModel(modelState);
    const effortOption = currentModel?.modelOptions?.find((option) => option.id === REASONING_EFFORT_OPTION_ID);
    const advertisedValues = effortOption?.options?.map((option) => option.value) ?? [];
    if (!currentModel || !advertisedValues.includes(value)) {
      throw new Error('Grok reasoning effort is not advertised for the active model');
    }

    return {
      modelId: currentModel.id,
      requestMeta: { reasoningEffort: value },
    };
  },
};
