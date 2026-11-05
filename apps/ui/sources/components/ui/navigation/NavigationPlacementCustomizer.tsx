import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import { type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';

import { HAPPIER_DRAG_GRIP_METRICS } from '@happier-dev/plugin-ui/presentation';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { EntityFlatReorderList, EntityFlatReorderRow, entityReorderPreview, entityReorderRefused, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { type CustomModalInjectedProps } from '@/modal';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { useProfile } from '@/sync/domains/state/storage';
import { EMPTY_NAVIGATION_PLACEMENT_PREFERENCES, NavigationSurfacePlacementsV1Schema, navigationPlacementPatch, readNavigationPlacementPreferences, resolveNavigationPlacements, reorderNavigationPlacement, updateNavigationPlacement, type DetailNavigationAddress, type NavigationDefaultPlacement, type NavigationPlacementAddress, type NavigationPlacementPolicy, type NavigationPlacementPreferences, type NavigationSurfaceId, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';
import { SegmentedTabBar } from './SegmentedTabBar';
import { useDetailPageTabsPosition, useDetailPageTabsPositionActionWriter, useNavigationSurfacePlacement, useNavigationSurfacePlacementActionWriter } from './useNavigationSurfacePlacement';

export type NavigationPlacementItem = NavigationPlacementPolicy & Readonly<{
    id: string;
    title: string;
    icon?: IconName;
    group?: string;
    placementNote?: string;
    /** The one repair the note leads to, written as words ending it (a link into the setting that fixes it). */
    placementNoteAction?: Readonly<{ label: string; onPress: () => void }>;
}>;

/** A control the surface always shows: listed for completeness, outside reorder and placement. */
export type NavigationPlacementFixedItem = Pick<NavigationPlacementItem, 'id' | 'title' | 'icon' | 'placementNote'>;

type CustomizerProps = Readonly<{
    surfaceId: NavigationSurfaceId;
    /** An addressed detail section uses the same editor and sparse settings writer. */
    address?: NavigationPlacementAddress;
    items: readonly NavigationPlacementItem[];
    testID?: string;
    /** The surface's own words for its placements (the composer says Shown / In + / Hidden). */
    placementLabels?: Readonly<Partial<Record<NavigationDefaultPlacement, string>>>;
    /** The surface's own one-sentence purpose; defaults to the shared navigation description. */
    description?: string;
    fixedItems?: readonly NavigationPlacementFixedItem[];
    /** The group to open at (the + opener's own context); the full grouped catalog stays listed. */
    activeGroup?: string;
    renderPreview?: (preferences: NavigationPlacementPreferences) => React.ReactNode;
}>;

type PlacementSection = Readonly<{ title: string | undefined; items: readonly NavigationPlacementItem[] }>;

/**
 * One section per context group, in the order the surface lists its groups (the catalog order), each holding its
 * items in the person's saved order. Items without a group form one untitled section.
 */
function groupPlacementSections(catalog: readonly NavigationPlacementItem[], ordered: readonly NavigationPlacementItem[]): readonly PlacementSection[] {
    const sections = new Map<string | undefined, NavigationPlacementItem[]>(catalog.map(item => [item.group, []]));
    for (const item of ordered) sections.get(item.group)?.push(item);
    return [...sections].map(([title, items]) => ({ title, items })).filter(section => section.items.length > 0);
}

/** Brings the opener's own group into view once, when the customizer first shows (web; native opens at the top of its scroll). */
function useRevealActiveGroup(activeGroup: string | undefined) {
    const ref = React.useRef<View>(null);
    React.useEffect(() => {
        if (activeGroup === undefined || Platform.OS !== 'web') return;
        // After the card's open layout, so the scroller measures the grouped list at its full height.
        const frame = requestAnimationFrame(() => {
            (ref.current as unknown as { scrollIntoView?: (options: Readonly<{ block: 'start' }>) => void } | null)?.scrollIntoView?.({ block: 'start' });
        });
        return () => cancelAnimationFrame(frame);
    }, [activeGroup]);
    return ref;
}

const BASE_PLACEMENTS = ['pinned', 'overflow', 'hidden'] as const;

/** Modal-bound preferences remain live when a settings Action changes the same device. */
export function NavigationPlacementCustomizer(props: CustomizerProps & CustomModalInjectedProps) {
    const owner = useNavigationSurfacePlacement(props.address ?? props.surfaceId);
    const placementsBySurface = useLocalSetting('navigationSurfacePlacementsV1');
    const setPreferences = useNavigationSurfacePlacementActionWriter(props.address ?? props.surfaceId);
    const profile = useProfile();
    const home = useActiveServerSnapshot();
    const scope = React.useMemo(() => home.serverId && profile.id ? { serverId: home.serverId, accountId: profile.id } : null, [home.serverId, profile.id]);
    const footer = React.useMemo(() => <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <RoundButton testID={`${props.testID ?? 'navigation-placement-customizer'}.reset`} title={t('navigationPlacement.reset')} display="secondary" size="small" onPress={() => { void setPreferences({ orderedIds: [], placements: {} }); }} />
        <RoundButton title={t('common.done')} size="small" onPress={props.onClose} />
    </View>, [setPreferences, props.onClose, props.testID]);
    React.useEffect(() => {
        props.setChrome?.({ kind: 'card', title: t(`navigationPlacement.${props.surfaceId}`), subtitle: props.description ?? t('navigationPlacement.description'),
            scrollHost: 'body', bodyScroll: 'none', phonePresentation: 'sheet', footer, dimensions: { size: 'lg' } });
    }, [footer, props.setChrome, props.surfaceId, props.description]);
    return <NavigationPlacementCustomizerView {...props} scope={scope} preferences={owner.preferences}
        placementsBySurface={placementsBySurface} onChange={setPreferences} showHeader={false} />;
}

type PlacementRowsProps = Readonly<{
    /** Drag identity: one surface's rows never accept a row from another list. */
    dragSurfaceId: string;
    address: NavigationPlacementAddress;
    items: readonly NavigationPlacementItem[];
    fixedItems?: readonly NavigationPlacementFixedItem[];
    placementLabels?: Readonly<Partial<Record<NavigationDefaultPlacement, string>>>;
    activeGroup?: string;
    /** The section's own heading, carried by its first sheet (an addressed detail section). */
    heading?: Readonly<{ title: string; description?: React.ReactNode; action?: React.ReactNode;
        /** The surface itself at static props, framed at the top of the section's own sheet. */
        preview?: React.ReactNode }>;
    /** Group ids the surface names in words (a rail's groups); a group without a name stays untitled. */
    groupTitles?: Readonly<Record<string, string>>;
    preferences: NavigationPlacementPreferences;
    onChange: (preferences: NavigationPlacementPreferences) => void | Promise<boolean>;
    scope?: EntityDragScopeV1 | null;
    testID: string;
}>;

/** A reserved primary destination (Overview, Steps, Map): its placement policy admits only the bar. */
function isReservedPrimary(item: Readonly<{ allowedPlacements?: readonly string[] }>): boolean {
    return item.allowedPlacements !== undefined && item.allowedPlacements.length === 1 && item.allowedPlacements[0] === 'pinned';
}

/** The one locked affordance for a place that cannot change: a fixed control or a reserved primary destination. */
function PlacementLock(props: Readonly<{ testID: string }>) {
    const { theme } = useUnistyles();
    return <View testID={props.testID} style={LOCK_STYLE} accessible accessibilityLabel={t('navigationPlacement.always')}>
        <Icon name="lock" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
        <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>{t('navigationPlacement.always')}</Text>
    </View>;
}

/** One placement list: its groups as sheets, each row a placement choice with its reorder handle. */
function PlacementRows(props: PlacementRowsProps) {
    const { theme } = useUnistyles();
    const testID = props.testID;
    const activeGroupRef = useRevealActiveGroup(props.activeGroup);
    const placements = resolveNavigationPlacements(props.items, props.preferences);
    const sections = groupPlacementSections(props.items, placements.ordered);
    // Reading order, one reorder list: a move stays inside its own group, so the page shows what the row does.
    const items = sections.flatMap(section => section.items);
    const groupIdsOf = (id: string) => (sections.find(section => section.items.some(item => item.id === id))?.items ?? []).map(item => item.id);
    const grouped = sections.some(section => section.title !== undefined);
    // Titles align down the list: when any row has a glyph, a row without one keeps the glyph's column.
    const hasGlyphColumn = items.some(item => item.icon) || (props.fixedItems ?? []).some(item => item.icon);
    // A fixed row has no handle: it keeps the handle's column, at the grip density the reorder rows draw.
    const fixedRowHandleInset = HAPPIER_DRAG_GRIP_METRICS[useHoverCapablePrimaryPointer() ? 'pointer' : 'touch'].box + LEADING_STYLE.gap;
    const binding: EntityFlatReorderBinding = {
        scope: props.scope ?? null,
        kind: 'navigation-item',
        items,
        getItem: id => props.scope && items.some(item => item.id === id)
            ? { kind: 'navigation-item', scope: props.scope, surfaceId: props.dragSurfaceId, itemId: id } : null,
        getSourceId: item => item.kind === 'navigation-item' && item.surfaceId === props.dragSurfaceId ? item.itemId : null,
        resolve: (sourceId, position) => {
            const ids = groupIdsOf(sourceId);
            if (position.anchorId !== null && !ids.includes(position.anchorId)) return entityReorderRefused('same-position');
            const moved = resolveAnchoredListMoveV1(ids, sourceId, position);
            if (!moved || moved.every((id, index) => id === ids[index])) return entityReorderRefused('same-position');
            // The saved order stays one list across every group; the move only relocates this row beside its anchor.
            const next = reorderNavigationPlacement(props.preferences, placements.ordered.map(item => item.id), sourceId, position);
            if (!next) return entityReorderRefused('reorder_target_gone');
            return { status: 'allowed', effect: { actionId: 'settings.set', input: {
                anchor: 'appearance.navigationPlacements', value: navigationPlacementPatch(props.address, next),
            }, preview: entityReorderPreview(position, items) } };
        },
        execute: async effect => {
            const input = effect.input;
            if (effect.actionId !== 'settings.set' || !input || typeof input !== 'object' || Array.isArray(input) || !('anchor' in input) || input.anchor !== 'appearance.navigationPlacements') {
                return { status: 'refused', reason: { code: 'invalid_navigation_placement', message: t('entityDragDrop.reasons.gone') } };
            }
            const parsed = NavigationSurfacePlacementsV1Schema.safeParse('value' in input ? input.value : undefined);
            const next = parsed.success ? readNavigationPlacementPreferences(parsed.data, props.address) : null;
            if (!next) return { status: 'refused', reason: { code: 'invalid_navigation_placement', message: t('entityDragDrop.reasons.gone') } };
            const applied = await props.onChange(next);
            return applied === false
                ? { status: 'refused', reason: { code: 'navigation_placement_not_applied', message: t('errors.operationFailed') } }
                : { status: 'applied' };
        },
    };
    const fixedRows = props.fixedItems?.map(item => <Item key={item.id} testID={`${testID}.fixed:${item.id}`} title={item.title} subtitle={item.placementNote}
        // No handle: the glyph keeps the reorderable rows' column.
        leftElement={<View style={[LEADING_STYLE, { paddingLeft: fixedRowHandleInset }]}>
            {item.icon ? <Icon name={item.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
                : hasGlyphColumn ? <View style={GLYPH_SLOT_STYLE} /> : null}
        </View>}
        rightElement={<PlacementLock testID={`${testID}.locked:${item.id}`} />}
        showChevron={false} />);
    // A fixed control leads a headed section (the reserved primary destination comes first).
    const fixedFirst = props.heading !== undefined;
    return <EntityFlatReorderList binding={binding} testID={`${testID}.reorder`} alwaysOrganizing>
        {sections.map((section, index) => {
            const heading = index === 0 ? props.heading : undefined;
            const groupTitle = section.title === undefined ? undefined : props.groupTitles?.[section.title] ?? (props.groupTitles ? undefined : section.title);
            const title = heading?.title ?? groupTitle;
            return <View key={section.title ?? ''} ref={section.title !== undefined && section.title === props.activeGroup ? activeGroupRef : undefined}>
            <ItemGroup testID={section.title === undefined ? undefined : `${testID}.group:${section.title}`} title={title}
                description={heading?.description} action={heading?.action}
                // A group heading sits on the card's text edge, where the description and the preview start.
                headerStyle={title === undefined ? undefined : { paddingHorizontal: theme.space.s16 }}>
                {index === 0 && heading?.preview ? <View testID={`${testID}.preview`} style={{ paddingHorizontal: theme.space.s16,
                    paddingVertical: theme.space.s12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.subtle }}>
                    {heading.preview}
                </View> : null}
                {fixedFirst && index === 0 ? fixedRows : null}
                {section.items.map(item => <EntityFlatReorderRow key={item.id} id={item.id}>
                    {({ renderHandle }) => isReservedPrimary(item) ? <Item testID={`${testID}.reserved:${item.id}`} title={item.title}
                        subtitle={item.placementNote}
                        // A destination that can only stay on the bar: its siblings' row, with the fixed rows' lock.
                        leftElement={<View style={LEADING_STYLE}>
                            {renderHandle(`${testID}.move:${item.id}`)}
                            {item.icon ? <Icon name={item.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
                                : hasGlyphColumn ? <View style={GLYPH_SLOT_STYLE} /> : null}
                        </View>}
                        rightElement={<PlacementLock testID={`${testID}.locked:${item.id}`} />}
                        showChevron={false} /> : <SegmentedChoiceItem title={item.title}
                        // What this row means beyond its placement: a lock, a field slot, a temporary return.
                        subtitle={item.placementNote}
                        subtitleLines={item.placementNoteAction ? 0 : undefined}
                        subtitleAccessory={item.placementNoteAction
                            ? <TextLinkButton testID={`${testID}.note-action:${item.id}`} size="meta" label={item.placementNoteAction.label}
                                onPress={item.placementNoteAction.onPress} />
                            : undefined}
                        // The handle, then the destination's own glyph, so each row reads as the rail item it places.
                        leftElement={<View style={LEADING_STYLE}>
                            {renderHandle(`${testID}.move:${item.id}`)}
                            {item.icon ? <Icon name={item.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
                                : hasGlyphColumn ? <View style={GLYPH_SLOT_STYLE} /> : null}
                        </View>}
                        value={item.defaultPlacement === 'auto' && props.preferences.placements[item.id] === undefined
                            ? 'auto' : placements.effectivePlacements[item.id] ?? 'pinned'}
                        // Every row offers the same segments, so the columns line up; a placement this item
                        // cannot take stays visible and disabled, explained by its note.
                        options={([
                            ...(item.defaultPlacement === 'auto' ? ['auto' as const] : []),
                            ...BASE_PLACEMENTS,
                        ]).map(id => ({
                            id,
                            label: props.placementLabels?.[id] ?? t(`navigationPlacement.${id}`),
                            disabled: id !== 'auto' && item.allowedPlacements !== undefined && !item.allowedPlacements.includes(id),
                        }))}
                        testIDPrefix={`${testID}.placement:${item.id}`}
                        onChange={placement => props.onChange(updateNavigationPlacement(props.preferences, item.id, placement))} />}
                </EntityFlatReorderRow>)}
                {grouped || fixedFirst ? null : fixedRows}
            </ItemGroup>
            </View>;
        })}
        {grouped && !fixedFirst && fixedRows ? <ItemGroup>{fixedRows}</ItemGroup> : null}
    </EntityFlatReorderList>;
}

/** The same real controls with a controlled specimen boundary, so captures never write an Account. */
export function NavigationPlacementCustomizerView(props: CustomizerProps & Readonly<{
    preferences: NavigationPlacementPreferences;
    placementsBySurface?: NavigationSurfacePlacementsV1;
    onChange: (preferences: NavigationPlacementPreferences) => void | Promise<boolean>;
    scope?: EntityDragScopeV1 | null;
    showHeader?: boolean;
}>) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'navigation-placement-customizer';
    // The surface itself at static props stays above the scrolling rows, so opening at a group
    // (or scrolling the catalog) never carries the picture of what the rows change out of view.
    return <View style={PINNED_COLUMN_STYLE}>
        {props.renderPreview ? <View testID={`${testID}.preview`} style={{ paddingHorizontal: theme.space.s16, paddingTop: theme.space.s8, paddingBottom: theme.space.s8, flexShrink: 0 }}>
            {props.renderPreview(props.preferences)}
        </View> : null}
    <ItemList testID={testID}>
        {props.showHeader !== false ? <PageHeader title={t(`navigationPlacement.${props.surfaceId}`)} description={props.description ?? t('navigationPlacement.description')} /> : null}
        <PlacementRows dragSurfaceId={props.surfaceId} address={props.address ?? props.surfaceId} items={props.items}
            fixedItems={props.fixedItems} placementLabels={props.placementLabels} activeGroup={props.activeGroup}
            preferences={props.preferences} onChange={props.onChange} scope={props.scope} testID={testID} />
    </ItemList>
    </View>;
}

export type DetailNavigationDevice = 'desktop' | 'phone';

/** One addressed placement list of a detail page kind: desktop Pages or Companions, or the phone's items. */
export type DetailNavigationCustomizerSection = Readonly<{
    id: string;
    address: DetailNavigationAddress;
    title: string;
    description?: string;
    items: readonly NavigationPlacementItem[];
    fixedItems?: readonly NavigationPlacementFixedItem[];
    placementLabels?: Readonly<Partial<Record<NavigationDefaultPlacement, string>>>;
    groupTitles?: Readonly<Record<string, string>>;
    /** The surface itself at static props, drawn under the section heading. */
    renderPreview?: (preferences: NavigationPlacementPreferences) => React.ReactNode;
}>;

export type DetailNavigationCustomizerProps = Readonly<{
    /** Placement identity of the page kind (`session`); never an entity id. */
    pageKind: string;
    /** The page kind's name as people read it (Session). */
    pageTitle: string;
    /** The device class the opener stands on; the other stays one choice away. */
    device: DetailNavigationDevice;
    desktop: readonly DetailNavigationCustomizerSection[];
    phone: readonly DetailNavigationCustomizerSection[];
    /** Cockpit phones can keep page tabs at the top as a scrolling strip. */
    phonePageTabs?: boolean;
    testID?: string;
}>;

/**
 * The page kind's one customizer (plan T): Desktop / Phone, then each addressed list with its own
 * Reset, and the phone page-tab position. Every edit is one device-local `settings.set`.
 */
export function DetailNavigationCustomizer(props: DetailNavigationCustomizerProps & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'detail-navigation-customizer';
    const [device, setDevice] = React.useState<DetailNavigationDevice>(props.device);
    const profile = useProfile();
    const home = useActiveServerSnapshot();
    const scope = React.useMemo(() => home.serverId && profile.id ? { serverId: home.serverId, accountId: profile.id } : null, [home.serverId, profile.id]);
    const footer = React.useMemo(() => <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <RoundButton testID={`${testID}.done`} title={t('common.done')} size="small" onPress={props.onClose} />
    </View>, [props.onClose, testID]);
    React.useEffect(() => {
        props.setChrome?.({ kind: 'card', title: t('navigationPlacement.detailTitle', { name: props.pageTitle }),
            subtitle: t('navigationPlacement.detailDescription'),
            scrollHost: 'body', bodyScroll: 'none', phonePresentation: 'sheet', footer, dimensions: { size: 'lg' } });
    }, [footer, props.setChrome, props.pageTitle]);
    const deviceTabs = React.useMemo(() => [
        { id: 'desktop' as const, label: t('navigationPlacement.desktop'), icon: <Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> },
        { id: 'phone' as const, label: t('navigationPlacement.phone'), icon: <Icon name="device-mobile" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> },
    ], [theme.colors.text.secondary]);
    const sections = device === 'desktop' ? props.desktop : props.phone;
    return <View style={PINNED_COLUMN_STYLE} testID={testID}>
        {/* Which device's places are being edited stays above the scrolling lists. */}
        <View style={{ paddingHorizontal: theme.space.s16, paddingTop: theme.space.s8, paddingBottom: theme.space.s8, flexShrink: 0 }}>
            <SegmentedTabBar tabs={deviceTabs} activeTabId={device} onSelectTab={setDevice} iconPlacement="leading"
                accessibilityLabel={t('navigationPlacement.deviceLabel')} testIDPrefix={`${testID}.device`} />
        </View>
        {/* Keyed by device: switching device opens the other list at its top. */}
        <ItemList key={device} testID={`${testID}.${device}`}>
            {sections.map(section => <DetailPlacementSection key={`${device}:${section.id}`} section={section}
                dragSurfaceId={`${props.pageKind}.${device}.${section.id}`} scope={scope} testID={`${testID}.${section.id}`} />)}
            {device === 'phone' && props.phonePageTabs ? <DetailPageTabsPosition pageKind={props.pageKind} testID={`${testID}.pageTabs`} /> : null}
        </ItemList>
    </View>;
}

function DetailPlacementSection(props: Readonly<{ section: DetailNavigationCustomizerSection; dragSurfaceId: string;
    scope: EntityDragScopeV1 | null; testID: string }>) {
    const { section } = props;
    const owner = useNavigationSurfacePlacement(section.address);
    const write = useNavigationSurfacePlacementActionWriter(section.address);
    const reset = React.useCallback(() => { void write(EMPTY_NAVIGATION_PLACEMENT_PREFERENCES); }, [write]);
    return <>
        <PlacementRows dragSurfaceId={props.dragSurfaceId} address={section.address} items={section.items}
            fixedItems={section.fixedItems} placementLabels={section.placementLabels} groupTitles={section.groupTitles}
            heading={{ title: section.title, description: section.description,
                ...(section.renderPreview ? { preview: section.renderPreview(owner.preferences) } : {}),
                action: <TextLinkButton testID={`${props.testID}.reset`} size="meta" label={t('navigationPlacement.reset')} onPress={reset} /> }}
            preferences={owner.preferences} onChange={write} scope={props.scope} testID={props.testID} />
    </>;
}

/** Cockpit phones only: page tabs at the bottom with the tools, or in a scrolling strip at the top. */
function DetailPageTabsPosition(props: Readonly<{ pageKind: string; testID: string }>) {
    const { theme } = useUnistyles();
    const position = useDetailPageTabsPosition(props.pageKind);
    const write = useDetailPageTabsPositionActionWriter(props.pageKind);
    // The heading stands on the card's text edge, as the placement sections' headings do.
    return <ItemGroup title={t('navigationPlacement.pageTabsTitle')} description={t('navigationPlacement.pageTabsDescription')}
        headerStyle={{ paddingHorizontal: theme.space.s16 }}>
        <SegmentedChoiceItem title={t('navigationPlacement.pageTabsRow')} value={position} testIDPrefix={props.testID}
            accessoryLayout="adaptive"
            options={[{ id: 'bottom', label: t('navigationPlacement.pageTabsBottom') }, { id: 'top', label: t('navigationPlacement.pageTabsTop') }]}
            onChange={next => { void write(next); }} />
    </ItemGroup>;
}

const PINNED_COLUMN_STYLE = { flex: 1, minHeight: 0 } as const;

const LEADING_STYLE = { flexDirection: 'row', alignItems: 'center', gap: 8 } as const;
const GLYPH_SLOT_STYLE = { width: ICON_SIZE.md, height: ICON_SIZE.md } as const;
const LOCK_STYLE = { flexDirection: 'row', alignItems: 'center', gap: 4 } as const;
