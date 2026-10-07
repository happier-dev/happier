import * as React from 'react';
import { View } from 'react-native';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { type IconName } from '@/components/ui/icons/Icon';
import { EntityFlatReorderList, EntityFlatReorderRow, entityReorderPreview, entityReorderRefused, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { type CustomModalInjectedProps } from '@/modal';
import { useProfile } from '@/sync/domains/state/storage';
import { NavigationSurfacePlacementsV1Schema, resolveNavigationPlacements, reorderNavigationPlacement, updateNavigationPlacement, type NavigationPlacement, type NavigationPlacementPreferences, type NavigationSurfaceId, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';
import { useNavigationSurfacePlacement } from './useNavigationSurfacePlacement';

export type NavigationPlacementItem = Readonly<{
    id: string;
    title: string;
    icon?: IconName;
    group?: string;
    defaultPlacement?: NavigationPlacement;
}>;

type CustomizerProps = Readonly<{
    surfaceId: NavigationSurfaceId;
    items: readonly NavigationPlacementItem[];
    testID?: string;
}>;

/** Modal-bound preferences remain live when a settings Action changes the same device. */
export function NavigationPlacementCustomizer(props: CustomizerProps & CustomModalInjectedProps) {
    const owner = useNavigationSurfacePlacement(props.surfaceId);
    const profile = useProfile();
    const home = useActiveServerSnapshot();
    const scope = React.useMemo(() => home.serverId && profile.id ? { serverId: home.serverId, accountId: profile.id } : null, [home.serverId, profile.id]);
    const footer = React.useMemo(() => <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <RoundButton title={t('navigationPlacement.reset')} display="secondary" size="small" onPress={() => owner.setPreferences({ orderedIds: [], placements: {} })} />
        <RoundButton title={t('common.done')} size="small" onPress={props.onClose} />
    </View>, [owner.setPreferences, props.onClose]);
    React.useEffect(() => {
        props.setChrome?.({ kind: 'card', title: t(`navigationPlacement.${props.surfaceId}`), subtitle: t('navigationPlacement.description'),
            scrollHost: 'body', bodyScroll: 'none', phonePresentation: 'sheet', footer, dimensions: { size: 'lg' } });
    }, [footer, props.setChrome, props.surfaceId]);
    return <NavigationPlacementCustomizerView {...props} scope={scope} preferences={owner.preferences}
        placementsBySurface={owner.placementsBySurface} onChange={owner.setPreferences} showHeader={false} />;
}

/** The same real controls with a controlled specimen boundary, so captures never write an Account. */
export function NavigationPlacementCustomizerView(props: CustomizerProps & Readonly<{
    preferences: NavigationPlacementPreferences;
    placementsBySurface?: NavigationSurfacePlacementsV1;
    onChange: (preferences: NavigationPlacementPreferences) => void;
    scope?: EntityDragScopeV1 | null;
    showHeader?: boolean;
}>) {
    const testID = props.testID ?? 'navigation-placement-customizer';
    const placements = resolveNavigationPlacements(props.items, props.preferences);
    const items = placements.ordered;
    const options = React.useMemo(() => (['pinned', 'overflow', 'hidden'] as const).map(id => ({ id, label: t(`navigationPlacement.${id}`) })), []);
    const binding: EntityFlatReorderBinding = {
        scope: props.scope ?? null,
        kind: 'navigation-item',
        items,
        getItem: id => props.scope && items.some(item => item.id === id)
            ? { kind: 'navigation-item', scope: props.scope, surfaceId: props.surfaceId, itemId: id } : null,
        getSourceId: item => item.kind === 'navigation-item' && item.surfaceId === props.surfaceId ? item.itemId : null,
        resolve: (sourceId, position) => {
            const ids = items.map(item => item.id);
            const moved = resolveAnchoredListMoveV1(ids, sourceId, position);
            if (!moved || moved.every((id, index) => id === ids[index])) return entityReorderRefused('same-position');
            const next = reorderNavigationPlacement(props.preferences, ids, sourceId, position);
            if (!next) return entityReorderRefused('reorder_target_gone');
            return { status: 'allowed', effect: { actionId: 'settings.set', input: {
                anchor: 'appearance.navigationPlacements', value: { ...props.placementsBySurface, [props.surfaceId]: next },
            }, preview: entityReorderPreview(position, items) } };
        },
        execute: async effect => {
            const input = effect.input;
            if (effect.actionId !== 'settings.set' || !input || typeof input !== 'object' || Array.isArray(input) || !('anchor' in input) || input.anchor !== 'appearance.navigationPlacements') {
                return { status: 'refused', reason: { code: 'invalid_navigation_placement', message: t('entityDragDrop.reasons.gone') } };
            }
            const parsed = NavigationSurfacePlacementsV1Schema.safeParse('value' in input ? input.value : undefined);
            const next = parsed.success ? parsed.data[props.surfaceId] : null;
            if (!next) return { status: 'refused', reason: { code: 'invalid_navigation_placement', message: t('entityDragDrop.reasons.gone') } };
            props.onChange(next);
            return { status: 'applied' };
        },
    };
    return <ItemList testID={testID}>
        {props.showHeader !== false ? <PageHeader title={t(`navigationPlacement.${props.surfaceId}`)} description={t('navigationPlacement.description')} /> : null}
        <EntityFlatReorderList binding={binding} testID={`${testID}.reorder`} initialOrganizing>
            <ItemGroup>
                {items.map(item => <EntityFlatReorderRow key={item.id} id={item.id}>
                    {({ renderHandle }) => <SegmentedChoiceItem title={item.title} leftElement={renderHandle(`${testID}.move:${item.id}`)}
                        value={props.preferences.placements[item.id] ?? item.defaultPlacement ?? 'pinned'} options={options}
                        testIDPrefix={`${testID}.placement:${item.id}`}
                        onChange={placement => props.onChange(updateNavigationPlacement(props.preferences, item.id, placement))} />}
                </EntityFlatReorderRow>)}
            </ItemGroup>
        </EntityFlatReorderList>
    </ItemList>;
}
