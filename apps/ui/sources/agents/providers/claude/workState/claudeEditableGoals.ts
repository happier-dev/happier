import { isClaudeSlashCommandSupported } from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readClaudeGoalWorkStateItem(metadata: unknown): Record<string, unknown> | null {
    const snapshot = asRecord(asRecord(metadata)?.sessionWorkStateV1);
    if (!snapshot || snapshot.v !== 1) return null;
    if (!Array.isArray(snapshot.items)) return null;
    for (const item of snapshot.items) {
        const record = asRecord(item);
        if (record?.kind === 'goal') return record;
    }
    return null;
}

type ClaudeGoalSession = Readonly<{
    active?: boolean;
    metadata?: unknown;
}>;

/**
 * Capability-driven goal-edit gate for Claude (mirrors the provider-derived approach used for
 * Codex). The Claude work-state source publishes a `kind:'goal'` item carrying
 * `goalCapabilities.canEdit` once it observes native `goal_status`/`/goal` support, so the gate
 * reads that capability rather than branching on `agentId`.
 *
 * NOTE: This signal only exists once a goal item has been derived from a native `goal_status`
 * attachment. It is NOT sufficient on its own to decide whether a session can SET its first goal —
 * see `claudeGoalCommandSupported` for the session-level capability that drives the chip entry point.
 */
export function claudeGoalEditCapabilityPresent(metadata: unknown): boolean {
    const goal = readClaudeGoalWorkStateItem(metadata);
    if (!goal) return false;
    const capabilities = asRecord(goal.goalCapabilities);
    return capabilities?.canEdit === true;
}

/**
 * Session-level `/goal` capability for Claude, derived from the runtime-published
 * `metadata.slashCommands` list (Claude system-init `slash_commands`, published to session metadata
 * on every Claude launcher path: SDK probe + unified-terminal `onCapabilities`). This is the signal
 * that lets the goal chip surface so a user can SET their first goal — independent of any existing
 * goal item (which only appears after a native `goal_status` attachment, never emitted on the
 * agent-SDK path). Mirrors how the Codex gate derives editability from runtime identity rather than
 * from an already-present goal. Fail-closed: absent/unknown commands → false.
 */
export function claudeGoalCommandSupported(metadata: unknown): boolean {
    // `goal`/`/goal` shape parity is owned by the shared protocol helper (fail-closed on a
    // missing/non-array list), so the CLI source gate and this UI gate cannot drift.
    return isClaudeSlashCommandSupported(asRecord(metadata)?.slashCommands, 'goal');
}

export function claudeSupportsEditableGoals(ctx: Readonly<{
    agentId: string;
    session: ClaudeGoalSession;
}>): boolean {
    const profile = claudeGoalActionCapabilityProfile(ctx);
    return profile?.canEdit === true || profile?.canClear === true;
}

/**
 * Claude's effective goal-action profile (edit + clear only; no pause/resume/complete, no token
 * budget). This provider-owned profile describes Claude semantics only. The generic registry
 * intersects it with the execution capabilities published by the active runner or target daemon.
 */
export function claudeGoalActionCapabilityProfile(ctx: Readonly<{
    agentId: string;
    session: ClaudeGoalSession;
}>): Readonly<{ canEdit: boolean; canStop: boolean; canClear: boolean; canConfigureBudget: boolean }> | null {
    if (ctx.agentId !== 'claude') return null;
    const metadata = ctx.session.metadata ?? null;
    const goal = readClaudeGoalWorkStateItem(metadata);
    const goalCapabilities = asRecord(goal?.goalCapabilities);
    const itemCanEdit = goalCapabilities?.canEdit === true;
    const itemCanClear = goalCapabilities?.canClear === true || itemCanEdit;
    const commandSupported = ctx.session.active === true && claudeGoalCommandSupported(metadata);
    const semanticCanEdit = itemCanEdit || commandSupported;
    const semanticCanClear = itemCanClear || commandSupported;
    if (!semanticCanEdit && !semanticCanClear) return null;

    return {
        canEdit: semanticCanEdit,
        canStop: false,
        canClear: semanticCanClear,
        canConfigureBudget: false,
    };
}
