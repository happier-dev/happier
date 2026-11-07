import * as React from 'react';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readOpenWorkflowPublicationApprovalId } from '@/sync/domains/artifacts/approvalArtifacts';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useInboxArtifactBodyHydration } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';

export type WorkflowRunPublicationRequest = Readonly<{
    artifactId: string;
    href: ReturnType<typeof buildApprovalHref>;
}>;

const emptyArtifacts: readonly DecryptedArtifact[] = [];
const emptyArtifactRows: Readonly<Record<string, DecryptedArtifact>> = {};
const publicationSelection = { kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn, APPROVAL_ARTIFACT_KINDS_V1.targetAction], approvalStates: ['open'] as const };

/** Read-only navigation from the canonical approval inventory; no separate loader or lifecycle. */
export function useWorkflowRunPublicationRequests(input: Readonly<{
    scope: ServerAccountScope | null;
    runId: string;
    active: boolean;
}>): readonly WorkflowRunPublicationRequest[] {
    const { scope, runId, active } = input;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const { current, related, legacy } = getStorage()(useShallow(state => {
        const current = active && Boolean(runId) && Boolean(serverId) && Boolean(accountId) && state.isDataReady
            && areServerAccountScopesEqual(state.profileScope, scope);
        return { current,
            related: current ? state.artifactWorkflowPublicationArtifactsByRunId[runId] ?? emptyArtifactRows : emptyArtifactRows,
            legacy: current ? state.artifactUnclassifiedWorkflowPublicationArtifacts : emptyArtifactRows };
    }));
    const artifacts = React.useMemo(() => current ? [...Object.values(related), ...Object.values(legacy)] : emptyArtifacts,
        [current, related, legacy]);
    const profilesGeneration = useServerProfilesGeneration();
    React.useEffect(() => {
        if (!current || !serverId || !accountId) return;
        return sync.observeArtifactInventory({ serverId, accountId }, publicationSelection, { refreshOnAdmission: true });
    }, [current, serverId, accountId]);
    useInboxArtifactBodyHydration(artifacts, current ? serverId : null, current ? accountId : null);
    const ids = React.useMemo(() => !serverId ? [] : artifacts.flatMap(artifact => {
        const id = readOpenWorkflowPublicationApprovalId(artifact, { serverId, runId });
        return id === null ? [] : [id];
    }), [artifacts, runId, serverId, profilesGeneration]);
    return React.useMemo(() => !serverId ? [] : ids.map(artifactId => ({ artifactId,
        href: buildApprovalHref(artifactId, serverId, createWorkflowRunRoute(runId, serverId)),
    })), [ids, runId, serverId]);
}
