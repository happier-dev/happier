import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

/**
 * The ONE answer to "can this row be opened, and to what".
 *
 * Before this there were three, and they disagreed by construction: the roster hook decided
 * pressability from a route, the shared surface decided what a press did from
 * `readSubagentForEntry`, and each host decided the destination again on the way out. Every dead
 * control this program has shipped lived in the gap between two of those answers — a row announced
 * as a button over a handler that returned silently (A9), and its equal and opposite twin, a row
 * that genuinely resolved a destination and was drawn read-only.
 *
 * It is a pure function over an entry and the local subagent behind it, so every caller — the
 * roster's `canOpen`, the surface's press, the preview's "open details" — asks the same question
 * and cannot get a different answer. Nothing here navigates: WHERE a target is opened stays with
 * the host (a phone pushes the route, a pane upgrades it to a details tab), because that is a real
 * difference between devices and not a second opinion about whether a destination exists.
 *
 * Two target kinds, and the difference between them is not decoration:
 *
 * - `subagent` — a locally derived unit of work with an owning tool message or an execution run
 *   behind it. It has a ROUTE, so it is navigable, and its destination is the existing
 *   `SessionSubagentDetailsView` surface reached through `resolveSessionSubagentFullRoute`. Reused,
 *   never re-implemented: the route rules (route id first, run id second) have one owner.
 * - `sidechain` — a workflow agent whose transcript was imported this wave (W23-IMPORT). The
 *   reducer stores an orphan sidechain and keys it by id (V-1), and `useEnsureSidechainsLoaded`
 *   already fetches by id (V-2), so it can be INSPECTED in place. It has no owning tool message,
 *   so `resolveSessionSubagentFullRoute` cannot resolve it and no route may be claimed for it —
 *   which is why navigability is a property of the target rather than of the caller's optimism.
 *   It does now have a DESTINATION — a scoped transcript details tab — but a destination is not a
 *   route: a tab exists only where a pane scope does, so whether that affordance is drawn is a
 *   HOST declaration (`AgentActivitySurface.onOpenSidechainTranscript`), asked separately from the
 *   route question below. Two questions, because the two answers genuinely differ per host.
 *
 * A background command deliberately resolves NOTHING here. It is a headless process with no
 * transcript and no route; its detail is disclosed in place from its durable record by its own
 * accessor. "Has a detail to show" and "can be opened" are different questions, and answering the
 * second one for it would be the fabrication `BackgroundTaskDetail` exists to refuse.
 */

/**
 * The fields of a merged activity entry this question actually reads.
 *
 * Structurally satisfied by `SessionAgentActivityRow` with no adapter, and deliberately narrower:
 * a resolver that could read status or timestamps would eventually start deciding openability from
 * them, and "finished" has never been a reason a transcript cannot be read.
 */
export type AgentActivityOpenTargetEntry = Readonly<{
    id: string;
    kind?: string;
    title?: string;
    runId?: string | null;
    sidechainId?: string | null;
    subagentId?: string | null;
}>;

export type AgentActivityOpenTarget =
    | Readonly<{
        kind: 'subagent';
        entryId: string;
        title: string;
        /** The local unit of work, handed to the host so it does not look it up a second time. */
        subagent: SessionSubagent;
        /** The full-screen route, which exists on EVERY device including a phone. */
        route: string;
        /** Its sidechain, when it has one — the preview's demand-load key. */
        sidechainId: string | null;
    }>
    | Readonly<{
        kind: 'sidechain';
        entryId: string;
        title: string;
        sidechainId: string;
    }>;

export function resolveAgentActivityOpenTarget(params: Readonly<{
    sessionId: string;
    entry: AgentActivityOpenTargetEntry;
    subagent: SessionSubagent | null;
}>): AgentActivityOpenTarget | null {
    const sessionId = params.sessionId.trim();
    if (!sessionId) return null;

    const { entry, subagent } = params;
    const title = entry.title?.trim() ?? '';

    if (subagent) {
        // The full route rather than `capabilities.canOpen`: it is the target that exists on every
        // device, and every deriver that sets that capability also carries the transcript id or run
        // id this route is built from. Asking the narrower question would advertise a press only
        // one device could serve.
        const route = resolveSessionSubagentFullRoute({ sessionId, subagent });
        if (route) {
            return {
                kind: 'subagent',
                entryId: entry.id,
                title,
                subagent,
                route,
                sidechainId: normalizeId(subagent.transcript.sidechainId ?? entry.sidechainId),
            };
        }
        // A local subagent with no route falls through rather than borrowing the sidechain branch:
        // a completion-only native subagent has neither, and a subagent WITH a sidechain always has
        // the tool message that opened it, so this fall-through resolves nothing in practice and
        // must not invent a second, poorer destination if that ever stops being true.
        return null;
    }

    const sidechainId = normalizeId(entry.sidechainId);
    if (sidechainId) {
        return { kind: 'sidechain', entryId: entry.id, title, sidechainId };
    }

    return null;
}

/**
 * Whether this target has a full-screen ROUTE — somewhere every device can navigate to.
 *
 * It is the question the ROW PRESS asks (`useSessionAgentActivity` sets `canOpen` from it), and it
 * must stay the route question: a row press is host-independent, drawn identically in the pane and
 * in the compact popover, so answering `true` for a destination only one of them can reach would
 * ship a dead control on the other. A sidechain target is inspectable in place and openable in a
 * details pane, and neither of those is a route — which is why it answers `false` here while the
 * surface still offers "open details" wherever its host declared it can host one.
 *
 * A caller that checked `target != null` before pushing a route would ship the fourth dead control.
 */
export function isNavigableAgentActivityOpenTarget(
    target: AgentActivityOpenTarget | null,
): target is Extract<AgentActivityOpenTarget, { kind: 'subagent' }> {
    return target?.kind === 'subagent';
}

function normalizeId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}
