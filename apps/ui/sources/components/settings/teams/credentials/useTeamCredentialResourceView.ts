import * as React from 'react';
import type {
    TeamCredentialResourceCatalogEntryV1,
    TeamCredentialResourceSummaryV1,
    TeamCredentialViewerCapabilitiesV1,
} from '@happier-dev/protocol/teams';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    useTeamCredentialResource,
    useTeamCredentialResourceCatalog,
} from '@/hooks/teams/useTeamCredentialResources';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';

import type { TeamSectionContext } from '../teamSectionContext';
import { useOpenedTeamCredentialDisplayNames } from './teamCredentialPrivateLabels';

/**
 * One resource as the detail, editor, audience and activity destinations see it.
 *
 * They all read the same exact-resource observation rather than searching the
 * first page of the administration list. The independent recipient catalog is
 * retained for least-privilege read-only detail. `resolved` distinguishes
 * "the Home has not answered yet" from "the Home answered and this resource is
 * not there", so a deep link cannot flash a not-found while the read is open.
 */
export type TeamCredentialResourceView = Readonly<{
    featureEnabled: boolean;
    resource: TeamCredentialResourceSummaryV1 | null;
    /** Least-privilege row for a recipient who has no administration row. */
    catalogResource: TeamCredentialResourceCatalogEntryV1 | null;
    /** Locally opened resource label; unavailable E2EE material remains unlabeled. */
    displayName: string | null;
    viewer: TeamCredentialViewerCapabilitiesV1 | null;
    resolved: boolean;
    /** Whether an ordinary resource write may be offered on this screen. */
    canManage: boolean;
    /**
     * The retained resource is stale, or a write is waiting on approval.
     *
     * This is deliberately separate from {@link canManage}: an unresolved
     * read or approval suspends writing, it does not withdraw the capability. Folding
     * the two would make every control vanish the moment someone used one, so
     * the person who is waiting loses both their draft and any explanation.
     */
    writesSuspended: boolean;
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

export function useTeamCredentialResourceView(params: Readonly<{
    context: TeamSectionContext;
    resourceId: string;
}>): TeamCredentialResourceView {
    const { context, resourceId } = params;
    const featureEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: context.scope.serverId,
    });
    const exact = useTeamCredentialResource({
        scope: context.scope,
        address: context.address,
        resourceId,
        enabled: featureEnabled,
    });
    const catalog = useTeamCredentialResourceCatalog({
        scope: context.scope,
        address: context.address,
        enabled: featureEnabled,
    });

    const catalogResource = React.useMemo(
        () => catalog.resources.find((row) => row.id === resourceId && row.teamId === context.address.teamId) ?? null,
        [catalog.resources, context.address.teamId, resourceId],
    );
    const labelCarrier = exact.resource ?? catalogResource;
    const openedDisplayNames = useOpenedTeamCredentialDisplayNames({
        scope: context.scope,
        resources: labelCarrier === null ? [] : [labelCarrier],
        enabled: featureEnabled,
    });
    const displayName = labelCarrier === null ? null : openedDisplayNames[labelCarrier.id] ?? null;
    const managesResources = exact.resource !== null && (
        exact.resource.capabilities.manageAudience
        || exact.resource.capabilities.managePolicy
        || exact.resource.capabilities.manageLimits
    );
    const viewer = React.useMemo(() => exact.resource === null ? null : Object.freeze({
        manageCredentials: managesResources,
        offerOwnCredential: exact.resource.custodianAccountId === context.scope.accountId,
    }), [context.scope.accountId, exact.resource, managesResources]);
    const reload = React.useCallback(async () => {
        await Promise.all([exact.reload(), catalog.reload()]);
    }, [catalog.reload, exact.reload]);
    // A recipient row establishes read-only availability, not administration
    // access. Its manager-only denial must not become a resource failure.
    const error = catalogResource !== null && exact.error?.kind === 'forbidden'
        ? catalog.error
        : exact.error?.retryable === true
            ? exact.error
            : catalog.error?.retryable === true
                ? catalog.error
                : exact.error ?? catalog.error;

    return React.useMemo(() => Object.freeze({
        featureEnabled,
        resource: exact.resource,
        catalogResource,
        displayName,
        viewer,
        // A recipient catalog row can render read-only detail, but it cannot
        // settle the independent administration read used by the editor and
        // activity screens. Keep those screens loading until that read answers.
        resolved: exact.resource !== null || (exact.resolved && catalog.resolved),
        canManage: context.mutationsAvailable
            && !context.archived
            && managesResources,
        writesSuspended: context.approvalPending || !exact.isCurrent,
        error,
        reload,
    }), [catalog.resolved, catalogResource, context.approvalPending, context.archived, context.mutationsAvailable, displayName, error, exact.isCurrent, exact.resolved, exact.resource, featureEnabled, managesResources, reload, viewer]);
}
