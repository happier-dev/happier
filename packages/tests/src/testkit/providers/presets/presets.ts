import {
  ACP_PROVIDER_PRESET_IDS as ACP_PROVIDER_PRESET_IDS_IMPL,
  PROVIDER_PRESET_IDS as PROVIDER_PRESET_IDS_IMPL,
  filterProviderIdsForScenarioSelection as filterProviderIdsForScenarioSelectionImpl,
  parseMaxParallel as parseMaxParallelImpl,
  resolveProviderPresetIds as resolveProviderPresetIdsImpl,
  resolveProviderRunPreset as resolveProviderRunPresetImpl,
} from './presets.mjs';

export type ProviderPresetId = 'opencode' | 'claude' | 'codex' | 'kilo' | 'gemini' | 'qwen' | 'kimi' | 'auggie' | 'pi' | 'copilot' | 'all';
export type ProviderScenarioTier = 'smoke' | 'extended';
export type ProviderConcretePresetId = Exclude<ProviderPresetId, 'all'>;
export type ProviderAcpPresetId = Exclude<ProviderConcretePresetId, 'claude'>;

export type ProviderRunPreset = {
  id: ProviderPresetId;
  tier: ProviderScenarioTier;
  title: string;
  env: Record<string, string>;
};

export const PROVIDER_PRESET_IDS = PROVIDER_PRESET_IDS_IMPL as readonly ProviderConcretePresetId[];
export const ACP_PROVIDER_PRESET_IDS = ACP_PROVIDER_PRESET_IDS_IMPL as readonly ProviderAcpPresetId[];

export function resolveProviderPresetIds(id: string): ProviderConcretePresetId[] | null {
  return resolveProviderPresetIdsImpl(id) as ProviderConcretePresetId[] | null;
}

export function parseMaxParallel(raw: unknown, fallback = 4): number | null {
  const value = typeof raw === 'string' ? raw : undefined;
  return parseMaxParallelImpl(value, fallback);
}

export function filterProviderIdsForScenarioSelection(providerIds: readonly string[], scenarioSelectionRaw: unknown): string[] {
  const scenario = typeof scenarioSelectionRaw === 'string' ? scenarioSelectionRaw : undefined;
  return filterProviderIdsForScenarioSelectionImpl([...providerIds], scenario);
}

export function resolveProviderRunPreset(id: string, tier: string): ProviderRunPreset | null {
  return resolveProviderRunPresetImpl(id, tier) as ProviderRunPreset | null;
}
