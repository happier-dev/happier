import { AGENT_ACTIVITY_SURFACE_DENSITY } from '@/components/sessions/agentActivity/row/agentRowMetrics';
import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';

/**
 * How the shared agent row is sized inside the two workflow hosts — which is how it is sized
 * everywhere, because that is one decision and it has one owner.
 *
 * **Density is explicit, not inherited.** `useResolvedItemDensity` falls back to the user's
 * `uiItemDensity` setting, which is a preference about how much of a *list screen* fits at once. A
 * reader who likes roomy settings lists has said nothing about how tall an agent row inside a
 * transcript card should be, and letting the setting through would grow a six-agent card by half
 * again — the "flattening the workflow card" regression the migration exists to avoid.
 *
 * It is an alias rather than its own literal: this file and the agent-activity surface each pinned
 * `'compact'` independently, and two constants that happen to agree are one edit away from not.
 * The name stays because the bleed below is derived from it and reads as workflow geometry.
 */
export const WORKFLOW_AGENT_ROW_DENSITY = AGENT_ACTIVITY_SURFACE_DENSITY;

/**
 * The negative margin a host applies to its row container.
 *
 * An item row reserves its own horizontal padding, so a host that already pads its card would
 * otherwise indent every leading status glyph past the header above it. Cancelling the row's own
 * padding puts the glyph column back on the host's content edge and lets a press or hover fill run
 * to the card edge instead of stopping short of it.
 */
export const WORKFLOW_AGENT_ROW_BLEED_PX = -ITEM_ROW_PADDING_HORIZONTAL[WORKFLOW_AGENT_ROW_DENSITY];
