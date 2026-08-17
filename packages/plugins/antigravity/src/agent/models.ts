import type { AgentModelConfig, AgentModelDescriptor } from '@happier-dev/plugin-sdk/agents';

export const ANTIGRAVITY_DEFAULT_MODEL_ID = 'Gemini 3.5 Flash (Medium)';

export type AntigravitySdkThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type AntigravitySdkModelSelection = Readonly<{
  rawModelId: string;
  thinkingLevel?: AntigravitySdkThinkingLevel;
}>;

const ANTIGRAVITY_SDK_MODEL_LABELS = Object.freeze({
  'Gemini 3.5 Flash (Low)': { rawModelId: 'gemini-3.5-flash', thinkingLevel: 'low' },
  'Gemini 3.5 Flash (Medium)': { rawModelId: 'gemini-3.5-flash', thinkingLevel: 'medium' },
  'Gemini 3.5 Flash (High)': { rawModelId: 'gemini-3.5-flash', thinkingLevel: 'high' },
  'Gemini 3.1 Pro (Low)': { rawModelId: 'gemini-3.1-pro', thinkingLevel: 'low' },
  'Gemini 3.1 Pro (High)': { rawModelId: 'gemini-3.1-pro', thinkingLevel: 'high' },
} satisfies Record<string, AntigravitySdkModelSelection>);

function readModelId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRawGeminiModelId(modelId: string): boolean {
  return /^gemini-[a-z0-9][a-z0-9.-]*$/i.test(modelId);
}

export function mapAntigravityModelIdToSdkModel(value: unknown): AntigravitySdkModelSelection {
  const modelId = readModelId(value) ?? ANTIGRAVITY_DEFAULT_MODEL_ID;
  const mapped = ANTIGRAVITY_SDK_MODEL_LABELS[modelId as keyof typeof ANTIGRAVITY_SDK_MODEL_LABELS];
  if (mapped) return mapped;
  if (isRawGeminiModelId(modelId)) return { rawModelId: modelId };
  throw new Error(`Antigravity SDK mode supports Gemini models only; "${modelId}" is available only in Antigravity CLI mode.`);
}

export const ANTIGRAVITY_STATIC_MODELS: readonly AgentModelDescriptor[] = Object.freeze([{
  id: ANTIGRAVITY_DEFAULT_MODEL_ID,
  name: ANTIGRAVITY_DEFAULT_MODEL_ID,
  description: 'Observed Antigravity CLI model fallback. The full list is discovered dynamically with agy models.',
}]);

export const ANTIGRAVITY_AGENT_MODEL_CONFIG: AgentModelConfig = Object.freeze({
  supportsSelection: true,
  supportsFreeform: false,
  nonAcpApplyScope: 'next_prompt',
  acpApplyBehavior: 'restart_session',
  acpModelConfigOptionId: null,
  dynamicProbe: 'auto',
  defaultMode: ANTIGRAVITY_DEFAULT_MODEL_ID,
  allowedModes: ANTIGRAVITY_STATIC_MODELS.map((model) => model.id),
  staticModels: ANTIGRAVITY_STATIC_MODELS,
} satisfies AgentModelConfig);
