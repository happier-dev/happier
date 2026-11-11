/** The shared model descriptor's `costTier` vocabulary. */
export type CodexModelCostTier = 'low' | 'standard' | 'premium';

/**
 * Codex-owned cost tiers by model family, so a new version (e.g. gpt-7-luna)
 * inherits its family's tier. Low is Codex's cheap and fast tier.
 * Evidence: the vendor model list descriptions — Luna "fast and affordable",
 * gpt-reserve "fast and affordable", Terra "balanced model for straightforward
 * work", Sol "workhorse", Astra "frontier intelligence for the most demanding work".
 */
const CODEX_MODEL_FAMILY_COST_TIERS: readonly Readonly<{ match: (id: string) => boolean; costTier: CodexModelCostTier }>[] = [
    { match: id => id.endsWith('-luna'), costTier: 'low' },
    { match: id => id === 'gpt-reserve', costTier: 'low' },
    { match: id => id.endsWith('-mini'), costTier: 'low' },
    { match: id => id.endsWith('-terra'), costTier: 'standard' },
    { match: id => id.endsWith('-sol'), costTier: 'standard' },
    { match: id => id.endsWith('-astra'), costTier: 'premium' },
];

const COST_TIERS: ReadonlySet<string> = new Set<CodexModelCostTier>(['low', 'standard', 'premium']);

/** A vendor-reported tier wins; otherwise the family table; unknown ids stay untiered. */
export function resolveCodexModelCostTier(modelId: string, vendorTier?: unknown): CodexModelCostTier | undefined {
    if (typeof vendorTier === 'string' && COST_TIERS.has(vendorTier)) return vendorTier as CodexModelCostTier;
    const id = modelId.trim().toLowerCase();
    return CODEX_MODEL_FAMILY_COST_TIERS.find(rule => rule.match(id))?.costTier;
}
