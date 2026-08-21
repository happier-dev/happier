import type {
  AcpSessionModelAdapter,
  SessionConfigOption,
  SessionModel,
} from '@/agent/acp/AcpBackend';

const REASONING_EFFORT_OPTION_ID = 'reasoning_effort';

const FALLBACK_REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: 'xhigh', name: 'XHigh', description: 'Extended reasoning' },
  { value: 'high', name: 'High', description: 'Heavy reasoning' },
  { value: 'medium', name: 'Medium', description: 'Balanced reasoning' },
  { value: 'low', name: 'Low', description: 'Faster, lighter reasoning' },
]);

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

function normalizeEffortLabel(label: string, value: string): string {
  const withoutRedundantSuffix = label.replace(/\s+effort$/i, '').trim();
  return withoutRedundantSuffix || formatEffortLabel(value);
}

function projectGrokReasoningEffortOption(rawModel: Readonly<Record<string, unknown>>): SessionConfigOption | null {
  const meta = asRecord(
    Object.prototype.hasOwnProperty.call(rawModel, '_meta')
      ? rawModel._meta
      : rawModel.meta,
  );
  if (meta?.supportsReasoningEffort !== true) return null;

  const currentValue = readNonBlankString(meta.reasoningEffort);
  if (!currentValue) return null;

  const options: Array<{ value: string; name: string; description?: string }> = [];
  const seen = new Set<string>();
  const providerOptions = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
  let providerOptionsValid = providerOptions.length > 0;
  for (const rawOption of providerOptions) {
    const option = asRecord(rawOption);
    if (!option) {
      providerOptionsValid = false;
      break;
    }
    const value = readNonBlankString(option.value);
    if (!value || seen.has(value)) {
      providerOptionsValid = false;
      break;
    }
    const rawLabel = option.label;
    const providerLabel = rawLabel === undefined ? null : readNonBlankString(rawLabel);
    const label = rawLabel === undefined
      ? formatEffortLabel(value)
      : providerLabel
        ? normalizeEffortLabel(providerLabel, value)
        : null;
    if (!label) {
      providerOptionsValid = false;
      break;
    }
    const rawDescription = option.description;
    const description = rawDescription === undefined ? null : readNonBlankString(rawDescription);
    if (rawDescription !== undefined && !description) {
      providerOptionsValid = false;
      break;
    }
    seen.add(value);
    options.push({ value, name: label, ...(description ? { description } : {}) });
  }
  const resolvedOptions = providerOptionsValid ? options : FALLBACK_REASONING_EFFORT_OPTIONS;
  if (!resolvedOptions.some((option) => option.value === currentValue)) return null;

  return {
    id: REASONING_EFFORT_OPTION_ID,
    name: 'Reasoning effort',
    type: 'select',
    currentValue,
    options: [...resolvedOptions],
  };
}

function findCurrentModel(modelState: Parameters<NonNullable<AcpSessionModelAdapter['resolveConfigOptionModelUpdate']>>[0]['modelState']): SessionModel | null {
  if (!modelState) return null;
  return modelState.availableModels.find((model) => model.id === modelState.currentModelId) ?? null;
}

export const grokSessionModelAdapter: AcpSessionModelAdapter = {
  projectModel: ({ rawModel, normalizedModel }) => {
    const meta = asRecord(Object.prototype.hasOwnProperty.call(rawModel, '_meta') ? rawModel._meta : rawModel.meta);
    const contextWindowTokens = meta?.totalContextTokens;
    return typeof contextWindowTokens === 'number'
      && Number.isInteger(contextWindowTokens)
      && contextWindowTokens > 0
      ? { ...normalizedModel, contextWindowTokens }
      : normalizedModel;
  },
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
