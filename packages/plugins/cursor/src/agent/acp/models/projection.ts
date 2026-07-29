import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agent-runtime';

import type { CursorAvailableModel } from './schemas.js';

type AgentSessionModelsSnapshot = ReturnType<
  Parameters<AgentSessionHostServices['models']['bind']>[0]['read']
>;

export function projectCursorRuntimeModels(
  proprietaryModels: readonly CursorAvailableModel[],
): NonNullable<AgentSessionModelsSnapshot['models']> {
  const models: Array<NonNullable<AgentSessionModelsSnapshot['models']>[number]> = [];
  const seen = new Set<string>();
  for (const model of proprietaryModels) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    models.push(Object.freeze({
      id: model.value,
      name: model.name,
      ...(model.configOptions?.length
        ? {
            modelOptions: Object.freeze(model.configOptions.map((option) => Object.freeze({
              id: option.id,
              name: option.name,
              ...(option.description === undefined ? {} : { description: option.description }),
              type: option.type,
              currentValue: option.currentValue,
              options: Object.freeze(option.options.map((choice) => Object.freeze({
                value: choice.value,
                name: choice.name,
                ...(choice.description === undefined ? {} : { description: choice.description }),
              }))),
            }))),
          }
        : {}),
    }));
  }
  return Object.freeze(models);
}
