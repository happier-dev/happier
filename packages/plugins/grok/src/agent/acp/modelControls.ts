import type { AgentAcpModel, AgentAcpModelOption } from '@happier-dev/plugin-sdk/agents/runtime';

type JsonObject = Readonly<Record<string, unknown>>;

export type GrokModelOption = AgentAcpModelOption;

const FALLBACK_REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: 'xhigh', name: 'XHigh', description: 'Extended reasoning' },
  { value: 'high', name: 'High', description: 'Heavy reasoning' },
  { value: 'medium', name: 'Medium', description: 'Balanced reasoning' },
  { value: 'low', name: 'Low', description: 'Faster, lighter reasoning' },
]);

function asRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readExactNonblankString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

function defaultEffortLabel(value: string): string {
  if (value === 'xhigh') return 'XHigh';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeEffortLabel(label: string, value: string): string {
  return label.replace(/\s+effort$/iu, '').trim() || defaultEffortLabel(value);
}

function projectReasoningEffort(rawModel: JsonObject): GrokModelOption | null {
  const metadata = asRecord(Object.hasOwn(rawModel, '_meta') ? rawModel._meta : rawModel.meta);
  if (metadata?.supportsReasoningEffort !== true) return null;
  const currentValue = readExactNonblankString(metadata.reasoningEffort);
  if (!currentValue) return null;

  const seen = new Set<string>();
  const options: Array<{ value: string; name: string; description?: string }> = [];
  const providerOptions = Array.isArray(metadata.reasoningEfforts) ? metadata.reasoningEfforts : [];
  let providerOptionsValid = providerOptions.length > 0;
  for (const rawOption of providerOptions) {
    const option = asRecord(rawOption);
    const value = readExactNonblankString(option?.value);
    if (!option || !value || seen.has(value)) {
      providerOptionsValid = false;
      break;
    }
    const providerLabel = option.label === undefined ? defaultEffortLabel(value) : readExactNonblankString(option.label);
    if (!providerLabel) {
      providerOptionsValid = false;
      break;
    }
    const description = option.description === undefined ? null : readExactNonblankString(option.description);
    if (option.description !== undefined && !description) {
      providerOptionsValid = false;
      break;
    }
    seen.add(value);
    options.push({
      value,
      name: normalizeEffortLabel(providerLabel, value),
      ...(description ? { description } : {}),
    });
  }
  const resolvedOptions = providerOptionsValid ? options : FALLBACK_REASONING_EFFORT_OPTIONS;
  if (!resolvedOptions.some((option) => option.value === currentValue)) return null;
  return {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    type: 'select',
    currentValue,
    options: Object.freeze([...resolvedOptions]),
  };
}

export function projectGrokModelOptions(
  rawModel: JsonObject,
  normalizedModelOptions: readonly GrokModelOption[],
): readonly GrokModelOption[] {
  const retained = normalizedModelOptions.filter((option) => option.id !== 'reasoning_effort');
  const effort = projectReasoningEffort(rawModel);
  return effort ? Object.freeze([...retained, effort]) : Object.freeze(retained);
}

export function projectGrokModel(rawModel: JsonObject, normalizedModel: AgentAcpModel): AgentAcpModel {
  const metadata = asRecord(Object.hasOwn(rawModel, '_meta') ? rawModel._meta : rawModel.meta);
  const totalContextTokens = metadata?.totalContextTokens;
  const modelOptions = projectGrokModelOptions(rawModel, normalizedModel.modelOptions ?? []);
  return {
    ...normalizedModel,
    ...(typeof totalContextTokens === 'number'
      && Number.isInteger(totalContextTokens)
      && totalContextTokens > 0
      ? { contextWindowTokens: totalContextTokens }
      : {}),
    ...(modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

export function resolveGrokReasoningEffortUpdate(params: Readonly<{
  configId: string;
  value: unknown;
  currentModel: Readonly<{ id: string; modelOptions?: readonly GrokModelOption[] }> | null;
}>): Readonly<{ modelId: string; requestMeta: Readonly<{ reasoningEffort: string }> }> | undefined {
  if (params.configId !== 'reasoning_effort') return undefined;
  if (typeof params.value !== 'string') throw new Error('Grok reasoning effort must be a string');
  const effort = params.currentModel?.modelOptions?.find((option) => option.id === 'reasoning_effort');
  if (!params.currentModel || !effort?.options?.some((option) => option.value === params.value)) {
    throw new Error('Grok reasoning effort is not advertised for the active model');
  }
  return { modelId: params.currentModel.id, requestMeta: { reasoningEffort: params.value } };
}

export function projectGrokSetModelResponse(params: Readonly<{
  response: unknown;
  requestedModelId: string;
  requestMeta: Readonly<Record<string, unknown>> | null;
  targetModel: AgentAcpModel;
}>): AgentAcpModel | null {
  const response = asRecord(params.response);
  const meta = asRecord(response?._meta);
  const model = asRecord(meta?.model);
  if (model?.Ok !== params.requestedModelId || params.targetModel.id !== params.requestedModelId) {
    return null;
  }

  const requestedEffort = params.requestMeta?.reasoningEffort;
  if (requestedEffort === undefined) return params.targetModel;
  if (typeof requestedEffort !== 'string') return null;
  const effort = params.targetModel.modelOptions?.find((option) => option.id === 'reasoning_effort');
  if (!effort?.options?.some((option) => option.value === requestedEffort)) return null;
  return {
    ...params.targetModel,
    modelOptions: params.targetModel.modelOptions?.map((option) => option.id === 'reasoning_effort'
      ? { ...option, currentValue: requestedEffort }
      : option),
  };
}
