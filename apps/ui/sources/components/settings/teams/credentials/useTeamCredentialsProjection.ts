import * as React from 'react';
import type {
    TeamCredentialResourceCatalogEntryV1,
    TeamCredentialResourceListFilterV1,
    TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    useTeamCredentialResourceCatalog,
    useTeamCredentialResources,
    type TeamCredentialResourcesProjection,
} from '@/hooks/teams/useTeamCredentialResources';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';

import type { TeamSectionContext } from '../teamSectionContext';
import { orderTeamCredentialResources } from './teamCredentialPresentation';

type TeamCredentialsProjection = Readonly<{
    featureEnabled: boolean;
    projection: TeamCredentialResourcesProjection;
    rows: readonly (TeamCredentialResourceSummaryV1 | TeamCredentialResourceCatalogEntryV1)[];
    recipientPending: boolean;
    error: HomeDomainFailure | null;
    settled: boolean;
    totalCount: number | null;
    retry: () => Promise<void>;
}>;

/** The overview and list consume the same administered and entitled resources. */
export function useTeamCredentialsProjection(
    context: TeamSectionContext,
    search?: string,
    filter?: TeamCredentialResourceListFilterV1,
): TeamCredentialsProjection {
    const featureEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: context.scope.serverId,
    });
    const projection = useTeamCredentialResources({
        scope: context.scope,
        address: context.address,
        enabled: featureEnabled,
        search,
        filter,
    });
    // Administration is custodian-scoped for members. The recipient catalog owns
    // entitled shares and their readiness, including shares with no usable models.
    const needsRecipientCatalog = featureEnabled && projection.viewer?.manageCredentials === false;
    const catalog = useTeamCredentialResourceCatalog({
        scope: context.scope,
        address: context.address,
        enabled: needsRecipientCatalog,
    });
    const rows = React.useMemo(() => {
        const byId = new Map<string, TeamCredentialResourceSummaryV1 | TeamCredentialResourceCatalogEntryV1>(
            projection.rows.map(resource => [resource.id, resource]),
        );
        const query = search?.trim().toLocaleLowerCase() ?? '';
        if (needsRecipientCatalog) for (const resource of catalog.resources) {
            if (!byId.has(resource.id) && (!query || resource.displayName.toLocaleLowerCase().includes(query))) {
                byId.set(resource.id, resource);
            }
        }
        return orderTeamCredentialResources([...byId.values()]);
    }, [catalog.resources, needsRecipientCatalog, projection.rows, search]);
    const recipientPending = needsRecipientCatalog && !catalog.resolved && !catalog.error;
    const error = projection.error ?? (needsRecipientCatalog ? catalog.error : null);
    const settled = projection.status === 'ready' && !recipientPending && !error;
    // Partial or stale answers cannot establish a total, including zero.
    const totalCount = projection.isCurrent && !projection.hasMore
        && (!needsRecipientCatalog || catalog.isCurrent) ? rows.length : null;
    const retry = async () => {
        await Promise.all([projection.retry(), ...(needsRecipientCatalog ? [catalog.reload()] : [])]);
    };
    return { featureEnabled, projection, rows, recipientPending, error, settled, totalCount, retry };
}
