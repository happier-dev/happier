import * as React from 'react';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { teamsUnavailableHomeReason } from '../teamsDirectoryViewState';
import type { HomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { t } from '@/text';

import {
    deliveryModeLabel,
    recipientDeliveryMode,
    resourceStateLabel,
    sourceKindLabel,
    teamCredentialRecoveryLabel,
    teamCredentialRecoveryPresentation,
} from './teamCredentialPresentation';
import { CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';

export const TeamCredentialCatalogSettingsGroup = React.memo(function TeamCredentialCatalogSettingsGroup(props: Readonly<{
    title: string;
    /** `group`: a titled section of a page. `rail`: a labelled group of rows in a collection rail. */
    variant?: 'group' | 'rail';
    sourceKind: 'connected_service' | 'provider';
    catalog: HomeTeamCredentialModelCatalog;
    onOpen: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    /** Re-read the retained catalog through the canonical Team directory owner. */
    onRetry?: () => void | Promise<void>;
}>) {
    const resources = React.useMemo(() => {
        const unique = new Map<string, TeamCredentialResourceCatalogEntryV1>();
        for (const resource of props.catalog.resources) {
            if (resource.sourcePresentation?.kind !== props.sourceKind) continue;
            unique.set(`${resource.teamId}:${resource.id}`, resource);
        }
        return [...unique.values()].sort((left, right) => (
            left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id)
        ));
    }, [props.catalog.resources, props.sourceKind]);

    // Last-known is truthful only when there are retained rows. Disabled and
    // current-empty catalogs stay absent; cold loads and failures name their state.
    if (resources.length === 0 && !props.catalog.condition) return null;
    const rail = props.variant === 'rail';
    const condition = props.catalog.condition;
    const retry = props.onRetry && condition?.retryable !== false ? {
        testID: `team-credential-catalog-retry:${props.sourceKind}`,
        label: t('common.retry'),
        onPress: () => Promise.resolve(props.onRetry?.()).catch(() => undefined),
    } : undefined;
    const state = !props.catalog.current ? resources.length > 0 ? (
        <SurfaceFreshnessLine
            testID={`team-credential-catalog-stale:${props.sourceKind}`}
            reason={[t('teams.stale.label'), condition && condition.reason !== 'loading' ? teamsUnavailableHomeReason(condition) : null].filter(Boolean).join(' ')}
            busy={condition?.reason === 'loading'}
            action={retry}
        />
    ) : condition ? (
        <SurfaceStateCard
            testID={`team-credential-catalog-state:${props.sourceKind}`}
            size={rail ? 'line' : undefined}
            kind={condition.reason === 'loading' ? 'loading' : 'unavailable'}
            title={condition.reason === 'loading' ? t('teams.directory.loading') : t('teams.unavailable.title')}
            reason={condition.reason === 'loading' ? undefined : teamsUnavailableHomeReason(condition)}
            action={retry}
        />
    ) : null : null;

    const rows = resources.map((resource) => {
        const resourceCurrent = props.catalog.currentResourceKeys.has(`${resource.teamId}:${resource.id}`);
        // The catalog row never decides who may repair a resource: every
        // navigable recovery opens the exact resource's own Settings, which
        // applies the Home's viewer decision. Recoveries without a
        // destination here — owner handoff, app update, choosing another
        // resource — keep the row visible and say what to do instead.
        const recovery = teamCredentialRecoveryPresentation(resource.recoveryAction);
        const canOpen = resourceCurrent;
        const teamName = props.catalog.teamNameById[resource.teamId] ?? t('teams.title');
        const state = resourceStateLabel(resource.readiness.kind);
        // A disabled row must still say why it cannot open and what its
        // recovery is; an openable row's destination is the recovery, so
        // the state alone is enough.
        const recoveryLabel = resourceCurrent && recovery !== null
            ? teamCredentialRecoveryLabel(recovery)
            : null;
        const mode = recipientDeliveryMode(resource);
        const delivery = mode ? deliveryModeLabel(mode) : null;
        const subtitle = [teamName, delivery, state, recoveryLabel].filter((part): part is string => Boolean(part)).join(' · ');
        return (
            <Item
                key={`${resource.teamId}:${resource.id}`}
                density={rail ? 'compact' : undefined}
                pressableStyle={rail ? collectionListStyles.row : undefined}
                showChevron={rail ? false : undefined}
                testID={`team-credential-catalog-resource:${resource.teamId}:${resource.id}`}
                title={resource.displayName}
                subtitle={subtitle}
                accessibilityLabel={[
                    resource.displayName,
                    teamName,
                    sourceKindLabel(resource.sourcePresentation),
                    delivery,
                    state,
                    recoveryLabel,
                ].filter((part): part is string => Boolean(part)).join(', ')}
                disabled={!canOpen}
                onPress={canOpen ? () => props.onOpen(resource) : undefined}
            />
        );
    });

    if (rail) {
        return (
            <>
                <CollectionListGroupLabel
                    title={props.title}
                    count={props.catalog.current || resources.length > 0 ? resources.length : undefined}
                />
                {rows}
                {state}
            </>
        );
    }
    return (
        <ItemGroup title={props.title}>
            {rows}
            {state}
        </ItemGroup>
    );
});
