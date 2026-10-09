import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { MachinePoolViewV1 } from '@happier-dev/protocol';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { useMachinePoolProjections } from '@/sync/engine/machines/useMachinePoolProjections';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { isMachinePoolHomeOffline, isMachinePoolRefreshFailed } from '../pools/machinePoolEditorModel';
import { buildMachinePoolRowPresentations, resolveMachinePoolEnabledMemberLabels } from '@/components/machines/pools/machinePoolRowPresentation';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { machinePoolCollectionHref } from '../collection/machineCollectionModel';

const MEMBER_PREVIEW_LIMIT = 2;

export function machinePoolSettingsRowTestId(serverId: string, poolId: string): string {
    return `settings.machinePools.row.${serverId}.${poolId}`;
}

export function machinePoolSettingsAddTestId(serverId: string): string {
    return `settings.machinePools.add.${serverId}`;
}

export function resolveMachinePoolDeleteFocusTargetTestId(
    serverId: string,
    pools: readonly MachinePoolViewV1[],
    deletedPoolId: string,
): string {
    const deletedIndex = pools.findIndex((view) => view.pool.id === deletedPoolId);
    const next = deletedIndex >= 0 ? pools[deletedIndex + 1] : undefined;
    if (next) return machinePoolSettingsRowTestId(serverId, next.pool.id);
    const previous = deletedIndex > 0 ? pools[deletedIndex - 1] : undefined;
    return previous
        ? machinePoolSettingsRowTestId(serverId, previous.pool.id)
        : machinePoolSettingsAddTestId(serverId);
}

function availabilityText(view: MachinePoolViewV1): string {
    return view.availability.state === 'known'
        ? t('machinePools.availabilityKnown', { connected: view.availability.connectedCount, enabled: view.availability.enabledCount })
        : t('machinePools.availabilityUnknown');
}

function memberPreview(view: MachinePoolViewV1, machines: ReadonlyArray<Machine>): string {
    return resolveMachinePoolEnabledMemberLabels(view, machines, { limit: MEMBER_PREVIEW_LIMIT }).join(', ');
}

export function machinePoolCollectionKey(serverId: string, poolId: string): string {
    return `pool:${serverId}:${poolId}`;
}

/**
 * The machine pools of each Home that supports them. `page` is the Machines list page's section
 * (rows push the editor, and an Add row starts a pool); `rail` is the same list in the Machines
 * collection rail beside the open detail (rows replace the detail; adding goes through the rail's "+").
 */
export const MachinePoolsSection = React.memo(function MachinePoolsSection(props: Readonly<{
    groups: readonly ActiveSelectionMachineGroup[];
    variant?: 'page' | 'rail';
    /** The collection row the route selects (`pool:<serverId>:<poolId>`), rail only. */
    selectedKey?: string | null;
}>) {
    const router = useRouter();
    const rail = props.variant === 'rail';
    const projections = useMachinePoolProjections(props.groups);
    const focusReturnReady = projections.every((projection) => Boolean(
        projection
        && projection.featureStatus !== 'loading'
        && (projection.status !== 'loading' || projection.pools.length > 0),
    ));
    const navigateWithFocusReturn = useNavigationFocusReturn({ ready: focusReturnReady });

    return <>
        {props.groups.map((group, index) => {
            const projection = projections[index];
            const title = props.groups.length > 1 ? `${t('machinePools.title')} · ${group.serverName}` : t('machinePools.title');
            const featurePending = !projection || projection.featureStatus === 'loading';
            const featureError = projection?.featureStatus === 'error';
            const featureEnabled = projection?.featureStatus === 'enabled';
            const homeOffline = isMachinePoolHomeOffline(group.status)
                || isMachinePoolHomeOffline(projection?.status ?? 'loading');
            // A failed read is not an offline Home. Rows stay readable and administration stays
            // reachable; only the connection summary stops claiming to be a current observation.
            const refreshFailed = featureEnabled && !homeOffline
                && (isMachinePoolRefreshFailed(group.status) || isMachinePoolRefreshFailed(projection.status));
            const unavailable = !featureEnabled || homeOffline || refreshFailed;
            const rows = buildMachinePoolRowPresentations(projection?.pools ?? [], (view) => memberPreview(view, group.machines));
            // A settled disabled Home has no Pool administration surface. Cold discovery and cold
            // discovery failure also stay absent: without an enabled decision or retained Pool row,
            // Settings must not advertise administration that this Home may not support. Once the
            // feature or retained data establishes this surface, failures remain truthful below.
            if (projection?.featureStatus === 'disabled') return null;
            if ((featurePending || featureError) && rows.length === 0) return null;
            const retry = () => { void invalidateMachinePoolProjection(group.serverId, { forceFeatures: true }).catch(() => {}); };
            const openPool = (poolId: string, rowTestId: string) => {
                const href = machinePoolCollectionHref({ poolId, serverId: group.serverId });
                // Beside the rail, choosing another pool replaces the open detail instead of stacking it.
                if (rail) router.replace(href as never);
                else navigateWithFocusReturn.navigateFrom(rowTestId, () => router.push(href as never));
            };
            const statusRows = <>
                {featurePending ? <Item
                    testID={`settings.machinePools.featureLoading.${group.serverId}`}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    title={t('common.loading')}
                    density={rail ? 'compact' : undefined}
                    mode="info"
                /> : null}
                {featureError ? <Item
                    testID={`settings.machinePools.featureFailed.${group.serverId}`}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    title={t('machinePools.refreshFailed')}
                    density={rail ? 'compact' : undefined}
                    mode="info"
                /> : null}
                {featureError ? <Item
                    testID={`settings.machinePools.featureRetry.${group.serverId}`}
                    title={t('common.retry')}
                    density={rail ? 'compact' : undefined}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    showChevron={!rail}
                    onPress={retry}
                /> : null}
                {homeOffline ? <Item
                    testID={`settings.machinePools.unavailable.${group.serverId}`}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    title={t('machinePools.homeOffline')}
                    density={rail ? 'compact' : undefined}
                    mode="info"
                /> : null}
                {refreshFailed ? <Item
                    testID={`settings.machinePools.refreshFailed.${group.serverId}`}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    title={t('machinePools.refreshFailed')}
                    density={rail ? 'compact' : undefined}
                    mode="info"
                /> : null}
                {refreshFailed ? <Item
                    testID={`settings.machinePools.retry.${group.serverId}`}
                    title={t('common.retry')}
                    density={rail ? 'compact' : undefined}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    showChevron={!rail}
                    onPress={retry}
                /> : null}
            </>;
            const poolRows = rows.map(({ view, memberPreview: preview, identityDetail, accessibilityName }) => {
                const availability = availabilityText(view);
                const rowTestId = machinePoolSettingsRowTestId(group.serverId, view.pool.id);
                // A Home that is signed out or failed to refresh keeps its last known rows;
                // the row says so instead of presenting a stale connection count as current.
                const detail = [
                    unavailable ? t('machinePools.unavailable') : availability,
                    identityDetail,
                ].filter(Boolean).join(' · ');
                const openable = featureEnabled && !homeOffline;
                return <Item
                    key={view.pool.id}
                    testID={rowTestId}
                    pressableRef={openable && !rail
                        ? navigateWithFocusReturn.targetRef(rowTestId)
                        : undefined}
                    title={view.pool.name}
                    // The rail shows the members, or what keeps the pool from use, plus
                    // the identity that tells same-named pools apart (present only for duplicates).
                    subtitle={rail
                        ? [preview || (unavailable ? t('machinePools.unavailable') : availability) || t('machinePools.noMembers'), identityDetail].filter(Boolean).join(' · ')
                        : (preview || t('machinePools.noMembers'))}
                    // The identity suffix is what tells duplicates apart, so it may wrap rather than be clipped.
                    subtitleLines={rail && identityDetail ? 0 : undefined}
                    detail={rail ? undefined : detail}
                    accessibilityLabel={[
                        accessibilityName,
                        preview,
                        unavailable ? t('machinePools.unavailable') : availability,
                        props.groups.length > 1 ? group.serverName : null,
                    ].filter(Boolean).join('. ')}
                    disabled={!openable}
                    selected={rail ? props.selectedKey === machinePoolCollectionKey(group.serverId, view.pool.id) : undefined}
                    density={rail ? 'compact' : undefined}
                    showChevron={rail ? false : undefined}
                    pressableStyle={rail ? collectionListStyles.row : undefined}
                    onPress={openable ? () => openPool(view.pool.id, rowTestId) : undefined}
                />;
            });
            const loadingRow = rows.length === 0 && featureEnabled && projection.status === 'loading'
                ? <Item title={t('common.loading')} density={rail ? 'compact' : undefined} pressableStyle={rail ? collectionListStyles.row : undefined} mode="info" />
                : null;
            if (rail) {
                // Adding goes through the rail's "+": a Home with nothing to list shows no heading.
                const hasStatus = featurePending || featureError || homeOffline || refreshFailed || loadingRow !== null;
                if (rows.length === 0 && !hasStatus) return null;
                return (
                    <React.Fragment key={group.serverId}>
                        <CollectionListGroupLabel title={title} count={rows.length > 0 ? rows.length : undefined} />
                        {statusRows}
                        {poolRows}
                        {loadingRow}
                    </React.Fragment>
                );
            }
            return (
                <ItemGroup key={group.serverId} title={title} description={t('machinePools.privacy')}>
                    {statusRows}
                    {poolRows}
                    {loadingRow}
                    {featureEnabled ? <Item
                        testID={machinePoolSettingsAddTestId(group.serverId)}
                        pressableRef={!homeOffline
                            ? navigateWithFocusReturn.targetRef(machinePoolSettingsAddTestId(group.serverId))
                            : undefined}
                        title={t('machinePools.add')}
                        subtitle={rows.length === 0 ? t('machinePools.benefit') : undefined}
                        disabled={homeOffline}
                        onPress={() => navigateWithFocusReturn.navigateFrom(machinePoolSettingsAddTestId(group.serverId), () => router.push(`/settings/machines/pools/new?serverId=${encodeURIComponent(group.serverId)}` as never))}
                    /> : null}
                </ItemGroup>
            );
        })}
    </>;
});
