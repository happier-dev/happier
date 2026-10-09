import { AIBackendProfileSchema, type AIBackendProfile } from './backendProfileSchema.js';
import {
  projectHistoricalCodingPromptBehaviorProfileOverrideV1,
  type CodingPromptBehaviorOverridesV1,
} from '../prompts/codingPromptBehaviorV1.js';

const HISTORICAL_GEMINI_PROFILE_IDS = new Set(['gemini-api-key', 'gemini-vertex']);

// Moving 0.2 predecessor, clean inspected producers at
// 37a6541578749067b49d4579be8c752c9591b8c8:
// providers/{claude,codex,gemini}/builtInBackendProfiles.ts and profiles/builtInProfileVersion.ts.
// Only reconstruct definitions for retained private bindings/stacks. This is not a
// current preset catalog or a source of new-profile creation choices.
const historicalPresetBase = {
  defaultPermissionModeByAgent: {}, defaultPersistenceModeByTargetKey: {},
  defaultPersistenceModeByAgent: {}, compatibility: {}, isBuiltIn: true,
  defaultEnabled: true, createdAt: 0, updatedAt: 0, version: '1.0.0',
} as const;
const historicalClaudePresetBase = {
  ...historicalPresetBase, defaultPermissionModeByTargetKey: { 'agent:claude': 'default' },
  compatibilityByTargetKey: { 'agent:claude': true, 'agent:codex': false, 'agent:gemini': false },
} as const;
const historicalCodexPresetBase = {
  ...historicalPresetBase, defaultPermissionModeByTargetKey: { 'agent:codex': 'default' },
  compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': true, 'agent:gemini': false },
} as const;
const historicalGeminiPresetBase = {
  ...historicalPresetBase, defaultPermissionModeByTargetKey: { 'agent:gemini': 'default' },
  compatibilityByTargetKey: { 'agent:claude': false, 'agent:codex': false, 'agent:gemini': true },
} as const;
const historicalBuiltInProfiles: readonly AIBackendProfile[] = [
  { ...historicalClaudePresetBase, id: 'anthropic', name: 'Anthropic (Default)',
    authMode: 'machineLogin', requiresMachineLoginTargetKey: 'agent:claude', environmentVariables: [], envVarRequirements: [] },
  { ...historicalClaudePresetBase, id: 'deepseek', name: 'DeepSeek (Reasoner)',
    envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
      { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
      { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-reasoner}' },
      { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-chat}' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
    ] },
  { ...historicalClaudePresetBase, id: 'zai', name: 'Z.AI (GLM-4.6)',
    envVarRequirements: [{ name: 'Z_AI_AUTH_TOKEN', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' },
      { name: 'API_TIMEOUT_MS', value: '${Z_AI_API_TIMEOUT_MS:-3000000}' },
      { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${Z_AI_OPUS_MODEL:-GLM-4.6}' },
      { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${Z_AI_SONNET_MODEL:-GLM-4.6}' },
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}' },
    ] },
  { ...historicalClaudePresetBase, id: 'minimax', name: 'MiniMax (M3)',
    envVarRequirements: [{ name: 'MINIMAX_AUTH_TOKEN', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${MINIMAX_AUTH_TOKEN}' },
      { name: 'API_TIMEOUT_MS', value: '${MINIMAX_API_TIMEOUT_MS:-600000}' },
      { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '${MINIMAX_AUTO_COMPACT_WINDOW:-1000000}' },
      { name: 'ANTHROPIC_MODEL', value: '${MINIMAX_MODEL:-MiniMax-M3}' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${MINIMAX_OPUS_MODEL:-MiniMax-M3}' },
      { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${MINIMAX_SONNET_MODEL:-MiniMax-M3}' },
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${MINIMAX_HAIKU_MODEL:-MiniMax-M2.7}' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${MINIMAX_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
    ] },
  { ...historicalClaudePresetBase, id: 'minimax-cn', name: 'MiniMax (M3, CN)',
    envVarRequirements: [{ name: 'MINIMAX_CN_AUTH_TOKEN', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${MINIMAX_CN_BASE_URL:-https://api.minimaxi.com/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${MINIMAX_CN_AUTH_TOKEN}' },
      { name: 'API_TIMEOUT_MS', value: '${MINIMAX_CN_API_TIMEOUT_MS:-600000}' },
      { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '${MINIMAX_CN_AUTO_COMPACT_WINDOW:-1000000}' },
      { name: 'ANTHROPIC_MODEL', value: '${MINIMAX_CN_MODEL:-MiniMax-M3}' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${MINIMAX_CN_OPUS_MODEL:-MiniMax-M3}' },
      { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${MINIMAX_CN_SONNET_MODEL:-MiniMax-M3}' },
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${MINIMAX_CN_HAIKU_MODEL:-MiniMax-M2.7}' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${MINIMAX_CN_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
    ] },
  { ...historicalCodexPresetBase, id: 'codex', name: 'Codex (Default)', authMode: 'machineLogin',
    requiresMachineLoginTargetKey: 'agent:codex', environmentVariables: [], envVarRequirements: [] },
  { ...historicalCodexPresetBase, id: 'openai', name: 'OpenAI (GPT-5)',
    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'OPENAI_BASE_URL', value: 'https://api.openai.com/v1' },
      { name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' },
      { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
      { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
      { name: 'API_TIMEOUT_MS', value: '600000' },
      { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
    ] },
  { ...historicalCodexPresetBase, id: 'azure-openai', name: 'Azure OpenAI',
    envVarRequirements: [{ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', required: true }],
    environmentVariables: [
      { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
      { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' }, { name: 'API_TIMEOUT_MS', value: '600000' },
    ] },
  { ...historicalGeminiPresetBase, id: 'gemini', name: 'Gemini (Default)', authMode: 'machineLogin',
    requiresMachineLoginTargetKey: 'agent:gemini', environmentVariables: [], envVarRequirements: [] },
  { ...historicalGeminiPresetBase, id: 'gemini-api-key', name: 'Gemini (API key)',
    envVarRequirements: [{ name: 'GEMINI_API_KEY', kind: 'secret', required: true }], environmentVariables: [] },
  { ...historicalGeminiPresetBase, id: 'gemini-vertex', name: 'Gemini (Vertex AI)',
    envVarRequirements: [{ name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
      { name: 'GOOGLE_CLOUD_LOCATION', kind: 'config', required: true }],
    environmentVariables: [{ name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' }] },
];
const LEGACY_AI_LAUNCH_BUILT_IN_PROFILE_IDS_V1 = new Set(historicalBuiltInProfiles.map((profile) => profile.id));

/** Lossless predecessor definition for a binding/stack-only retained identity. */
export function getHistoricalBuiltInAiLaunchProfileV1(profileId: string): AIBackendProfile | null {
  const profile = historicalBuiltInProfiles.find((candidate) => candidate.id === profileId);
  return profile ? AIBackendProfileSchema.parse(profile) : null;
}

export function isHistoricalBuiltInAiLaunchProfileIdV1(profileId: string): boolean {
  return LEGACY_AI_LAUNCH_BUILT_IN_PROFILE_IDS_V1.has(profileId);
}

/**
 * Executable projection of a persisted legacy AI profile. The raw
 * predecessor-only coding-prompt field is admitted by the legacy schema and
 * projected onto the canonical V2 sparse override semantics. It remains on
 * the legacy shape solely so a legacy form can retain its source field during
 * an in-place save; effective behavior consumes only the projected field.
 */
export type HistoricalAiBackendProfileV1 = AIBackendProfile & Readonly<{
  codingPromptBehaviorOverrides?: CodingPromptBehaviorOverridesV1;
}>;

/**
 * Compatibility projection for retained historical Gemini launch profiles.
 * Their generated default was never a user-authored preference, so every
 * parsed copy must lose the obsolete model pin while the raw settings row is
 * preserved for lossless migration and conflict handling.
 */
export function projectHistoricalBuiltInAiLaunchProfileV1(profile: AIBackendProfile): HistoricalAiBackendProfileV1 {
  const codingPromptBehaviorOverrides = projectHistoricalCodingPromptBehaviorProfileOverrideV1(
    profile.codingPromptBehaviorV1,
  );
  const projected: HistoricalAiBackendProfileV1 = {
    ...profile,
    ...(codingPromptBehaviorOverrides !== undefined ? { codingPromptBehaviorOverrides } : {}),
  };

  if (!HISTORICAL_GEMINI_PROFILE_IDS.has(profile.id)) return projected;
  return {
    ...projected,
    environmentVariables: projected.environmentVariables.filter((entry) => entry.name !== 'GEMINI_MODEL'),
  };
}
