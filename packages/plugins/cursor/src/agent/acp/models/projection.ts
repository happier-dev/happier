import type { AgentSessionModelsSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';

import type { CursorAvailableModel } from './schemas.js';

function canonicalCursorModelOptionIdentity(
  id: string,
): Readonly<{ id: string; name: string }> | null {
  const normalized = id.trim().toLowerCase().replace(/[_\s]+/gu, '-');
  switch (normalized) {
    case 'reasoning':
    case 'effort':
    case 'reasoning-effort':
    case 'thought-level':
      return { id: 'reasoning_effort', name: 'Reasoning effort' };
    case 'context':
    case 'context-size':
    case 'context-window':
      return { id: 'context', name: 'Context' };
    case 'thinking':
      return { id: 'thinking', name: 'Thinking' };
    case 'fast':
      return { id: 'fast', name: 'Fast' };
    default:
      return null;
  }
}

export function projectCursorRuntimeModels(
  proprietaryModels: readonly CursorAvailableModel[],
): NonNullable<AgentSessionModelsSnapshot['models']> {
  const models: Array<NonNullable<AgentSessionModelsSnapshot['models']>[number]> = [];
  const seen = new Set<string>();
  for (const model of proprietaryModels) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    const modelOptions = [];
    const seenOptionIds = new Set<string>();
    for (const option of model.configOptions ?? []) {
      const canonical = canonicalCursorModelOptionIdentity(option.id);
      const id = canonical?.id ?? option.id;
      if (seenOptionIds.has(id)) continue;
      seenOptionIds.add(id);
      modelOptions.push(Object.freeze({
        id,
        name: canonical?.name ?? option.name,
        ...(option.description === undefined ? {} : { description: option.description }),
        type: option.type,
        currentValue: option.currentValue,
        options: Object.freeze(option.options.map((choice) => Object.freeze({
          value: choice.value,
          name: choice.name,
          ...(choice.description === undefined ? {} : { description: choice.description }),
        }))),
      }));
    }
    models.push(Object.freeze({
      id: model.value,
      name: model.name,
      ...(modelOptions.length > 0 ? { modelOptions: Object.freeze(modelOptions) } : {}),
    }));
  }
  return Object.freeze(models);
}
