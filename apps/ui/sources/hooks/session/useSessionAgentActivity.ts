import * as React from 'react';

import {
    readSessionAgentActivityHeadlineFromMetadata,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import {
    AGENT_ACTIVITY_ROW_NO_ACTIONS,
    type AgentActivityRowActionId,
} from '@/components/sessions/agentActivity/agentActivityRowEntry';
import {
    resolveAgentActivityEntryFromSubagent,
    resolveSessionSubagentRowActions,
} from '@/components/sessions/agentActivity/entry/fromSubagent';
import {
    isNavigableAgentActivityOpenTarget,
    resolveAgentActivityOpenTarget,
} from '@/components/sessions/agentActivity/open/resolveAgentActivityOpenTarget';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { readSessionWorkflowActivityHeadlineFromMetadata } from '@/components/sessions/workState/sessionWorkflowActivityPresentation';
import {
    deriveAgentActivityCounts,
    deriveAgentActivityEntries,
    deriveBackgroundTaskActivityEntries,
    toAgentActivityCountable,
    toLocalAgentActivityEntry,
    type AgentActivityCounts,
    type AgentActivityEntry,
    type AgentActivityMergeResult,
} from '@/sync/domains/session/agentActivity';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { t } from '@/text';
import { useSession, useSessionSubagentSourceMessages } from '@/sync/domains/state/storage';

import { useReconciledStableRows } from './reconcileStableRows';
import {
    NO_SESSION_AGENT_ACTIVITY_ENRICHMENT,
    useSessionAgentActivityEnrichment,
    type SessionAgentActivityEnrichment,
} from './useSessionAgentActivityEnrichment';
import {
    useSessionBackgroundTaskActivity,
    useSessionBackgroundTaskRowResolver,
    type SessionBackgroundTaskActivity,
    type SessionBackgroundTaskRow,
} from './useSessionBackgroundTaskActivity';
import { useSessionSubagents } from './useSessionSubagents';

/**
 * A session's agent work, as every surface reads it.
 *
 * It joins the two things that know about agent work, neither of which knows everything:
 *
 * - the **headline** the CLI publishes into session metadata, which arrives with the session and is
 *   therefore complete on a cold open however little transcript has paged in (R-3);
 * - **local derivation** from the transcript, the only source with detail — the live activity line,
 *   the sidechain, permission state, the terminal instant — and the only source at all for a backend
 *   that publishes no headline (the publisher is composed for Claude only, so a Codex, Gemini or
 *   OpenCode session takes the §5.2 degrade path as a matter of course, not as an edge case).
 *
 * **Two entry points, one merge.** `useSessionAgentActivity` is the narrow one: the subagent-source
 * projection plus the headline, and no subscription that ticks per streamed token. The roster
 * variant below adds transcript detail, which is keyed on `reducerVersion` and therefore re-renders
 * on every commit — a cost the Agents pane is happy to pay for a live preview and the composer badge
 * must not pay to learn a number (R-11). Everything downstream of that difference — the merge, the
 * entry model, the action set, the counts, the referential stability — is shared, so the two cannot
 * disagree about what exists.
 */

export type { SessionAgentActivityEnrichment } from './useSessionAgentActivityEnrichment';
export type { SessionBackgroundTaskRow } from './useSessionBackgroundTaskActivity';

/** A merged entry, ready for the row: everything the merge knows plus the host's action set. */
export type SessionAgentActivityRow = AgentActivityEntry & Readonly<{
    actions: readonly AgentActivityRowActionId[];
    /** Resolved here, beside `actions`, because both answer the same question: is there a target? */
    canOpen: boolean;
}>;

export type SessionAgentActivityState = Readonly<{
    /**
     * Everything the merge produced, groupings included, in merge order.
     *
     * This is the ONE list. A host that draws runs as panels partitions it through
     * `partitionAgentActivityRuns`, and a host that only needs a number reads `counts`; neither
     * gets a pre-filtered second roster from here, because two roster-shaped fields on one state
     * object is how a reader ends up asking the wrong one what exists.
     */
    entries: readonly SessionAgentActivityRow[];
    counts: AgentActivityCounts;
    /** Which headline fed the merge. `none` is the non-Claude and old-CLI path. */
    headlineSource: AgentActivityMergeResult['headlineSource'];
    /** The locally derived roster, for hosts that need the subagent behind a row. */
    subagents: readonly SessionSubagent[];
    /** The subagent behind an entry id, or `null` for a headline-only entry. */
    readSubagentForEntry: (entryId: string) => SessionSubagent | null;
    /**
     * The durable record and launching `Bash` card behind a background-task row, or `null`.
     *
     * A background command is not a subagent, so it resolves through its own accessor rather than
     * being squeezed into `readSubagentForEntry` and returning something that is not one.
     */
    readBackgroundTaskForEntry: (entryId: string) => SessionBackgroundTaskRow | null;
}>;

function readEntryKey(entry: SessionAgentActivityRow): string {
    return entry.id;
}

export function useSessionAgentActivity(params: Readonly<{
    sessionId: string;
    /**
     * Forwarded to `useSessionSubagents`, which uses it only to decide whether execution runs are
     * CONTROLLABLE. A count-only host passes a stub rather than letting a second sub-second
     * direct-session poll attach per session.
     */
    directSessionRuntime?: UseDirectSessionRuntimeResult;
}>): SessionAgentActivityState {
    const session = useSession(params.sessionId);
    // P-2: the subagent-source projection, not the full transcript. It is LRU-cached on
    // `subagentSourceVersion`, so a token streaming into an unrelated message does not re-derive it.
    const messages = useSessionSubagentSourceMessages(params.sessionId);
    const { subagents } = useSessionSubagents({
        sessionId: params.sessionId,
        session,
        messages,
        ...(params.directSessionRuntime ? { directSessionRuntime: params.directSessionRuntime } : {}),
    });

    // Background commands are counted here too, and that is what makes ONE count source real: the
    // Agents tab badge reads this variant while the roster one component below it reads the other,
    // and a running background command used to appear in the roster's WORKING header and not in the
    // badge above it. This is not the R-11 cost the two variants exist to separate — that is the
    // transcript enrichment, keyed on `reducerVersion`. These records are keyed on the session's
    // runtime-activity revision: one request per transition, and none at all for a session that has
    // never run background work.
    const backgroundTasks = useSessionBackgroundTaskActivity({
        sessionId: params.sessionId,
        activityRevision: session?.runtimeActivityRevision ?? null,
        hasEverBeenActive: (session?.runtimeActivityRevision ?? 0) > 0,
    });

    return useMergedSessionAgentActivity({
        sessionId: params.sessionId,
        metadata: session?.metadata,
        subagents,
        messages,
        enrichment: NO_SESSION_AGENT_ACTIVITY_ENRICHMENT,
        backgroundTasks,
    });
}

/**
 * The same activity, with the transcript detail a rendered roster shows: the live activity line, the
 * observed-activity instant the quiet/stale notes read, and pending permission prompts.
 *
 * It derives the roster ONCE and then enriches it, which is why enrichment lives inside rather than
 * being handed in: the enrichment needs the roster (you cannot know which sidechains to hydrate
 * before you know which agents exist) and the merge needs the enrichment, and a host that computed
 * it in between would have to either derive the whole roster twice or render one frame stale.
 */
export function useSessionAgentActivityRoster(params: Readonly<{
    sessionId: string;
    directSessionRuntime?: UseDirectSessionRuntimeResult;
}>): SessionAgentActivityState {
    const session = useSession(params.sessionId);
    const messages = useSessionSubagentSourceMessages(params.sessionId);
    const { subagents } = useSessionSubagents({
        sessionId: params.sessionId,
        session,
        messages,
        ...(params.directSessionRuntime ? { directSessionRuntime: params.directSessionRuntime } : {}),
    });
    const enrichment = useSessionAgentActivityEnrichment({
        sessionId: params.sessionId,
        subagents,
        messages,
    });
    // The roster is the one surface that lists background commands, so it is the one surface that
    // reads their records. The session's runtime-activity revision is the live pointer: it advances
    // when a task starts or ends, so this refetches on a transition rather than on a clock.
    const backgroundTasks = useSessionBackgroundTaskActivity({
        sessionId: params.sessionId,
        activityRevision: session?.runtimeActivityRevision ?? null,
        hasEverBeenActive: (session?.runtimeActivityRevision ?? 0) > 0,
    });

    return useMergedSessionAgentActivity({
        sessionId: params.sessionId,
        metadata: session?.metadata,
        subagents,
        messages,
        enrichment,
        backgroundTasks,
    });
}

function useMergedSessionAgentActivity(params: Readonly<{
    sessionId: string;
    metadata: unknown;
    subagents: readonly SessionSubagent[];
    messages: readonly Message[];
    enrichment: SessionAgentActivityEnrichment;
    backgroundTasks: SessionBackgroundTaskActivity;
}>): SessionAgentActivityState {
    const { backgroundTasks, enrichment, messages, metadata, sessionId, subagents } = params;

    const headline = React.useMemo<SessionAgentActivityHeadlineV1 | null>(
        () => readSessionAgentActivityHeadlineFromMetadata(metadata),
        [metadata],
    );
    // Read only when the unified key is absent. Both headlines are projected from the same committed
    // run snapshots, so consuming both would list every run twice.
    const workflowHeadline = React.useMemo(
        () => (headline ? null : readSessionWorkflowActivityHeadlineFromMetadata(metadata)),
        [headline, metadata],
    );

    const merged = React.useMemo(() => {
        const local = subagents.map((subagent) => toLocalAgentActivityEntry({
            subagent,
            // The ONE projection of a subagent into presentation, borrowed rather than repeated: it
            // owns the title, the meta line, the permission-to-`waiting` rule and the raw
            // timestamps, and a second copy here is how two surfaces start disagreeing.
            projection: resolveAgentActivityEntryFromSubagent({
                subagent,
                activityPreview: enrichment.activityPreviewById?.get(subagent.id) ?? null,
                lastActivityAtMs: enrichment.lastActivityAtMsById?.get(subagent.id) ?? null,
                hasPendingPermission: enrichment.pendingPermissionIds?.has(subagent.id) ?? false,
            }),
        }));
        return deriveAgentActivityEntries({
            headline,
            workflowHeadline,
            // Background commands join the same list, at the end: they are the least agent-like
            // thing on it, and the section model re-orders by status anyway.
            local: [...local, ...deriveBackgroundTaskActivityEntries({
                records: backgroundTasks.records,
                // A command with no redacted label must not borrow the roster's "Unnamed agent":
                // it is a headless process, and calling it an agent is the one claim this kind
                // exists to stop making.
                fallbackTitle: t('session.agentActivity.backgroundTask.title'),
            })],
        });
    }, [
        backgroundTasks.records,
        enrichment.activityPreviewById,
        enrichment.lastActivityAtMsById,
        enrichment.pendingPermissionIds,
        headline,
        subagents,
        workflowHeadline,
    ]);

    const subagentById = React.useMemo(() => {
        const bySubagentId = new Map<string, SessionSubagent>();
        for (const subagent of subagents) bySubagentId.set(subagent.id, subagent);
        return bySubagentId;
    }, [subagents]);

    const derivedEntries = React.useMemo<readonly SessionAgentActivityRow[]>(() => (
        merged.entries.map((entry) => {
            const subagent = entry.subagentId ? subagentById.get(entry.subagentId) ?? null : null;
            return {
                ...entry,
                // A headline-only entry has no actions, because every action needs something local:
                // a route, a run id, a recipient. A control that leads nowhere must not render (A9).
                actions: subagent
                    ? resolveSessionSubagentRowActions({ sessionId, subagent })
                    : AGENT_ACTIVITY_ROW_NO_ACTIONS,
                // The same question for the row PRESS, which is the much larger target and was the
                // one left unguarded: every headline-only agent row and every terminal run row was
                // announced as a button over a handler that returned silently.
                //
                // Asked of `resolveAgentActivityOpenTarget`, which is the ONE place in the app that
                // answers it — the surface's press, the disclosed preview and its "open details"
                // read the same resolver, so the affordance and the destination cannot disagree.
                //
                // NAVIGABLE, not merely resolved: a workflow agent whose transcript was imported is
                // inspectable in place but has no owning tool message and therefore no screen, so
                // its press discloses instead of navigating. Answering `true` for it would be the
                // dead control this flag exists to prevent — in the opposite direction.
                canOpen: isNavigableAgentActivityOpenTarget(
                    resolveAgentActivityOpenTarget({ sessionId, entry, subagent }),
                ),
            };
        })
    ), [merged.entries, sessionId, subagentById]);
    // INV-4, applied once for the whole program: an unchanged unit of work gets its previous object
    // back, which is what makes `React.memo` on the row real.
    const entries = useReconciledStableRows(derivedEntries, readEntryKey);

    const counts = React.useMemo(
        () => deriveAgentActivityCounts(entries.map(toAgentActivityCountable)),
        [entries],
    );

    // Read through a ref so the resolver keeps ONE identity for the life of the host: a callback
    // that changed with the roster would re-render every memoized row whenever any one agent moved.
    const lookupRef = React.useRef<{
        entries: readonly SessionAgentActivityRow[];
        subagentById: ReadonlyMap<string, SessionSubagent>;
    }>({ entries, subagentById });
    lookupRef.current = { entries, subagentById };
    const readSubagentForEntry = React.useCallback((entryId: string): SessionSubagent | null => {
        const lookup = lookupRef.current;
        const entry = lookup.entries.find((candidate) => candidate.id === entryId);
        // Fall back to the raw id so a caller holding a local id (a route, a details tab) resolves
        // too — a merged entry is keyed by the headline's id, which that caller never saw.
        return lookup.subagentById.get(entry?.subagentId ?? entryId) ?? null;
    }, []);

    const readBackgroundTaskForEntry = useSessionBackgroundTaskRowResolver({
        activity: backgroundTasks,
        messages,
    });

    return React.useMemo(() => ({
        entries,
        counts,
        headlineSource: merged.headlineSource,
        subagents,
        readSubagentForEntry,
        readBackgroundTaskForEntry,
    }), [
        counts,
        entries,
        merged.headlineSource,
        readBackgroundTaskForEntry,
        readSubagentForEntry,
        subagents,
    ]);
}
