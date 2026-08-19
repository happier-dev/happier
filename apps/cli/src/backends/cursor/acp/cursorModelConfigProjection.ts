import type { SessionConfigOption } from '@/agent/acp/AcpBackend';
import { isAcpModelScopedConfigOption } from '@/agent/acp/runtime/sessionModelsState';

import type {
  CursorSessionModelsFromConfigOptions,
  CursorSessionModesFromConfigOptions,
} from './cursorModelConfigTypes';
import {
  findCursorModeConfigOption,
  findCursorModelConfigOption,
  isCursorModeConfigOption,
  isCursorModelConfigOption,
} from './cursorModelConfigLookup';
import {
  formatModelOptionChoiceLabel,
  formatModelOptionValueLabel,
  modelConfigOptionControlId,
  modelParamControlId,
  modelParamControlName,
  modelParamControlType,
  sortModelParamControlIds,
  sortModelParamValues,
  toDisplayModelId,
} from './cursorModelConfigControls';
import {
  normalizeToken,
  parseParameterizedModelValue,
  stringifyConfigValue,
} from './cursorModelConfigParsing';

export function sanitizeCursorModelScopedConfigOption(option: SessionConfigOption): SessionConfigOption {
  const controlId = modelConfigOptionControlId(option);
  const canonicalOption: SessionConfigOption = controlId && controlId !== option.id
    ? {
        ...option,
        id: controlId,
        name: modelParamControlName(controlId),
      }
    : controlId === 'reasoning_effort'
      ? {
          ...option,
          name: modelParamControlName(controlId),
        }
      : option;

  if (!controlId) return canonicalOption;

  const normalizeChoice = (
    choice: NonNullable<SessionConfigOption['options']>[number],
    params: Readonly<{ stripDescription: boolean }>,
  ) => {
    const { description: _choiceDescription, ...choiceRest } = choice;
    const baseChoice = params.stripDescription ? choiceRest : choice;
    const value = stringifyConfigValue(choice.value);
    return {
      ...baseChoice,
      value,
      name: formatModelOptionChoiceLabel(controlId, value),
    };
  };

  if (controlId !== 'fast') {
    return {
      ...canonicalOption,
      ...(canonicalOption.options
        ? { options: canonicalOption.options.map((choice) => normalizeChoice(choice, { stripDescription: false })) }
        : {}),
    };
  }

  const { description: _description, options, currentValue, ...rest } = canonicalOption;
  const fastChoices = options && options.length > 0
    ? options
    : [
        { value: 'false', name: 'Off' },
        { value: 'true', name: 'Fast' },
      ];
  return {
    ...rest,
    type: 'select',
    currentValue: stringifyConfigValue(currentValue),
    options: fastChoices.map((choice) => normalizeChoice(choice, { stripDescription: true })),
  };
}

function collectRealModelScopedConfigOptions(
  configOptions: ReadonlyArray<SessionConfigOption>,
): ReadonlyArray<SessionConfigOption> {
  return configOptions.filter((option) =>
    !isCursorModelConfigOption(option) &&
    !isCursorModeConfigOption(option) &&
    isAcpModelScopedConfigOption(option)
  ).map(sanitizeCursorModelScopedConfigOption);
}

function mergeModelOptions(
  generatedOptions: ReadonlyArray<SessionConfigOption>,
  realModelScopedOptions: ReadonlyArray<SessionConfigOption>,
): ReadonlyArray<SessionConfigOption> | undefined {
  const options: SessionConfigOption[] = [];
  const seenIds = new Set<string>();
  for (const option of [...generatedOptions, ...realModelScopedOptions]) {
    if (!option.id.trim() || seenIds.has(option.id)) continue;
    seenIds.add(option.id);
    options.push(option);
  }
  return options.length > 0 ? options : undefined;
}

function collectModelParamValuesByControlId(
  choices: NonNullable<SessionConfigOption['options']>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const valuesByControlId = new Map<string, Set<string>>();
  for (const choice of choices) {
    const parsed = parseParameterizedModelValue(stringifyConfigValue(choice.value));
    for (const [key, value] of parsed.params) {
      const controlId = modelParamControlId(key);
      if (!controlId) continue;
      const values = valuesByControlId.get(controlId) ?? new Set<string>();
      values.add(value);
      valuesByControlId.set(controlId, values);
    }
  }
  return valuesByControlId;
}

function hasFullProductForModelParamControls(params: Readonly<{
  choices: NonNullable<SessionConfigOption['options']>;
  controlIds: ReadonlyArray<string>;
  valuesByControlId: ReadonlyMap<string, ReadonlySet<string>>;
}>): boolean {
  let expectedCombinations = 1;
  for (const controlId of params.controlIds) {
    const values = params.valuesByControlId.get(controlId);
    if (!values || values.size === 0) return false;
    expectedCombinations *= values.size;
  }

  const observedCombinations = new Set<string>();
  for (const choice of params.choices) {
    const parsed = parseParameterizedModelValue(stringifyConfigValue(choice.value));
    const valuesForChoice = new Map<string, string>();
    for (const [key, value] of parsed.params) {
      const controlId = modelParamControlId(key);
      if (controlId) valuesForChoice.set(controlId, value);
    }

    const parts: string[] = [];
    for (const controlId of params.controlIds) {
      const value = valuesForChoice.get(controlId);
      if (!value) return false;
      parts.push(value);
    }
    observedCombinations.add(parts.join('\u0000'));
  }

  return observedCombinations.size === expectedCombinations;
}

function formatExactParameterizedChoiceName(choice: NonNullable<SessionConfigOption['options']>[number]): string {
  const baseName = choice.name;
  const parsed = parseParameterizedModelValue(stringifyConfigValue(choice.value));
  const suffix = parsed.order
    .map((key) => {
      const controlId = modelParamControlId(key);
      const value = parsed.params.get(key);
      if (!controlId || !value) return '';
      return `${modelParamControlName(controlId)} ${formatModelOptionValueLabel(value)}`;
    })
    .filter(Boolean)
    .join(', ');
  return suffix ? `${baseName} (${suffix})` : baseName;
}

export function buildCursorSessionModelsFromConfigOptions(
  configOptions: ReadonlyArray<SessionConfigOption> | null,
): CursorSessionModelsFromConfigOptions | null {
  if (!configOptions || configOptions.length === 0) return null;
  const modelOption = findCursorModelConfigOption(configOptions);
  const choices = modelOption?.options;
  if (!modelOption || !choices || choices.length === 0) return null;

  const currentModelValue = stringifyConfigValue(modelOption.currentValue);
  const currentDisplayModelId = currentModelValue ? toDisplayModelId(currentModelValue) : 'default';
  let currentModelId = currentDisplayModelId;
  const realModelScopedOptions = collectRealModelScopedConfigOptions(configOptions);
  const groups = new Map<string, {
    id: string;
    name: string;
    description?: string;
    choices: Array<NonNullable<SessionConfigOption['options']>[number]>;
  }>();

  for (const choice of choices) {
    const value = stringifyConfigValue(choice.value);
    if (!value) continue;
    const id = toDisplayModelId(value);
    const existing = groups.get(id);
    if (existing) {
      existing.choices.push(choice);
      continue;
    }
    groups.set(id, {
      id,
      name: choice.name,
      ...(choice.description ? { description: choice.description } : {}),
      choices: [choice],
    });
  }

  const availableModels = Array.from(groups.values()).flatMap((group) => {
    const selectedChoice = group.id === currentModelId
      ? (group.choices.find((choice) => stringifyConfigValue(choice.value) === currentModelValue) ?? group.choices[0])
      : group.choices[0];
    const selectedParams = parseParameterizedModelValue(stringifyConfigValue(selectedChoice?.value)).params;
    const liveModelScopedOptions = group.id === currentDisplayModelId ? realModelScopedOptions : [];
    const valuesByControlId = collectModelParamValuesByControlId(group.choices);
    const varyingControlIds = Array.from(valuesByControlId.entries())
      .filter(([, values]) => values.size > 1)
      .map(([controlId]) => controlId);

    if (varyingControlIds.length > 0 && !hasFullProductForModelParamControls({
      choices: group.choices,
      controlIds: varyingControlIds,
      valuesByControlId,
    })) {
      if (group.id === currentDisplayModelId && currentModelValue) currentModelId = currentModelValue;
      return group.choices.map((choice) => {
        const id = stringifyConfigValue(choice.value);
        const modelOptions = mergeModelOptions([], liveModelScopedOptions);
        return {
          id,
          name: formatExactParameterizedChoiceName(choice),
          ...(choice.description ? { description: choice.description } : {}),
          ...(modelOptions ? { modelOptions } : {}),
        };
      });
    }

    const modelOptions = Array.from(valuesByControlId.entries())
      .filter(([, values]) => values.size > 1)
      .sort(([left], [right]) => sortModelParamControlIds(left, right))
      .map(([controlId, values]) => {
        const sortedValues = Array.from(values).sort((left, right) => sortModelParamValues(controlId, left, right));
        const selectedValue =
          Array.from(selectedParams.entries()).find(([key]) => modelParamControlId(key) === controlId)?.[1]
          ?? sortedValues[0]
          ?? '';
        return {
          id: controlId,
          name: modelParamControlName(controlId),
          category: 'model_config',
          type: modelParamControlType(controlId, sortedValues),
          currentValue: selectedValue,
          options: sortedValues.map((value) => ({
            value,
            name: formatModelOptionChoiceLabel(controlId, value),
          })),
        };
      });

    const mergedModelOptions = mergeModelOptions(modelOptions, liveModelScopedOptions);

    return {
      id: group.id,
      name: group.name,
      ...(group.description ? { description: group.description } : {}),
      ...(mergedModelOptions ? { modelOptions: mergedModelOptions } : {}),
    };
  });

  return {
    currentModelId,
    availableModels,
  };
}

export function buildCursorSessionModesFromConfigOptions(
  configOptions: ReadonlyArray<SessionConfigOption> | null,
): CursorSessionModesFromConfigOptions | null {
  if (!configOptions || configOptions.length === 0) return null;
  const modeOption = findCursorModeConfigOption(configOptions);
  const choices = modeOption?.options;
  if (!modeOption || !choices || choices.length === 0) return null;

  const currentModeId = stringifyConfigValue(modeOption.currentValue);
  if (!currentModeId) return null;

  const availableModes = choices
    .map((choice) => ({
      id: stringifyConfigValue(choice.value),
      name: choice.name,
      ...(choice.description ? { description: choice.description } : {}),
    }))
    .filter((mode) => mode.id && mode.name);
  if (availableModes.length === 0) return null;

  return {
    currentModeId,
    availableModes,
  };
}
