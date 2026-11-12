import * as React from 'react';
import { readApprovalArtifactHeaderListFactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { InboxArtifactSourceBoundary, useInboxArtifactItems, useInboxArtifactSource } from '@/hooks/inbox/useInboxArtifactSource';
import { readOpenApprovalInboxAdmission } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { useInboxArtifactBodyHydration } from '@/sync/domains/state/storage';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

/** The header selects a request to open; the admitted body still owns every displayed fact and decision. */
export function DeploymentSecretRequests(props: Readonly<{ environmentId: string; scope: AccountSettingsScope | null; active: boolean }>) {
    return props.scope && props.active ? <InboxArtifactSourceBoundary><Requests environmentId={props.environmentId}
        scope={props.scope} /></InboxArtifactSourceBoundary> : null;
}

function Requests(props: Readonly<{ environmentId: string; scope: AccountSettingsScope }>) {
    const source = useInboxArtifactSource();
    const items = useInboxArtifactItems();
    const candidates = React.useMemo(() => source.scope?.serverId === props.scope.serverId
        && source.scope.accountId === props.scope.accountId ? items.openApprovals.filter(artifact =>
            artifact.sourceServerId === props.scope.serverId && artifact.ownerAccountId === props.scope.accountId
            && readApprovalArtifactHeaderListFactsV1(artifact.header)?.environmentSecretRequest === props.environmentId) : [],
    [items.openApprovals, props.environmentId, props.scope.serverId, props.scope.accountId, source.scope]);
    const hydration = useInboxArtifactBodyHydration(candidates, props.scope.serverId, props.scope.accountId);
    return <>
        {hydration.pending || hydration.failed ? <SurfaceStateCard size="line"
            testID="project-deployments.environment.secret-requests.state"
            kind={hydration.failed ? 'error' : 'loading'} title={hydration.failed ? t('common.unavailable') : t('common.loading')}
            action={hydration.failed ? { label: t('common.retry'), onPress: hydration.retry } : undefined} /> : null}
        {candidates.map(artifact => {
            const admission = readOpenApprovalInboxAdmission(artifact);
            if (admission.disposition !== 'presented' || admission.parsed.family !== 'built_in') return null;
            return <Request key={JSON.stringify([props.scope.serverId, props.scope.accountId, artifact.id])} artifactId={artifact.id} serverId={props.scope.serverId}
                title={admission.parsed.request.summary} />;
        })}
    </>;
}

function Request(props: Readonly<{ artifactId: string; serverId: string; title: string }>) {
    const [opened, setOpened] = React.useState(false);
    const review = useInPlaceApprovalReview({ approvalId: opened ? props.artifactId : null,
        approvalPending: true, serverId: props.serverId });
    return <SurfaceStateCard testID={`project-deployments.environment.secret-request.${props.artifactId}`}
        size="line" kind="warning" title={props.title}
        action={{ testID: `project-deployments.environment.secret-request.${props.artifactId}.review`, label: t('approvals.review'), onPress: () => { setOpened(true); review.reopen(); } }} />;
}
