import {
  ANTHROPIC_EFFORT_LEVELS,
  buildAnthropicModelOptions,
  type AnthropicEffortLevel,
} from '@happier-dev/plugin-sdk/first-party/claude';
export {
  ANTHROPIC_EFFORT_LEVELS,
  buildAnthropicModelOptions,
  normalizeAnthropicModelDisplayName,
  formatAnthropicEffortLevelLabel,
  type AnthropicEffortLevel,
} from '@happier-dev/plugin-sdk/first-party/claude';

import type {
  ProviderCatalogParsedModel,
  ProviderContribution,
} from '@happier-dev/plugin-sdk/providers';

type ProviderStaticModel = Extract<
  ProviderContribution['catalog'],
  Readonly<{ source: 'static' | 'static+probe' }>
>['staticModels'][number];
type AnthropicStaticModel = Readonly<
  Omit<ProviderStaticModel, 'modelOptions'> & {
    modelOptions?: ProviderCatalogParsedModel['modelOptions'];
  }
>;

export const ANTHROPIC_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;

type AnthropicModelDefinition = Readonly<
  Omit<AnthropicStaticModel, 'contextWindowTokens' | 'extendedContextModelId' | 'modelOptions'> & {
    effortLevels?: readonly AnthropicEffortLevel[];
    defaultEffort?: AnthropicEffortLevel;
    oneMillionContext?: 'always' | 'optIn';
  }
>;

const ALL_EFFORT_LEVELS = ANTHROPIC_EFFORT_LEVELS;
const MAX_WITHOUT_XHIGH = ['low', 'medium', 'high', 'max'] as const;
const LEGACY_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

const ANTHROPIC_MODEL_DEFINITIONS = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', description: 'Latest Claude model for demanding reasoning and long-running agentic work.', effortLevels: ALL_EFFORT_LEVELS, oneMillionContext: 'always' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Latest Opus model for long-running agentic coding and knowledge work.', effortLevels: ALL_EFFORT_LEVELS, defaultEffort: 'medium', oneMillionContext: 'always' },
  { id: 'claude-opus-5', name: 'Opus 5', description: 'Prior Opus model for complex coding and reasoning tasks.', effortLevels: ALL_EFFORT_LEVELS, oneMillionContext: 'always' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', description: 'Latest balanced Claude model for coding, agentic work, editing, and analysis.', effortLevels: ALL_EFFORT_LEVELS, oneMillionContext: 'always' },
  { id: 'claude-fable-5', name: 'Fable 5', description: 'Prior Fable model for demanding coding and reasoning tasks.', effortLevels: ALL_EFFORT_LEVELS, oneMillionContext: 'always' },
  { id: 'claude-mythos-5', name: 'Mythos 5', description: 'Limited-availability Claude model for approved Project Glasswing customers.', effortLevels: ALL_EFFORT_LEVELS, oneMillionContext: 'always' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', description: 'Earlier Opus model for complex coding and reasoning tasks.', effortLevels: ALL_EFFORT_LEVELS, oneMillionContext: 'always' },
  { id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Prior highest-capability Claude model for hard coding and reasoning tasks.', effortLevels: ALL_EFFORT_LEVELS, defaultEffort: 'xhigh', oneMillionContext: 'always' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', description: 'Highest-capability Claude model for the hardest coding and reasoning tasks.', effortLevels: MAX_WITHOUT_XHIGH, oneMillionContext: 'optIn' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Balanced Claude model for everyday coding, editing, and analysis.', effortLevels: MAX_WITHOUT_XHIGH, oneMillionContext: 'optIn' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Fastest Claude option for lighter tasks and lower-latency replies.' },
  { id: 'claude-opus-4-5', name: 'Opus 4.5', description: 'Prior Opus generation alias for compatibility with existing Claude setups.', effortLevels: LEGACY_EFFORT_LEVELS },
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', description: 'Prior Sonnet generation alias for compatibility with existing Claude setups.' },
] as const satisfies readonly AnthropicModelDefinition[];

function normalizeModelId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value.replace(/\[[^\]]*\]$/u, '');
}

function readAnthropicModelDefinition(modelIdRaw: unknown): AnthropicModelDefinition | undefined {
  const modelId = normalizeModelId(modelIdRaw);
  return ANTHROPIC_MODEL_DEFINITIONS.find((definition) => definition.id === modelId);
}

export function isAnthropic1mContextSupportedModelId(modelIdRaw: unknown): boolean {
  return readAnthropicModelDefinition(modelIdRaw)?.oneMillionContext !== undefined;
}

export function isAnthropic1mAlwaysOnModelId(modelIdRaw: unknown): boolean {
  return readAnthropicModelDefinition(modelIdRaw)?.oneMillionContext === 'always';
}

export function isAnthropic1mContextOptInModelId(modelIdRaw: unknown): boolean {
  return isAnthropic1mContextSupportedModelId(modelIdRaw) && !isAnthropic1mAlwaysOnModelId(modelIdRaw);
}

export function resolveAnthropicEffortLevelsForModelId(modelIdRaw: unknown): readonly AnthropicEffortLevel[] {
  return readAnthropicModelDefinition(modelIdRaw)?.effortLevels ?? [];
}

export function resolveAnthropicDefaultEffortLevelForModelId(modelIdRaw: unknown): AnthropicEffortLevel | null {
  const definition = readAnthropicModelDefinition(modelIdRaw);
  const levels = definition?.effortLevels ?? [];
  if (levels.length === 0) return null;
  return definition?.defaultEffort ?? 'high';
}

function projectAnthropicModelDefinition(definition: AnthropicModelDefinition): AnthropicStaticModel {
  const { effortLevels = [], defaultEffort, oneMillionContext, ...model } = definition;
  const modelOptions = buildAnthropicModelOptions({
    supportedLevels: effortLevels,
    ...(defaultEffort ? { defaultEffort } : {}),
  });
  return {
    ...model,
    ...(oneMillionContext === 'always'
      ? { contextWindowTokens: ANTHROPIC_1M_CONTEXT_WINDOW_TOKENS }
      : {}),
    ...(oneMillionContext === 'optIn'
      ? { extendedContextModelId: `${model.id}[1m]` }
      : {}),
    ...(modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

export const ANTHROPIC_STATIC_MODELS: readonly AnthropicStaticModel[] = Object.freeze(
  ANTHROPIC_MODEL_DEFINITIONS.map(projectAnthropicModelDefinition),
);
