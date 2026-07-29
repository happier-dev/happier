export type SessionConfigOptionValueId = string;

export type SessionConfigOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: SessionConfigOptionValueId;
  options?: ReadonlyArray<Readonly<{ value: SessionConfigOptionValueId; name: string; description?: string }>>;
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
  modelOptions?: SessionConfigOption[];
};

export type SessionModelState = {
  currentModelId: string;
  availableModels: SessionModel[];
};

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

function normalizeConfigOptionValueId(value: unknown): SessionConfigOptionValueId | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

export function normalizeSessionConfigOptions(raw: ReadonlyArray<unknown>): SessionConfigOption[] {
  const out: SessionConfigOption[] = [];

  for (const entryRaw of raw) {
    const entry = asRecord(entryRaw);
    if (!entry) continue;

    const id = getString(entry, 'id');
    const name = getString(entry, 'name');
    const type = getString(entry, 'type');
    if (!id || !name || !type) continue;

    const currentValue = normalizeConfigOptionValueId((entry as any).currentValue);
    if (currentValue === null) continue;

    const description = getString(entry, 'description');
    const optionsCandidate = (entry as any).options;
    const optionsRaw = Array.isArray(optionsCandidate) ? optionsCandidate : null;

    let options: SessionConfigOption['options'] | undefined = undefined;
    if (optionsRaw) {
      const normalized: Array<{ value: SessionConfigOptionValueId; name: string; description?: string }> = [];
      for (const optRaw of optionsRaw) {
        const opt = asRecord(optRaw);
        if (!opt) continue;
        const value = normalizeConfigOptionValueId((opt as any).value);
        const optName = getString(opt, 'name');
        if (value === null || !optName) continue;
        const optDescription = getString(opt, 'description');
        normalized.push({ value, name: optName, ...(optDescription ? { description: optDescription } : {}) });
      }
      if (normalized.length > 0) options = normalized;
    }

    out.push({
      id,
      name,
      type,
      currentValue,
      ...(description ? { description } : {}),
      ...(options ? { options } : {}),
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
      return { id, name, ...(description ? { description } : {}) };
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
  const modelOptionsCandidate = model.modelOptions ?? model.model_options;
  const modelOptionsRaw: unknown[] | null = Array.isArray(modelOptionsCandidate) ? modelOptionsCandidate : null;
  const modelOptions = modelOptionsRaw ? normalizeSessionConfigOptions(modelOptionsRaw) : null;
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(modelOptions && modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

export function readSessionModelStateFromSessionResponse(
  sessionResponse: unknown,
  projectModel?: SessionModelProjector,
): SessionModelState | null {
  const response = asRecord(sessionResponse);
  if (!response) return null;
  const modelsRaw = asRecord(response.models);
  if (!modelsRaw) return null;

  const currentModelId = getString(modelsRaw, 'currentModelId');
  const availableModelsCandidate = (modelsRaw as { availableModels?: unknown }).availableModels;
  const availableModelsRaw: unknown[] | null = Array.isArray(availableModelsCandidate) ? availableModelsCandidate : null;
  if (!currentModelId || !availableModelsRaw) return null;

  const availableModels: SessionModel[] = availableModelsRaw
    .map((model: unknown) => asRecord(model))
    .filter((model): model is Record<string, unknown> => Boolean(model))
    .map((model) => {
      const normalized = normalizeSessionModel(model);
      if (!normalized || !projectModel) return normalized;
      const projected = projectModel(model, normalized);
      const revalidated = normalizeSessionModel(projected as unknown as Record<string, unknown>);
      if (!revalidated || revalidated.id !== normalized.id) {
        throw new Error('ACP model projector returned an invalid model');
      }
      return revalidated;
    })
    .filter((model): model is SessionModel => Boolean(model));

  if (
    availableModels.length === 0
    || !availableModels.some((model) => model.id === currentModelId)
  ) return null;

  return { currentModelId, availableModels };
}

export async function readSessionModelStateFromSessionResponseAwaitable(
  sessionResponse: unknown,
  projectModel?: AwaitableSessionModelProjector,
): Promise<SessionModelState | null> {
  const response = asRecord(sessionResponse);
  if (!response) return null;
  const modelsRaw = asRecord(response.models);
  if (!modelsRaw) return null;

  const currentModelId = getString(modelsRaw, 'currentModelId');
  const availableModelsCandidate = modelsRaw.availableModels;
  if (!currentModelId || !Array.isArray(availableModelsCandidate)) return null;

  const availableModels: SessionModel[] = [];
  for (const modelValue of availableModelsCandidate) {
    const model = asRecord(modelValue);
    if (!model) continue;
    const normalized = normalizeSessionModel(model);
    if (!normalized) continue;
    const projected = projectModel
      ? await projectModel(model, normalized)
      : normalized;
    const revalidated = normalizeSessionModel(projected as unknown as Record<string, unknown>);
    if (!revalidated || revalidated.id !== normalized.id) {
      throw new Error('ACP model projector returned an invalid model');
    }
    availableModels.push(revalidated);
  }
  if (
    availableModels.length === 0
    || !availableModels.some((model) => model.id === currentModelId)
  ) {
    return null;
  }
  return { currentModelId, availableModels };
}

export function readSessionConfigOptionsFromSessionResponse(
  sessionResponse: unknown
): ReadonlyArray<SessionConfigOption> | null {
  const response = asRecord(sessionResponse);
  if (!response) return null;

  const configOptionsCandidate = (response as { configOptions?: unknown }).configOptions;
  const configOptionsRaw: unknown[] | null = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
  if (!configOptionsRaw) return null;

  return normalizeSessionConfigOptions(configOptionsRaw);
}
