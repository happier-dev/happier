import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { SessionScmPullRequestSurface } from '@/components/workspaces/scm/update/ScmPullRequestSurface';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { projectSessionWorkDisplayV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import { formatSessionWorkStateBadgeLabel } from '@/components/sessions/workState/sessionWorkStatePresentation';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { getScmUserFacingError } from '@/scm/scmUserFacingErrors';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DeploymentPreparationOperations } from './DeploymentPreparationOperations';
import { useDeploymentPreparationRead } from './useDeploymentPreparationRead';

/** Returned SessionRef is enough for this mounted continuation. Reload discovery belongs to Session metadata. */
export function DeploymentPreparationResult(props: Readonly<{ session: SessionAddress; lifetime: ServerAccountScopeLifetime }>) {
    const router = useRouter();
    const read = useDeploymentPreparationRead(props.lifetime, props.session);
    const work = projectSessionWorkDisplayV1(read.workState);
    const workLabel = formatSessionWorkStateBadgeLabel(work?.primaryItem ?? null, t);
    const publication = read.publication;
    const cause = read.phase === 'publicationFailed' && publication?.failure
        ? publication.outcome && 'errorCode' in publication.outcome
            ? getScmUserFacingError({ errorCode: publication.outcome.errorCode, fallback: t('errors.operationFailed') })
            : resolveActionExecutionFailureMessage(publication.failure, t('errors.operationFailed'))
        : null;
    return <>
        <ItemGroup title={t('projects.deployments.preparation.resultTitle')}>
            <Item testID="project-deployments.prepare.result.session" title={t('common.open')} subtitle={workLabel ?? undefined}
                onPress={() => router.push(buildScopedSessionRouteHref(props.session))} />
        </ItemGroup>
        {cause ? <SurfaceStateCard testID="project-deployments.prepare.result.publication-failed" size="line" kind="error"
            title={t('toolView.actionOutcome.failed')} reason={cause} /> : null}
        <SessionScmPullRequestSurface session={props.session} fallback={null} />
        <SurfaceStateCard testID="project-deployments.prepare.result.unverified" size="line" kind="unavailable"
            title={t('projects.deployments.preparation.unverified')}
            reason={t('projects.deployments.preparation.unverifiedHint')} />
        <DeploymentPreparationOperations session={props.session} accountId={props.lifetime.scope.accountId} />
    </>;
}
