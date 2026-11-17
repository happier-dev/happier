// Single declaration of the preset vocabulary, beside the runtime table that
// defines it (`PROVIDER_ENV_FLAG_BY_PRESET_ID`); `presets.ts` re-exports these
// types instead of keeping a second copy.
export type ProviderPresetId = 'opencode' | 'opencode_server' | 'claude' | 'codex' | 'kilo' | 'gemini' | 'qwen' | 'kimi' | 'auggie' | 'pi' | 'copilot' | 'grok' | 'fx' | 'droid' | 'devin' | 'antigravity' | 'codex_acp_stub' | 'cursor_acp_stub' | 'all';
export type ProviderConcretePresetId = Exclude<ProviderPresetId, 'all'>;
export type ProviderAcpPresetId = Exclude<ProviderConcretePresetId, 'claude'>;
export type ProviderScenarioTier = 'smoke' | 'extended';

export type ProviderRunPreset = {
  id: ProviderPresetId;
  tier: ProviderScenarioTier;
  title: string;
  env: Record<string, string>;
};

export const PROVIDER_PRESET_IDS: readonly ProviderConcretePresetId[];
export const STUB_PROVIDER_PRESET_IDS: readonly ProviderConcretePresetId[];
export const ACP_PROVIDER_PRESET_IDS: readonly ProviderAcpPresetId[];

export function resolveProviderPresetIds(id: string): ProviderConcretePresetId[] | null;
export function parseMaxParallel(raw: unknown, fallback?: number): number | null;
export function filterProviderIdsForScenarioSelection(providerIds: readonly string[], scenarioSelectionRaw: unknown): string[];
export function resolveProviderRunPreset(id: string, tier: string): ProviderRunPreset | null;
