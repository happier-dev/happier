import * as React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    deriveSessionSubagentActivityPreview,
    deriveSessionSubagentLastActivityAtMs,
} from '@/sync/domains/session/subagents/deriveSessionSubagentActivityPreview';
import { deriveSessionSubagentPendingPermissionIds } from '@/sync/domains/session/subagents/deriveSessionSubagentPendingPermissions';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import { useSessionMessagesReducerSnapshot, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useEnsureSidechainsLoaded, type SidechainHydrationStatus } from './useEnsureSidechainsLoaded';

/**
 * The transcript detail a roster row shows, for a roster that has already been derived.
 *
 * It is a separate hook from the merge, and the separation is a performance contract rather than
 * tidiness: everything here is keyed on `reducerVersion`, which bumps on every streamed commit. A
 * surface that only needs "how many agents are working" — the composer badge, the session-list row,
 * the header count — must not re-render per token to learn that (R-11), so it consumes the merge
 * without this and pays nothing.
 *
 * It also owns the sidechain hydration the previews depend on, because that decision needs the
 * roster: you cannot know which sidechains are worth fetching until you know which agents exist.
 * Keeping it here is what lets the merge hook derive the roster exactly once — a host that computed
 * enrichment outside would need the roster first and hand it back in, which cannot be expressed in
 * one render pass without either a stale frame or a second derivation of the whole roster.
 */

export type SessionAgentActivityEnrichment = Readonly<{
    activityPreviewById?: ReadonlyMap<string, string> | null;
    lastActivityAtMsById?: ReadonlyMap<string, number> | null;
    pendingPermissionIds?: ReadonlySet<string> | null;
}>;

export const NO_SESSION_AGENT_ACTIVITY_ENRICHMENT: SessionAgentActivityEnrichment = Object.freeze({});

/**
 * The sidechains worth hydrating for a preview: running agents first, bounded by the user's
 * collapsed-preview setting. Hydration is a network cost per sidechain, so it follows the budget the
 * transcript already uses rather than the roster's length.
 */
function deriveRosterPreviewSidechainIds(params: Readonly<{
    subagents: readonly SessionSubagent[];
    previewLimit: number;
}>): readonly string[] {
    const limit = Math.max(0, Math.floor(params.previewLimit));
    if (limit <= 0) return [];

    const sidechainIds: string[] = [];
    const seen = new Set<string>();
    for (const pass of [true, false]) {
        for (const subagent of params.subagents) {
            if ((subagent.status === 'running') !== pass) continue;
            const sidechainId = subagent.transcript.sidechainId?.trim();
            if (!sidechainId || seen.has(sidechainId)) continue;
            seen.add(sidechainId);
            sidechainIds.push(sidechainId);
            if (sidechainIds.length >= limit) return sidechainIds;
        }
    }
    return sidechainIds;
}

function resolvePreviewFallback(status: SidechainHydrationStatus | undefined): string | null {
    if (status === 'loaded') return null;
    if (status === 'error' || status === 'not_ready') return t('common.unavailable');
    return t('common.loading');
}

export function useSessionAgentActivityEnrichment(params: Readonly<{
    sessionId: string;
    subagents: readonly SessionSubagent[];
    /** The subagent-source projection the roster was derived from, not the full transcript (P-2). */
    messages: readonly Message[];
}>): SessionAgentActivityEnrichment {
    const { messages, sessionId, subagents } = params;
    const { reducerState, reducerVersion } = useSessionMessagesReducerSnapshot(sessionId);
    const collapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');

    const previewSidechainIds = React.useMemo(() => deriveRosterPreviewSidechainIds({
        subagents,
        previewLimit: resolveTranscriptToolCallsCollapsedPreviewCount(collapsedPreviewCountSetting),
    }), [collapsedPreviewCountSetting, subagents]);
    const previewSidechainIdSet = React.useMemo(() => new Set(previewSidechainIds), [previewSidechainIds]);
    const sidechainHydrationStatus = useEnsureSidechainsLoaded({
        enabled: previewSidechainIds.length > 0,
        sessionId,
        sidechainIds: previewSidechainIds,
    });

    const activityPreviewById = React.useMemo(() => {
        const previews = new Map<string, string>();
        for (const subagent of subagents) {
            const preview = deriveSessionSubagentActivityPreview({ subagent, reducerState });
            if (preview) {
                previews.set(subagent.id, preview);
                continue;
            }
            const sidechainId = subagent.transcript.sidechainId?.trim();
            if (!sidechainId || !previewSidechainIdSet.has(sidechainId)) continue;
            const fallback = resolvePreviewFallback(sidechainHydrationStatus.bySidechainId[sidechainId]?.status);
            if (!fallback) continue;
            previews.set(subagent.id, fallback);
        }
        return previews;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reducerState is mutated in place; reducerVersion is its only change signal (D-4)
    }, [previewSidechainIdSet, reducerState, reducerVersion, sidechainHydrationStatus.bySidechainId, subagents]);

    // The last moment each agent was OBSERVED doing something, which is what the quiet/stale notes
    // are allowed to reason about (4.10). An agent whose sidechain has not been hydrated is absent
    // from this map, and nothing is then claimed about its silence.
    const lastActivityAtMsById = React.useMemo(() => {
        const observed = new Map<string, number>();
        for (const subagent of subagents) {
            const atMs = deriveSessionSubagentLastActivityAtMs({ subagent, reducerState });
            if (atMs != null) observed.set(subagent.id, atMs);
        }
        return observed;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [reducerState, reducerVersion, subagents]);

    // P-4: one shared pass for the whole roster. The old shape asked the same question per subagent
    // and each answer walked the transcript from the top.
    const pendingPermissionIds = React.useMemo(
        () => deriveSessionSubagentPendingPermissionIds({ subagents, reducerState, messages }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
        [messages, reducerState, reducerVersion, subagents],
    );

    return React.useMemo(
        () => ({ activityPreviewById, lastActivityAtMsById, pendingPermissionIds }),
        [activityPreviewById, lastActivityAtMsById, pendingPermissionIds],
    );
}
