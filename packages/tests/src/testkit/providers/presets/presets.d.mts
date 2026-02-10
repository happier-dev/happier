export type ProviderPresetId = 'opencode' | 'claude' | 'codex' | 'kilo' | 'gemini' | 'qwen' | 'kimi' | 'auggie' | 'all';
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
export const ACP_PROVIDER_PRESET_IDS: readonly ProviderAcpPresetId[];

export function resolveProviderPresetIds(id: string): ProviderConcretePresetId[] | null;
export function parseMaxParallel(raw: unknown, fallback?: number): number | null;
export function filterProviderIdsForScenarioSelection(providerIds: readonly string[], scenarioSelectionRaw: unknown): string[];
export function resolveProviderRunPreset(id: string, tier: string): ProviderRunPreset | null;
