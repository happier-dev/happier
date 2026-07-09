import type { AgentId } from '@/agents/catalog/catalog';

/** Default cap for provider CLI logos shown inline on a machine row (incl. the overflow slot). */
export const MACHINE_CLI_MAX_VISIBLE_LOGOS = 4;

export type MachineCliLogoDisplay = Readonly<{
    /** Provider logos to render, in the original (enabled-agent / catalog) order. */
    visible: ReadonlyArray<AgentId>;
    /** Count folded into a trailing "+N" badge; 0 when everything fits. */
    overflow: number;
}>;

/**
 * Caps the inline row of available-CLI provider logos on a machine row.
 *
 * A machine can expose many CLIs; rendering every logo makes the row very wide (the
 * abbreviation soup this replaced). When there are more than `maxVisible`, the last slot
 * is reserved for a "+N" overflow count so the row never exceeds `maxVisible` items.
 * Order is preserved so the most relevant providers (front of the enabled-agent order)
 * stay visible.
 */
export function resolveMachineCliLogoDisplay(
    agentIds: ReadonlyArray<AgentId>,
    maxVisible: number = MACHINE_CLI_MAX_VISIBLE_LOGOS,
): MachineCliLogoDisplay {
    const cap = Math.max(1, Math.floor(maxVisible));
    if (agentIds.length <= cap) {
        return { visible: agentIds, overflow: 0 };
    }
    // Reserve the final slot for the "+N" badge so total rendered items === cap.
    const visibleCount = cap - 1;
    return {
        visible: agentIds.slice(0, visibleCount),
        overflow: agentIds.length - visibleCount,
    };
}
