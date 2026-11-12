import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionProjectScmSummarySnapshot } from '@/sync/store/scmHooks';
import { SessionScmPullRequestSurface } from '@/components/workspaces/scm/update/ScmPullRequestSurface';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DeploymentPreparationOperations } from './DeploymentPreparationOperations';

/** Returned SessionRef is enough for this mounted continuation. Reload discovery belongs to Session metadata. */
export function DeploymentPreparationResult(props: Readonly<{ session: SessionAddress; accountId: string }>) {
    const router = useRouter();
    const snapshot = useSessionProjectScmSummarySnapshot(props.session.sessionId, props.session.serverId);
    return <>
        <ItemGroup title={t('projects.deployments.preparation.resultTitle')}>
            <Item testID="project-deployments.prepare.result.session" title={t('common.open')}
                onPress={() => router.push(buildScopedSessionRouteHref(props.session))} />
        </ItemGroup>
        <SessionScmPullRequestSurface session={props.session}
            pullRequest={snapshot?.pullRequestStatus?.openPullRequest ?? undefined} fallback={null} />
        <SurfaceStateCard testID="project-deployments.prepare.result.unverified" size="line" kind="unavailable"
            title={t('projects.deployments.preparation.unverified')}
            reason={t('projects.deployments.preparation.unverifiedHint')} />
        <DeploymentPreparationOperations session={props.session} accountId={props.accountId} />
    </>;
}
