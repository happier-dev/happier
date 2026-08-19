import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import { sanitizeCursorModelScopedConfigOption } from '@/backends/cursor/acp/cursorModelConfigProjection';
import type { CursorSessionModelsFromConfigOptions } from '@/backends/cursor/acp/cursorModelConfigTypes';

import type { CursorAvailableModel } from './schemas';

function mergeOptions(
  primary: ReadonlyArray<SessionConfigOption> | undefined,
  secondary: ReadonlyArray<SessionConfigOption> | undefined,
): ReadonlyArray<SessionConfigOption> | undefined {
  const merged: SessionConfigOption[] = [];
  const seen = new Set<string>();
  for (const rawOption of [...(primary ?? []), ...(secondary ?? [])]) {
    const option = sanitizeCursorModelScopedConfigOption(rawOption);
    if (!option.id.trim() || seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push(option);
  }
  return merged.length > 0 ? merged : undefined;
}

export function projectCursorAvailableModels(params: Readonly<{
  proprietaryModels: ReadonlyArray<CursorAvailableModel>;
  standardProjection: CursorSessionModelsFromConfigOptions | null;
}>): CursorSessionModelsFromConfigOptions | null {
  const models: CursorSessionModelsFromConfigOptions['availableModels'][number][] = [];
  const indexById = new Map<string, number>();

  for (const model of params.proprietaryModels) {
    if (indexById.has(model.value)) continue;
    indexById.set(model.value, models.length);
    const modelOptions = mergeOptions(model.configOptions, undefined);
    models.push({
      id: model.value,
      name: model.name,
      ...(modelOptions ? { modelOptions } : {}),
    });
  }

  for (const standardModel of params.standardProjection?.availableModels ?? []) {
    const existingIndex = indexById.get(standardModel.id);
    if (existingIndex === undefined) {
      indexById.set(standardModel.id, models.length);
      models.push(standardModel);
      continue;
    }
    const existing = models[existingIndex]!;
    const modelOptions = mergeOptions(existing.modelOptions, standardModel.modelOptions);
    if (modelOptions) models[existingIndex] = { ...existing, modelOptions };
  }

  if (models.length === 0) return params.standardProjection;
  const standardCurrent = params.standardProjection?.currentModelId;
  const currentModelId = standardCurrent && indexById.has(standardCurrent)
    ? standardCurrent
    : models[0]!.id;
  return { currentModelId, availableModels: models };
}
