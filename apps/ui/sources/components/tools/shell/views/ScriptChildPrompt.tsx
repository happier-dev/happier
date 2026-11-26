import * as React from 'react';
import type { Metadata } from '@happier-dev/session-core/state';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useTranscriptRowContentDemand } from '@/components/sessions/transcript/viewport/visibility/TranscriptRowContentDemand';
import { ApprovalPromptCard } from '../approvals/ApprovalPromptCard';
import { PermissionPromptCard } from '../permissions/PermissionPromptCard';
import { buildApprovalToolCallLocation, selectScriptPendingPermission, selectScriptSidechainPermissionIds } from './toolApprovalPromptMatching';

type PromptProps = Readonly<{
    sessionId: string;
    serverId: string | undefined;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason: TranscriptPermissionDisabledReason | undefined;
}>;

export const ScriptChildPrompt = React.memo(function ScriptChildPrompt(props: PromptProps & Readonly<{
    approval: OpenApprovalArtifactForSession | undefined;
    sidechainId: string | undefined;
    showPermission: boolean;
}>) {
    const contentDemand = useTranscriptRowContentDemand();
    const { approval, sidechainId, showPermission, ...promptProps } = props;
    const location = React.useMemo(() => buildApprovalToolCallLocation({
        messageId: approval?.approval.origin?.messageId,
    }), [approval?.approval.origin?.messageId]);
    const approvalCard = approval ? <ApprovalPromptCard {...promptProps} key={approval.artifact.id} chrome="inline"
        artifact={approval.artifact} approval={approval.approval} location={location} contentDemand={contentDemand} /> : null;
    if (!sidechainId || !showPermission) return approvalCard;
    return <IndexedScriptPermission {...promptProps} sidechainId={sidechainId}
        fallback={approvalCard} preferApproval={approval?.approval.status === 'open'} />;
});

function IndexedScriptPermission({ sidechainId, fallback, preferApproval, ...props }: PromptProps & Readonly<{
    sidechainId: string;
    fallback: React.ReactNode;
    preferApproval: boolean;
}>) {
    const source = useSessionTranscriptSource();
    const ids = source.useAgentStateSelection(state => selectScriptSidechainPermissionIds(state?.requests, sidechainId));
    return !preferApproval && ids.length > 0 ? <PendingScriptPermission {...props} ids={ids} fallback={fallback} /> : fallback;
}

function PendingScriptPermission({ ids, fallback, ...props }: PromptProps & Readonly<{
    ids: readonly string[];
    fallback: React.ReactNode;
}>) {
    const source = useSessionTranscriptSource();
    const request = selectScriptPendingPermission(ids, source.usePendingRequests().permissionRequests);
    return request ? <PermissionPromptCard {...props} key={request.id} request={request} chrome="inline" location={null} /> : fallback;
}
