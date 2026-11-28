import type { AcpSessionModelAdapter, SessionConfigOption, SessionModelState } from '@/agent/acp/AcpBackend';
import type { AgentBackend, SessionId } from '@/agent/core';
import { logger } from '@/ui/logger';
import { resolveAcpModelConfigOption } from '@/agent/acp/configOptionChoiceNormalization';
import { applyObservedAcpModelOptions, isAcpModelScopedConfigOption } from '@/agent/acp/runtime/sessionModelsState';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';

/**
 * `agy acp` advertises model families in its standard `model` config option and the reasoning
 * effort in `thought_level`; its legacy `models` list repeats every family once per effort
 * (`gemini-4-neon-medium`). Happier shows the families with an effort control and maps saved
 * effort-suffixed ids onto family plus effort.
 */
const MODEL_CONFIG_ID = 'model';
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level';
/** The provider-neutral effort id execution-run and session defaults store. */
const REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';

type ConfigOptions = ReadonlyArray<SessionConfigOption> | null;

function findModelOption(configOptions: ConfigOptions): SessionConfigOption | null {
  return configOptions ? resolveAcpModelConfigOption(configOptions, MODEL_CONFIG_ID) : null;
}

function hasThoughtLevel(configOptions: ConfigOptions): boolean {
  return configOptions?.some((option) => option.id === THOUGHT_LEVEL_CONFIG_ID) === true;
}

function listFamilies(modelOption: SessionConfigOption | null): string[] {
  return (modelOption?.options ?? []).flatMap((option) => typeof option.value === 'string' && option.value ? [option.value] : []);
}

/** A family id, or the longest advertised family a legacy `<family>-<effort>` id extends. */
function resolveFamily(modelId: string, families: readonly string[]): Readonly<{ family: string; effort: string | null }> | null {
  if (families.includes(modelId)) return { family: modelId, effort: null };
  const family = families
    .filter((candidate) => modelId.startsWith(`${candidate}-`))
    .sort((left, right) => right.length - left.length)[0];
  return family ? { family, effort: modelId.slice(family.length + 1) } : null;
}

export function buildAgySessionModelsFromConfigOptions(configOptions: ReadonlyArray<SessionConfigOption>): SessionModelState | null {
  const modelOption = findModelOption(configOptions);
  if (!modelOption?.options || typeof modelOption.currentValue !== 'string' || !modelOption.currentValue) return null;
  const availableModels = modelOption.options.flatMap((option) => typeof option.value === 'string' && option.value && option.name
    ? [{ id: option.value, name: option.name, ...(option.description ? { description: option.description } : {}) }]
    : []);
  if (availableModels.length === 0) return null;
  // The advertised effort belongs to the current family; another family's effort is known once selected.
  const effortOptions = configOptions.filter((option) => option !== modelOption && isAcpModelScopedConfigOption(option));
  return {
    currentModelId: modelOption.currentValue,
    availableModels: applyObservedAcpModelOptions(availableModels, modelOption.currentValue, effortOptions),
  };
}

export function resolveAgySessionModelConfigUpdate(params: Readonly<{
  modelId: string;
  configOptions: ConfigOptions;
}>): Readonly<{ modelId: string; configUpdates?: ReadonlyArray<Readonly<{ configId: string; value: string }>> }> | null {
  const modelId = readNonBlankSessionControlIdentifier(params.modelId) ?? '';
  if (!modelId) return null;
  const resolved = resolveFamily(modelId, listFamilies(findModelOption(params.configOptions)));
  if (!resolved) return { modelId };
  // The family's own thought levels are known only after the switch; `withOfferedAgyThoughtLevels` checks them then.
  return resolved.effort
    ? { modelId: resolved.family, configUpdates: [{ configId: THOUGHT_LEVEL_CONFIG_ID, value: resolved.effort }] }
    : { modelId: resolved.family };
}

export function resolveAgySessionConfigOptionUpdate(params: Readonly<{
  configId: string;
  value: string | number | boolean | null;
  configOptions: ConfigOptions;
}>): Readonly<{ configId: string; value: string | number | boolean | null }> {
  return params.configId === REASONING_EFFORT_CONFIG_ID && hasThoughtLevel(params.configOptions)
    ? { configId: THOUGHT_LEVEL_CONFIG_ID, value: params.value }
    : { configId: params.configId, value: params.value };
}

type ThoughtLevelBackend = AgentBackend & Partial<{
  setSessionConfigOption: (sessionId: SessionId, configId: string, value: string | number | boolean | null) => Promise<void>;
  getSessionConfigOptionsState: () => ReadonlyArray<SessionConfigOption> | null;
}>;

/**
 * Each model advertises its own thought levels, so a saved effort (from a `<family>-<effort>` id)
 * is checked against the levels advertised after the family switch. A level the model does not
 * offer keeps its current effort instead of failing the session.
 */
export function withOfferedAgyThoughtLevels(backend: AgentBackend): AgentBackend {
  const target = backend as ThoughtLevelBackend;
  const setSessionConfigOption = target.setSessionConfigOption?.bind(backend);
  if (!setSessionConfigOption) return backend;
  target.setSessionConfigOption = async (sessionId, configId, value) => {
    const levels = target.getSessionConfigOptionsState?.()?.find((option) => option.id === THOUGHT_LEVEL_CONFIG_ID)?.options;
    if (configId === THOUGHT_LEVEL_CONFIG_ID && levels && !levels.some((level) => level.value === value)) {
      logger.infoFile(`[agy] Keeping the current thought level; the model does not offer ${String(value)}`);
      return;
    }
    await setSessionConfigOption(sessionId, configId, value);
  };
  return backend;
}

export const agySessionModelAdapter: AcpSessionModelAdapter = {
  projectModelId: ({ modelId, modelState }) => (
    resolveFamily(modelId, modelState?.availableModels.map((model) => model.id) ?? [])?.family ?? modelId
  ),
  deriveModelStateFromConfigOptions: ({ configOptions }) => buildAgySessionModelsFromConfigOptions(configOptions),
};

export const agyAcpRuntimeSessionModelAdapter = {
  deriveSessionModelsFromConfigOptions: buildAgySessionModelsFromConfigOptions,
  resolveSessionModelConfigUpdate: resolveAgySessionModelConfigUpdate,
  resolveSessionConfigOptionUpdate: resolveAgySessionConfigOptionUpdate,
};
