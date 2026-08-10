import { fromSubagentStatus } from '@happier-dev/protocol';

import { resolveSessionSubagentAdvancedRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentAdvancedRoute';
import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
import { resolveSessionSubagentPrimaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentPrimaryTitle';
import { resolveSessionSubagentSecondaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentSecondaryTitle';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import {
    AGENT_ACTIVITY_ROW_NO_ACTIONS,
    type AgentActivityRowActionId,
    type AgentActivityRowEntry,
} from '../agentActivityRowEntry';

/**
 * The one projection from a derived `SessionSubagent` to the row's presentation contract.
 *
 * It lives here, beside the row, and not in `sync/domains/**`, for a concrete reason: an entry's
 * action list depends on whether a *route* resolves (A9 — a control that leads nowhere must not
 * render), and routes are owned by `components/sessions/agents/navigation/**`. A sync domain that
 * imported those would invert the layering. When P4-C lands `deriveAgentActivityEntries`, its merge
 * model is structurally assignable to `AgentActivityRowEntry`, so this stays the subagent *source*
 * rather than becoming a second entry model.
 *
 * Both the roster and the subagent detail header go through it, which is what keeps one status
 * word, one meta line and one elapsed value across the two surfaces — the divergence that made the
 * same subagent read coloured in the row and grey in the detail card (A3).
 */

export type SessionSubagentEntryParams = Readonly<{
    subagent: SessionSubagent;
    /** Latest sidechain line, when one has been derived. Becomes the row's single meta detail. */
    activityPreview?: string | null;
    /**
     * When this agent was last OBSERVED doing something, from
     * `deriveSessionSubagentLastActivityAtMs`. Absent means the host has not observed it, and the
     * quiet/stale notes then make no claim.
     *
     * Deliberately not `subagent.timestamps.updatedAtMs`: for a live sidechain subagent that field
     * is the launching tool message's `createdAt` and never advances, so it would mark every
     * healthy long-running agent stale at ten minutes.
     */
    lastActivityAtMs?: number | null;
    /** A permission prompt is waiting on a person, which is a status, not a badge. */
    hasPendingPermission?: boolean;
    /**
     * Overflow actions, already filtered by capability and route availability. Defaults to none, so
     * a surface that offers no actions cannot accidentally render an empty menu.
     */
    actions?: readonly AgentActivityRowActionId[];
}>;

export function resolveAgentActivityEntryFromSubagent(
    params: SessionSubagentEntryParams,
): AgentActivityRowEntry {
    const { subagent } = params;
    const timestamps = subagent.timestamps;

    return {
        id: subagent.id,
        status: resolveSubagentEntryStatus(params),
        title: resolveSessionSubagentPrimaryTitle(subagent),
        // The live line when there is one, otherwise the agent's identity. Never both: the row has
        // one meta line, and "what it is doing" outranks "what it is" whenever it is doing
        // something.
        metaDetail: normalizeMetaDetail(params.activityPreview)
            ?? resolveSessionSubagentSecondaryTitle(subagent),
        startedAtMs: timestamps.startedAtMs ?? null,
        updatedAtMs: params.lastActivityAtMs ?? null,
        endedAtMs: timestamps.finishedAtMs ?? null,
        actions: params.actions ?? AGENT_ACTIVITY_ROW_NO_ACTIONS,
    };
}

/**
 * A pending permission is rendered as `waiting`, the one status that escalates, rather than as a
 * separate pill beside the status (the old row shipped both, in two different colour languages).
 *
 * It only overrides a live agent: a finished agent whose last permission prompt was never resolved
 * is not waiting on anybody, and painting it as attention would send a person to a row they cannot
 * act on.
 */
function resolveSubagentEntryStatus(params: SessionSubagentEntryParams): AgentActivityRowEntry['status'] {
    const status = fromSubagentStatus(params.subagent.status);
    return params.hasPendingPermission === true && status === 'running' ? 'waiting' : status;
}

function normalizeMetaDetail(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Which overflow actions a roster row may offer, in menu order.
 *
 * Every entry is gated on the capability AND on the thing it needs to work: `open_full` and
 * `open_advanced` require their route to resolve, `stop` requires a run id, `delete` requires a
 * teammate recipient. That is A9 — the old row rendered "open full" unconditionally while the pane
 * returned early on a null route, so the control existed and did nothing.
 *
 * Destructive actions come last, and the two of them are distinct: `delete` shuts down one
 * teammate, `delete_team` shuts down the whole team. The team action replaces the group header the
 * unified list removes; without it, `agent_team_delete` would keep its protocol command, its
 * message card and its team-hint parsing, and lose its only way in.
 */
export function resolveSessionSubagentRowActions(params: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>): readonly AgentActivityRowActionId[] {
    const { subagent } = params;
    const actions: AgentActivityRowActionId[] = [];

    if (resolveSessionSubagentFullRoute(params) !== null) actions.push('open_full');
    if (subagent.capabilities.canOpenAdvancedRun && resolveSessionSubagentAdvancedRoute(params) !== null) {
        actions.push('open_advanced');
    }
    if (subagent.capabilities.canSend) actions.push('send');
    if (subagent.capabilities.canStop && (subagent.runRef?.runId?.trim() ?? '').length > 0) {
        actions.push('stop');
    }
    if (subagent.capabilities.canDelete && subagent.recipient?.kind === 'agent_team_member') {
        actions.push('delete');
    }
    if (resolveSessionSubagentTeamId(subagent) !== null) actions.push('delete_team');

    return actions.length > 0 ? actions : AGENT_ACTIVITY_ROW_NO_ACTIONS;
}

/**
 * The team a running teammate belongs to, or `null`.
 *
 * Mirrors the rule the deleted group header used (`agent_team_member` + running + a group key), so
 * team deletion stays available exactly where it was available before and nowhere it was not.
 */
export function resolveSessionSubagentTeamId(subagent: SessionSubagent): string | null {
    if (subagent.kind !== 'agent_team_member') return null;
    if (!subagent.capabilities.canDelete) return null;
    return subagent.display.groupKey?.trim() || null;
}
