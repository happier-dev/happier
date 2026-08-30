import {
  buildClaudeUltracodeModelOption,
  providers,
  type AgentModelDescriptor,
  type AgentModelOption,
} from '@happier-dev/agents';

import type { AnthropicModelEntry } from './fetchAnthropicModels';

const EFFORT_TIER_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortTier = (typeof EFFORT_TIER_ORDER)[number];

function resolveSupportedEffortTiers(entry: AnthropicModelEntry): readonly EffortTier[] {
  const effort = entry.capabilities?.effort;
  if (!effort || effort.supported === false) return [];
  return EFFORT_TIER_ORDER.filter((tier) => effort[tier]?.supported === true);
}

// Mirror the API default (`high`) when offered, then step down before stepping up. Preselecting a
// tier above `high` would spend more than the user asked for on a model we know nothing else about.
const DISCOVERED_DEFAULT_EFFORT_PREFERENCE: readonly EffortTier[] = ['high', 'medium', 'low', 'xhigh', 'max'];

function resolveDiscoveredDefaultEffort(tiers: readonly EffortTier[]): EffortTier | null {
  if (tiers.length === 0) return null;
  return DISCOVERED_DEFAULT_EFFORT_PREFERENCE.find((tier) => tiers.includes(tier)) ?? null;
}

/**
 * Derive the picker options + context window for a Claude model NOT in the static catalog,
 * straight from Anthropic Models API capabilities.
 *
 * Produces the same `modelOptions` shape as the static catalog's `withClaudeEffortModelOptions`
 * (a `reasoning_effort` select + an `ultracode` boolean on xhigh-capable models), so the UI
 * renders a discovered model identically to a curated one.
 */
export function deriveClaudeModelOptionsFromCapabilities(
  entry: AnthropicModelEntry,
): Readonly<{ contextWindowTokens?: number; modelOptions?: readonly AgentModelOption[] }> {
  const tiers = resolveSupportedEffortTiers(entry);
  const currentValue = resolveDiscoveredDefaultEffort(tiers);

  const modelOptions: AgentModelOption[] = [];
  if (tiers.length > 0 && currentValue) {
    modelOptions.push({
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select',
      currentValue,
      options: tiers.map((tier) => ({ value: tier, name: providers.claude.formatClaudeEffortLevelLabel(tier) })),
    });
    // Same option the curated catalog builds, from one owner.
    if (tiers.includes('xhigh')) modelOptions.push(buildClaudeUltracodeModelOption());
  }

  return {
    ...(typeof entry.maxInputTokens === 'number' ? { contextWindowTokens: entry.maxInputTokens } : {}),
    ...(modelOptions.length > 0 ? { modelOptions } : {}),
  };
}

/**
 * Build a full descriptor for a discovered (non-static) Claude model.
 *
 * `name` comes from the API `display_name` (falling back to the id); `description` is left
 * undefined — the API carries none, and the field is optional/cosmetic. Add the model to
 * `CLAUDE_STATIC_MODELS` later to give it a curated blurb and ordering.
 */
export function buildDiscoveredClaudeModelDescriptor(entry: AnthropicModelEntry): AgentModelDescriptor {
  const name = providers.claude.normalizeClaudeModelDisplayName(entry.displayName, entry.id);
  const derived = deriveClaudeModelOptionsFromCapabilities(entry);
  return {
    id: entry.id,
    name,
    ...(derived.contextWindowTokens !== undefined ? { contextWindowTokens: derived.contextWindowTokens } : {}),
    ...(derived.modelOptions ? { modelOptions: derived.modelOptions } : {}),
  };
}
