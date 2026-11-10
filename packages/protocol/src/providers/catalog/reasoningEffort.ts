import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { AgentModelOption, ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import type { AgentProviderRequirementsV1 } from '../compatibility/v1.js';

export const PROVIDER_REASONING_EFFORT_OPTION_ID = 'reasoning_effort' as const;

/** Exact admitted model facts. A capability bit alone does not declare any effort values. */
export function readProviderReasoningEffortOption(
  model: Pick<ProviderModelDescriptorV1, 'capabilities' | 'modelOptions'>,
): AgentModelOption | null {
  if (model.capabilities?.reasoningControls !== 'supported') return null;
  const option = model.modelOptions?.find(candidate => candidate.id === PROVIDER_REASONING_EFFORT_OPTION_ID);
  if (option?.type !== 'select' || !option.options?.length) return null;
  const values = new Set(option.options.map(candidate => candidate.value));
  return values.size === option.options.length && values.has(option.currentValue) ? option : null;
}

/** Agent declarations govern application; source descriptors retain their model-owned facts. */
export function projectProviderModelReasoningForAgent<TModel extends ProviderModelDescriptorV1>(
  model: TModel,
  agent: Pick<AgentProviderRequirementsV1, 'supportsReasoningEffort'>,
): TModel {
  if (!model.modelOptions
    || agent.supportsReasoningEffort === true && readProviderReasoningEffortOption(model) !== null) return model;
  const retained = model.modelOptions.filter(option => option.id !== PROVIDER_REASONING_EFFORT_OPTION_ID
    && option.overridesWhenOn?.optionIds.includes(PROVIDER_REASONING_EFFORT_OPTION_ID) !== true);
  if (retained.length === model.modelOptions.length) return model;
  const { modelOptions: _modelOptions, ...rest } = model;
  // Only retained entries of the caller's own option list are removed.
  return { ...rest, ...(retained.length ? { modelOptions: retained } : {}) } as TModel;
}

export const PROVIDER_REASONING_EFFORT_LEVELS_V1 = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ProviderReasoningEffortLevelV1Schema = lazyZodSchema(() => z.enum(PROVIDER_REASONING_EFFORT_LEVELS_V1));
export type ProviderReasoningEffortLevelV1 = z.infer<typeof ProviderReasoningEffortLevelV1Schema>;
export const ProviderReasoningEffortLevelsV1Schema = lazyZodSchema(() => z.array(ProviderReasoningEffortLevelV1Schema).check(
  z.minLength(1), z.maxLength(PROVIDER_REASONING_EFFORT_LEVELS_V1.length),
  z.superRefine((levels, ctx) => {
    if (new Set(levels).size !== levels.length) {
      ctx.addIssue({ code: 'custom', message: 'Reasoning effort levels must be unique' });
    }
  }),
));

export function formatProviderReasoningEffortLevelLabel(level: ProviderReasoningEffortLevelV1): string {
  switch (level) {
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'XHigh';
    case 'max': return 'Max';
  }
}

/** One effort-select projection for endpoint evidence, static facts and user declarations. */
export function buildProviderReasoningModelOptions(input: Readonly<{
  supportedLevels: readonly ProviderReasoningEffortLevelV1[];
  defaultEffort?: ProviderReasoningEffortLevelV1 | null;
}>): readonly AgentModelOption[] {
  const supported = new Set(input.supportedLevels);
  const levels = PROVIDER_REASONING_EFFORT_LEVELS_V1.filter(level => supported.has(level));
  if (levels.length === 0) return [];
  const currentValue = input.defaultEffort && supported.has(input.defaultEffort)
    ? input.defaultEffort : supported.has('high') ? 'high' : levels[levels.length - 1]!;
  return [{ id: PROVIDER_REASONING_EFFORT_OPTION_ID, name: 'Thinking', type: 'select', currentValue,
    options: levels.map(level => ({ value: level, name: formatProviderReasoningEffortLevelLabel(level) })) }];
}
