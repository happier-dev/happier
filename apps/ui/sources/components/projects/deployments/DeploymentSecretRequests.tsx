import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { deriveDeploymentEnvironmentApprovalSubjectKeyV1, readApprovalArtifactHeaderListFactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { approvalArtifactSubjectIndexedKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useArtifactInventoryRead } from '@/components/artifacts/useArtifactInventoryRead';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { selectArtifactInventoryRows } from '@/sync/store/domains/artifactInventoryIndex';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

/** List the Environment's indexed summaries. Review opens and admits each request by ID. */
export function DeploymentSecretRequests(props: Readonly<{ environmentId: string; scope: AccountSettingsScope | null; active: boolean }>) {
    const scope = useAccountSettingsScope();
    return props.scope && props.active && areServerAccountScopesEqual(scope, props.scope)
        ? <Requests environmentId={props.environmentId} scope={props.scope} /> : null;
}

function Requests(props: Readonly<{ environmentId: string; scope: AccountSettingsScope }>) {
    const selection = React.useMemo(() => ({
        kinds: [approvalArtifactSubjectIndexedKindV1(deriveDeploymentEnvironmentApprovalSubjectKeyV1({ environmentId: props.environmentId }))],
        approvalStates: ['open'] as const,
    }), [props.environmentId]);
    const { failed, retry } = useArtifactInventoryRead(true, selection);
    const candidates = storage(useShallow(state => {
        if (!areServerAccountScopesEqual(state.profileScope, props.scope)) return [];
        return Object.values(selectArtifactInventoryRows(state, selection)).filter(artifact =>
            state.artifactInboxEntries[artifact.id]?.listedApproval
            && artifact.sourceServerId === props.scope.serverId && artifact.ownerAccountId === props.scope.accountId
            && readApprovalArtifactHeaderListFactsV1(artifact.header)?.environmentSecretRequest === props.environmentId)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
    return <>
        {failed ? <SurfaceStateCard size="line"
            testID="project-deployments.environment.secret-requests.state"
            kind="error" title={t('common.unavailable')}
            action={{ label: t('common.retry'), onPress: retry }} /> : null}
        {candidates.map(artifact => <Request key={JSON.stringify([props.scope.serverId, props.scope.accountId, artifact.id])}
            artifactId={artifact.id} serverId={props.scope.serverId} title={artifact.title ?? t('approvals.review')} />)}
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
