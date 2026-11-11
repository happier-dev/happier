import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

export type SessionConfigOptionValueId = string;

export type SessionConfigOptionChoice = Readonly<{
  value: SessionConfigOptionValueId;
  name: string;
  description?: string;
}>;

export type SessionConfigOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: SessionConfigOptionValueId;
  options?: ReadonlyArray<SessionConfigOptionChoice>;
  groups?: ReadonlyArray<Readonly<{ id: string; name: string; options: ReadonlyArray<SessionConfigOptionChoice> }>>;
}>;

export type SessionMode = {
  id: string;
  name: string;
  description?: string;
};

export type SessionModeState = {
  currentModeId: string;
  availableModes: SessionMode[];
};

export type SessionModel = {
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  modelOptions?: SessionConfigOption[];
};

export type SessionModelState = {
  currentModelId: string;
  availableModels: SessionModel[];
};

/** Returns the positive ACP authority for config-option ids, when a catalog was observed. */
export function resolveAdvertisedSessionConfigOptionIds(
  configOptions: ReadonlyArray<SessionConfigOption> | null,
  modelState: SessionModelState | null,
): ReadonlySet<string> | null {
  if (configOptions === null && modelState === null) return null;
  return new Set([
    ...(configOptions ?? []).map(option => option.id),
    ...(modelState?.availableModels
      .find(model => model.id === modelState.currentModelId)?.modelOptions ?? [])
      .map(option => option.id),
  ]);
}

export type SessionModelProjector = (
  rawModel: Readonly<Record<string, unknown>>,
  normalizedModel: SessionModel,
) => SessionModel;
export type AwaitableSessionModelProjector = (
  rawModel: Readonly<Record<string, unknown>>,
  normalizedModel: SessionModel,
) => SessionModel | Promise<SessionModel>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

export function normalizeSessionConfigOptionValue(value: unknown): SessionConfigOptionValueId | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function normalizeConfigOptionChoices(raw: ReadonlyArray<unknown>): SessionConfigOptionChoice[] {
  return raw.flatMap((rawChoice): SessionConfigOptionChoice[] => {
    const choice = asRecord(rawChoice);
    if (!choice) return [];
    if (Array.isArray(choice.options)) return normalizeConfigOptionChoices(choice.options);
    const value = normalizeSessionConfigOptionValue(choice.value);
    const name = readNonBlankOpaqueIdentifier(choice.name);
    if (value === null || !name) return [];
    const description = getString(choice, 'description');
    return [{ value, name, ...(description !== null ? { description } : {}) }];
  });
}

export function normalizeSessionConfigOptions(raw: ReadonlyArray<unknown>, disableModeControls = false): SessionConfigOption[] {
  const out: SessionConfigOption[] = [];

  for (const entryRaw of raw) {
    const entry = asRecord(entryRaw);
    if (!entry) continue;

    const id = readNonBlankOpaqueIdentifier(entry.id);
    const name = readNonBlankOpaqueIdentifier(entry.name);
    const type = readNonBlankOpaqueIdentifier(entry.type);
    if (!id || !name || !type) continue;
    if (disableModeControls && [id, name, getString(entry, 'category')]
      .some(value => value?.trim().toLowerCase() === 'mode')) continue;

    const currentValue = normalizeSessionConfigOptionValue(entry.currentValue);
    if (currentValue === null) continue;

    const description = getString(entry, 'description');
    const category = getString(entry, 'category');
    const optionsCandidate = entry.options;
    const groupsRaw = Array.isArray(entry.groups) ? entry.groups : null;
    const optionsRaw = Array.isArray(optionsCandidate) ? optionsCandidate : groupsRaw;

    let options: SessionConfigOption['options'] | undefined = undefined;
    if (optionsRaw) {
      const normalized = normalizeConfigOptionChoices(optionsRaw);
      if (normalized.length > 0 || optionsRaw.length === 0) options = normalized;
    }
    const groups = (groupsRaw ?? optionsRaw ?? []).flatMap((rawGroup) => {
      const group = asRecord(rawGroup);
      if (!group || !Array.isArray(group.options)) return [];
      const groupId = readNonBlankOpaqueIdentifier(getString(group, 'group') ?? getString(group, 'id'));
      const name = readNonBlankOpaqueIdentifier(getString(group, 'name') ?? groupId);
      if (!groupId || !name) return [];
      return [{ id: groupId, name, options: normalizeConfigOptionChoices(group.options) }];
    });

    out.push({
      id,
      name,
      type,
      currentValue,
      ...(description !== null ? { description } : {}),
      ...(category !== null ? { category } : {}),
      ...(options ? { options } : {}),
      ...(groups.length > 0 ? { groups } : {}),
    });
  }

  return out;
}

export function readSessionModeStateFromSessionResponse(sessionResponse: unknown): SessionModeState | null {
  const response = asRecord(sessionResponse);
  if (!response) return null;
  const modesRaw = asRecord(response.modes);
  if (!modesRaw) return null;

  const currentModeId = getString(modesRaw, 'currentModeId');
  const availableModesRaw = Array.isArray(modesRaw.availableModes) ? modesRaw.availableModes : null;
  if (!currentModeId || !availableModesRaw) return null;

  const availableModes: SessionMode[] = availableModesRaw
    .map((mode) => asRecord(mode))
    .filter((mode): mode is Record<string, unknown> => Boolean(mode))
    .map((mode) => {
      const id = getString(mode, 'id');
      const name = getString(mode, 'name');
      if (!id || !name) return null;
      const description = getString(mode, 'description');
      return { id, name, ...(description !== null ? { description } : {}) };
    })
    .filter((mode): mode is SessionMode => Boolean(mode));

  if (availableModes.length === 0) return null;

  return { currentModeId, availableModes };
}

function normalizeSessionModel(model: Record<string, unknown>): SessionModel | null {
  const id = getString(model, 'id') ?? getString(model, 'modelId');
  const name = getString(model, 'name');
  if (!id || !name) return null;
  const description = getString(model, 'description');
  const contextWindowTokens = typeof model.contextWindowTokens === 'number'
    && Number.isInteger(model.contextWindowTokens)
    && model.contextWindowTokens > 0
    ? model.contextWindowTokens
    : null;
  const modelOptionsCandidate = model.modelOptions ?? model.model_options;
  const modelOptionsRaw: unknown[] | null = Array.isArray(modelOptionsCandidate) ? modelOptionsCandidate : null;
  const modelOptions = modelOptionsRaw ? normalizeSessionConfigOptions(modelOptionsRaw) : null;
  return {
    id,
    name,
    ...(description !== null ? { description } : {}),
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(modelOptions && modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

function readSessionModelResponse(sessionResponse: unknown) {
  const response = asRecord(sessionResponse);
  if (!response) return null;
  const modelsRaw = asRecord(response.models);
  if (!modelsRaw) return null;

  const currentModelId = getString(modelsRaw, 'currentModelId');
  const availableModelsCandidate = modelsRaw.availableModels;
  const availableModelsRaw: unknown[] | null = Array.isArray(availableModelsCandidate) ? availableModelsCandidate : null;
  if (!currentModelId || !availableModelsRaw) return null;

  const models = availableModelsRaw.flatMap((value) => {
    const raw = asRecord(value);
    const normalized = raw ? normalizeSessionModel(raw) : null;
    return raw && normalized ? [{ raw, normalized }] : [];
  });

  // ACP reports the current selection independently of the selectable catalog.
  // Native Agents can use a custom model without advertising it as a choice.
  if (availableModelsRaw.length > 0 && models.length === 0) return null;

  return { currentModelId, models };
}

function normalizeProjectedSessionModel(projected: SessionModel, originalId: string): SessionModel {
  const revalidated = normalizeSessionModel(projected as unknown as Record<string, unknown>);
  if (!revalidated || revalidated.id !== originalId) {
    throw new Error('ACP model projector returned an invalid model');
  }
  return revalidated;
}

export function readSessionModelStateFromSessionResponse(
  sessionResponse: unknown,
  projectModel?: SessionModelProjector,
): SessionModelState | null {
  const response = readSessionModelResponse(sessionResponse);
  if (!response) return null;
  return {
    currentModelId: response.currentModelId,
    availableModels: response.models.map(({ raw, normalized }) => projectModel
      ? normalizeProjectedSessionModel(projectModel(raw, normalized), normalized.id)
      : normalized),
  };
}

export async function readSessionModelStateFromSessionResponseAwaitable(
  sessionResponse: unknown,
  projectModel?: AwaitableSessionModelProjector,
): Promise<SessionModelState | null> {
  const response = readSessionModelResponse(sessionResponse);
  if (!response) return null;

  const availableModels: SessionModel[] = [];
  for (const { raw, normalized } of response.models) {
    availableModels.push(projectModel
      ? normalizeProjectedSessionModel(await projectModel(raw, normalized), normalized.id)
      : normalized);
  }
  return { currentModelId: response.currentModelId, availableModels };
}

export function readSessionConfigOptionsFromSessionResponse(
  sessionResponse: unknown,
  disableModeControls = false,
): ReadonlyArray<SessionConfigOption> | null {
  const response = asRecord(sessionResponse);
  if (!response) return null;

  const configOptionsCandidate = (response as { configOptions?: unknown }).configOptions;
  const configOptionsRaw: unknown[] | null = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
  if (!configOptionsRaw) return null;

  return normalizeSessionConfigOptions(configOptionsRaw, disableModeControls);
}

export function resolveSessionModelConfigOption(
  configOptions: ReadonlyArray<SessionConfigOption>,
  modelConfigOptionId?: string,
): SessionConfigOption | null {
  const eligible = configOptions.filter((option) => (option.type === 'select' || option.type === 'enum') && option.options !== undefined);
  const modelSelector = (option: SessionConfigOption | undefined): SessionConfigOption | null => (
    option && option.currentValue.trim().length > 0 && option.options?.every((choice) => choice.value.trim().length > 0)
      ? option
      : null
  );
  if (modelConfigOptionId !== undefined) {
    return modelSelector(eligible.find((option) => option.id === modelConfigOptionId));
  }
  const dedicated = eligible.filter((option) => option.id.toLowerCase() === 'model' || option.name.toLowerCase() === 'model');
  if (dedicated.length > 0) return dedicated.length === 1 ? modelSelector(dedicated[0]) : null;
  const categorized = eligible.filter((option) => option.category === 'model');
  return categorized.length === 1 ? modelSelector(categorized[0]) : null;
}

export function readSessionModelStateFromConfigOptions(
  sessionResponse: unknown,
  modelConfigOptionId?: string,
): SessionModelState | null {
  const configOptions = readSessionConfigOptionsFromSessionResponse(sessionResponse);
  if (!configOptions) return null;
  const modelOption = resolveSessionModelConfigOption(configOptions, modelConfigOptionId);
  if (!modelOption?.options) return null;

  // Known control IDs work without category hints. Model-control hints describe
  // the observed selection, not controls supported by every advertised model;
  // adjacent category=model settings remain in the full configuration catalog.
  const modelOptions = configOptions.filter((option) => option !== modelOption && (
    option.category === 'thought_level' || option.category === 'model_config' || [
      'effort', 'reasoning_effort', 'thought_level', 'fast', 'ultrafast',
    ].includes(option.id.toLowerCase().replaceAll('-', '_'))
  ));
  const availableModels = modelOption.options.map((option) => ({
    id: option.value,
    name: option.name,
    ...(option.description !== undefined ? { description: option.description } : {}),
    ...(option.value === modelOption.currentValue && modelOptions.length > 0 ? { modelOptions } : {}),
  }));
  if (availableModels.length > 0 && !availableModels.some((model) => model.id === modelOption.currentValue)) return null;
  return {
    currentModelId: modelOption.currentValue,
    availableModels,
  };
}
