import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

/**
 * How the shared agent row is sized inside the two workflow hosts — decided once, for both.
 *
 * **Density is explicit, not inherited.** `useResolvedItemDensity` falls back to the user's
 * `uiItemDensity` setting, which is a preference about how much of a *list screen* fits at once. A
 * reader who likes roomy settings lists has said nothing about how tall an agent row inside a
 * transcript card should be, and letting the setting through would grow a six-agent card by half
 * again — the "flattening the workflow card" regression the migration exists to avoid.
 */
export const WORKFLOW_AGENT_ROW_DENSITY: ResolvedItemDensity = 'compact';

/**
 * The negative margin a host applies to its row container.
 *
 * An item row reserves its own horizontal padding, so a host that already pads its card would
 * otherwise indent every leading status glyph past the header above it. Cancelling the row's own
 * padding puts the glyph column back on the host's content edge and lets a press or hover fill run
 * to the card edge instead of stopping short of it.
 */
export const WORKFLOW_AGENT_ROW_BLEED_PX = -ITEM_ROW_PADDING_HORIZONTAL[WORKFLOW_AGENT_ROW_DENSITY];
