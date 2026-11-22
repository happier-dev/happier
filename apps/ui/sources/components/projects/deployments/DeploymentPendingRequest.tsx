import * as React from 'react';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** The single pending slot is projected by the read owner; this row never queues or observes work. */
export function DeploymentPendingRequest(props: Readonly<{
    pending: DeploymentEnvironmentDetailV1['pendingDeployment'];
    serverId: string;
}>) {
    const pending = props.pending;
    if (!pending) return null;
    if (pending.status === 'unavailable') return <ItemGroup>
        <SurfaceStateCard testID="project-deployments.environment.pending.unavailable" size="line" kind="unavailable"
            title={t('projects.deployments.overviewStatus.pendingDeploymentTitle')} diagnosticCode={pending.reason} />
    </ItemGroup>;
    const source = pending.intent.sourceIntent;
    return <ItemGroup>
        <Item testID="project-deployments.environment.pending"
            title={t(source.kind === 'repository' && pending.intent.triggerOccurrence
                ? 'projects.deployments.overviewStatus.pendingRepositoryTitle'
                : 'projects.deployments.overviewStatus.pendingDeploymentTitle')}
            subtitle={source.kind === 'repository' ? source.sha : source.kind === 'folder'
                ? t('projects.deployments.review.localFolder') : t('projects.deployments.overviewStatus.pendingStoredRevision',
                { revision: source.contentRevision, digest: source.composeDigest })}
            subtitleLines={0} icon={<Icon name="clock" />}
            onPress={() => openActionOperationDetail({ serverId: props.serverId, operationId: pending.admission.actionOperationId })} />
    </ItemGroup>;
}
