import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { useWorkflowDefinitionLibrary } from '@/components/workflows/library/workflowLibraryReads';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

import type { TeamSectionContext } from './teamSectionContext';

export function TeamSharedWorkflowsSection(props: Readonly<{ context: TeamSectionContext }>) {
    const access = useWorkflowsDestinationAccess(props.context.address.serverId);
    return access.kind === 'workflows' ? <TeamSharedWorkflowsContent context={props.context} /> : null;
}

function TeamSharedWorkflowsContent({ context }: Readonly<{ context: TeamSectionContext }>) {
    const { address } = context;
    const router = useRouter();
    const { binding, resolution } = useServerCredentialAccountScopeBinding(address.serverId);
    const library = useWorkflowDefinitionLibrary({ enabled: binding !== null, accountLifetime: binding });
    const definitions = React.useMemo(() => library.definitions.filter(definition => definition.sharedTeamIds?.includes(address.teamId)),
        [library.definitions, address.teamId]);
    const loading = resolution.kind === 'resolving' || library.status === 'loading';
    const unavailable = binding === null && !loading;
    const failed = library.status === 'failed';

    return <ItemGroup title={t('workflows.title')}>
        {loading && definitions.length === 0 ? <ItemLoadStateRows testID="team-overview-workflows-loading" state={{ kind: 'loading' }} /> : null}
        {failed || unavailable ? <SurfaceStateCard testID="team-overview-workflows-failed" kind="error" size="line"
            title={library.failure?.title ?? t('workflows.loadFailedTitle')}
            reason={library.failure?.message ?? t('workflows.loadFailedBody')}
            accessibilitySemantics={library.failure?.accessibilitySemantics ?? 'alert'}
            action={unavailable || library.failure?.repair === 'none' ? undefined : { label: t('workflows.retry'), onPress: library.retry }} /> : null}
        {binding && library.status === 'loaded' && !library.hasMore && definitions.length === 0
            ? <SurfaceStateCard testID="team-overview-workflows-empty" kind="empty" size="line" title={t('workflows.empty.savedTitle')} /> : null}
        {definitions.map(definition => <Item key={definition.definitionId} testID={`team-overview-workflow:${definition.definitionId}`}
            icon={<Icon name="tree-structure" />}
            title={formatWorkflowDefinitionLibraryTitle(definition)}
            subtitle={definition.contentStatus === 'unavailable'
                ? formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason)
                : definition.metadata.description ?? t('workflows.examples.stepCount', { count: definition.stepCount })}
            onPress={() => router.push(createWorkflowDefinitionRoute(definition.definitionId, address.serverId))} />)}
        {library.hasMore ? <Item testID="team-overview-workflows-more" disabled={library.loadingMore}
            title={library.loadingMore ? t('common.loading') : library.loadMoreFailed ? t('workflows.retry') : t('workflows.destination.loadMoreWorkflows')}
            onPress={library.loadMore} /> : null}
    </ItemGroup>;
}
