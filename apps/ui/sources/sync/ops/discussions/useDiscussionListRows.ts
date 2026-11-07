import * as React from 'react';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { buildDiscussionListAttention, type DiscussionListRow } from '@/activity/attention/buildDiscussionListAttention';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage, useDiscussionApprovalAttentionEntries, useArtifactsLoaded } from '@/sync/domains/state/storage';
import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';

const NO_ARTIFACT_KINDS: readonly string[] = Object.freeze([]);

/**
 * Demand only on an open Discussion list; no per-row reads. A request's Discussion is a header list
 * fact (set by the writer, verified against the body when read), so the list opens no approval body.
 */
export function useDiscussionListRows(scope: ServerAccountScope, items: readonly DiscussionOpenedSummaryV1[]): readonly DiscussionListRow[] {
    const approvalEntries = useDiscussionApprovalAttentionEntries(React.useMemo(() => items.map(item => item.id), [items]));
    const profilesGeneration = useServerProfilesGeneration();
    // Attention consumes the Inbox's open membership, not settled approval history.
    const artifactsLoaded = useArtifactsLoaded('inboxOpen');
    const artifactScope = storage(state => state.profileScope);
    const activeScope = areServerAccountScopesEqual(scope, artifactScope);
    useArtifactInventoryRead(activeScope && !artifactsLoaded, activeScope ? 'inboxOpen' : NO_ARTIFACT_KINDS);
    const previous = React.useRef<readonly DiscussionListRow[]>([]);
    return React.useMemo(() => {
        const rows = buildDiscussionListAttention({ scope, artifactScope, artifactsLoaded, approvalEntries, items }, previous.current);
        previous.current = rows;
        return rows;
    }, [scope.serverId, scope.accountId, artifactScope, artifactsLoaded, approvalEntries, items, profilesGeneration]);
}
