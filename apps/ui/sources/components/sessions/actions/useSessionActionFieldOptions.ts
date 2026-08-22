import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useStableValueBySignature } from '@/components/sessions/transcript/items/stableValueBySignature';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { useSessionHasActionDrafts } from '@/sync/store/hooks';
import { t } from '@/text';

import {
    buildSessionActionFieldOptionLists,
    buildSessionActionFieldOptionsHeightSignature,
    buildSessionActionFieldOptionsResolver,
    type ResolveSessionActionFieldOptions,
} from './sessionActionFieldOptions';

function resolveAgentLabel(agentId: string): string {
    // An Agent with no bundled core has no translated display name. The id is
    // this surface's own convention for an unlabelled backend, and it is what
    // the option list already falls back to for a backend with no entry title.
    const core = getAgentCore(agentId as AgentId);
    return core ? t(core.displayNameKey) : agentId;
}

/** The card's resolver: the full paint, including the snapshot-derived `disabled` flags. */
export function useSessionActionFieldOptions(
    sessionId: string,
    serverId?: string | null,
): ResolveSessionActionFieldOptions {
    const enabledAgentIds = useEnabledAgentIds();
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId, serverId);
    return React.useMemo(
        () => buildSessionActionFieldOptionsResolver(buildSessionActionFieldOptionLists({
            enabledAgentIds,
            executionRunsBackends,
            resolveAgentLabel,
        })),
        [enabledAgentIds, executionRunsBackends],
    );
}

/**
 * The transcript's resolver — the NARROWEST derived value that answers "what option rows does this
 * draft row paint".
 *
 * `useTranscriptItemsPipeline` produces the size key for EVERY row, so whatever this hook subscribes
 * to is a cost the whole transcript pays. Three things keep that cost where it belongs:
 *
 *  1. **It is inert with no draft row.** `useSessionHasActionDrafts` is a boolean store selector, and
 *     it gates both the session/machine subscription and the capabilities detect RPC inside
 *     `useExecutionRunsBackendsForSession`. A transcript with no `action-draft` item pays one boolean
 *     selector and nothing else.
 *  2. **Its result identity moves only when a painted option row does.** The resolved lists are
 *     compared by `buildSessionActionFieldOptionsHeightSignature`, which projects `value` and `label`
 *     and nothing else, so a capabilities snapshot that only flips availability re-renders this hook
 *     and stops there — `buildRowShellSignature` keeps its identity, and not one row's size version
 *     is re-derived. That signature is the SOLE owner of the height-bearing/not distinction (V-3).
 *  3. **The resolver is built from the stabilised lists themselves**, so there is no stale closure:
 *     what it returns is exactly what the signature was computed from — and, by the same token, a
 *     field the signature does not project (`disabled`) may be one snapshot stale here. Only
 *     `resolveSessionActionDraftHeightBearingPaint` consumes these lists, and it reads `label`.
 *
 * Unlike remote-dev's counterpart this DOES take the machine-capabilities snapshot, and it has to:
 * `buildAvailableReviewEngineOptions` in this repo adds one option per machine-reported review-capable
 * backend that is not already an enabled agent, and prefers the snapshot's own title as the label. A
 * capabilities RPC resolving therefore adds, removes or renames a whole `HappierSelect` row — with the
 * row potentially offscreen, where there is no `onLayout` and the reconciler's floor is monotonic
 * within one `structuralKey`.
 */
export function useSessionActionFieldOptionsForRowHeight(
    sessionId: string,
): ResolveSessionActionFieldOptions {
    const hasActionDrafts = useSessionHasActionDrafts(sessionId);
    const enabledAgentIds = useEnabledAgentIds();
    const serverId = usePreferredServerIdForSession(sessionId, null, hasActionDrafts);
    const executionRunsBackends = useExecutionRunsBackendsForSession(sessionId, serverId, hasActionDrafts);

    const lists = buildSessionActionFieldOptionLists({
        enabledAgentIds,
        executionRunsBackends,
        resolveAgentLabel,
    });
    const stableLists = useStableValueBySignature(
        lists,
        buildSessionActionFieldOptionsHeightSignature(lists),
    );
    return React.useMemo(() => buildSessionActionFieldOptionsResolver(stableLists), [stableLists]);
}
