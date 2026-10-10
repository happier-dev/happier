import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { EmptySlot } from '@/components/ui/empty/EmptySlot';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { findWidgetLayoutItemV1, flattenWidgetLayoutWidgetsV1, getWidgetLayoutItemIdV1, normalizeWidgetSizeForSurfaceV1, resolveWidgetSizeChoicesV1, supportsWidgetGroupsV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetLayoutGroupV1, type WidgetLayoutItemV1, type WidgetPlacementV1, type WidgetSurfaceRefV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { WidgetGroupFrame, type WidgetGroupChildPlacement } from '@/components/widgets/group/WidgetGroupFrame';
import { WidgetGroupMenuButton } from '@/components/widgets/group/WidgetGroupMenuButton';
import { WidgetGroupBar } from '@/components/widgets/group/WidgetGroupBar';
import { buildWidgetGroupMembershipActions, describeWidgetGroup, resolveWidgetGroupChildSizeLimit, type WidgetGroupOperations } from '@/components/widgets/group/widgetGroupMenu';
import { describeWidgetGroupContext, readWidgetGroupFollowedValue, widgetGroupFollowSource, widgetGroupPinnedSource, widgetGroupSurfaceContext } from '@/components/widgets/group/widgetGroupInputs';
import { resolveWidgetGroupCells, resolveWidgetGroupColumns } from '@/components/widgets/group/widgetGroupLayout';
import { resolveWidgetGroupPointerDestination, widgetGroupDropTarget, widgetLayoutCardDropTarget } from '@/components/widgets/group/widgetGroupDropTarget';
import { WidgetGroupDropFeedback } from '@/components/widgets/group/WidgetGroupDropFeedback';
import { WidgetGroupMembershipArrivalView, useWidgetGroupMembershipArrivals } from '@/components/widgets/group/widgetGroupMembershipArrival';
import { useWidgetGroupMenu } from '@/components/widgets/group/useWidgetGroupMenu';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType } from '@/utils/platform/responsive';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetAddSurface } from '@/components/widgets/add/WidgetAddSurface';
import { useAccountWidgetAddSections, type AccountWidgetSurfaceLabels } from '@/components/widgets/add/accountWidgetAddSections';
import { WidgetFrame, type WidgetFramePlacement } from '@/components/widgets/frame/WidgetFrame';
import {
    buildWidgetDefinitionActions,
    buildWidgetFrameStyleActions,
    buildWidgetInstanceActions,
    buildWidgetMoveActions,
    buildWidgetSizeActions,
    orderWidgetMenu,
    WIDGET_MENU_MAX_HEIGHT_PX,
} from '@/components/widgets/frame/widgetFrameMenu';
import { WIDGET_FRAME_PLACEMENT_DEFAULTS, resolveWidgetFrameStyle } from '@/components/widgets/frame/widgetFrameStyle';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { WidgetFrameBodyCaptionContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { WidgetFrameBodyActionsContext } from '@/components/widgets/frame/widgetFrameBodyActions';
import { useWidgetDefinitionFlows } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { runAcknowledgedWidgetSetupCommand, widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';
import { useIsNearViewport, type NearViewportSpan } from '@/components/widgets/nearViewport';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useWidgetMovementAdmission } from '@/components/widgets/surface/useWidgetMovementAdmission';
import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityFeedback, SessionSurfaceEntityTargetFeedback, useSessionSurfaceCarriedStyle, useSessionSurfaceEntityDrag, useSessionSurfaceGeometryRefresh } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { resolveEntityFlatRowPosition } from '@/components/ui/treeDragDrop/geometry/entityFlatListStrategy';
import { resolveWidgetAreaEntityDrop } from './widgetAreaEntityDrop';
import type { EntityDropEffectV1, EntityDropAdmissionV1 } from '@happier-dev/protocol/plugins/ui';

import { useWidgetAreaLayout, type WidgetAreaLayout, type WidgetAreaPort, type WidgetAreaWriteOutcome } from './useWidgetAreaLayout';
import { renderWidgetSizeMenuSection, stepWidgetSizeControl, type WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';

type WidgetAreaWrite = WidgetAreaLayout<WidgetSurfaceContext>['write'];

/**
 * How an area lays its widgets out (lab `dashboards` dlayout Q8): a plugin page area is Home's
 * grid — half | full, cards by default; a Project aside is a column like the Companion — order
 * only, Plain by default.
 */
export type WidgetAreaGeometry = 'grid' | 'column';

const GEOMETRY_PLACEMENT: Readonly<Record<WidgetAreaGeometry, WidgetFramePlacement>> = { grid: 'home', column: 'companion' };
/** Configuration stays in the quiet ⋯ menu; movement also has the shared grip. */
const ALWAYS_OVERFLOW = Number.POSITIVE_INFINITY;
const ADD_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);

export type WidgetAreaProps = Readonly<{
    /**
     * The area's operations, bound by the host to its identity and the page's current context;
     * `null` where the host has no area to bind (then `unavailable` says why).
     */
    port: WidgetAreaPort | null;
    /** What the page fills on its own ("This page", "This project", "This checkout"). */
    context: WidgetSurfaceContext;
    /** Two Project areas/phone projection share the host's single acknowledged document read. */
    layout?: WidgetAreaLayout<WidgetSurfaceContext>;
    area?: 'main' | 'aside';
    /** Phone renders merged widgets once, followed by each area's existing Add control. */
    display?: 'all' | 'widgets' | 'add';
    /** A document host retains viewer-local disclosure while responsive areas remount. */
    disclosure?: Readonly<{
        collapsedByInstanceId: Readonly<Record<string, boolean>>;
        onCollapsedChange: (instanceId: string, collapsed: boolean) => void;
    }>;
    geometry: WidgetAreaGeometry;
    title: string;
    /** One quiet fact beside the title ("your widgets on this page"). */
    meta?: string;
    /** The page's or project's name: "Add to PRs & Issues", "PRs & Issues uses Card". */
    surfaceName: string;
    /** Replaces the layout state with the host's own refusal (a Project without a known source). */
    unavailable?: Readonly<{ title: string; reason?: string; reasonCode: string }>;
    /**
     * A dashboard area (lab `p-overview`): no area header; the widgets, then one dashed "Add widget" line
     * that opens the same Add surface; an area emptied by Remove keeps its place and says so quietly.
     */
    dashboard?: Readonly<{ addLabel: string; emptyTitle: string; /** The gallery says where the widget goes ("Add to Release · side area"). */ addTitle?: string }>;
    testID: string;
}>;

/**
 * One personal widget area on a page (lab `dashboards` PG/PGp, P1/P1p/P1a): its header with the one
 * Add, then the widgets in the shared frame, each mounting the shared instance body. Add, Set up,
 * Edit inputs, Rename, Width, Frame and the card states are the same owners Home uses; every change
 * is one semantic operation through the area's port, which the host admits and persists. It owns no
 * catalog, layout store or input resolver.
 */
export function WidgetArea(props: WidgetAreaProps): React.ReactElement {
    if (props.unavailable || !props.port) {
        const unavailable = props.unavailable ?? { title: t('widgetAdd.areaUnavailableTitle'), reasonCode: 'widget_area_unavailable' };
        return (
            <View testID={props.testID} style={styles.area}>
                {props.dashboard ? null : <WidgetAreaHeader title={props.title} meta={props.meta} testID={props.testID} />}
                <SurfaceStateCard
                    testID={`${props.testID}.unavailable`}
                    kind="unavailable"
                    size="line"
                    layout="inline"
                    title={unavailable.title}
                    {...(unavailable.reason ? { reason: unavailable.reason } : {})}
                    diagnosticCode={unavailable.reasonCode}
                />
            </View>
        );
    }
    return props.layout
        ? <WidgetAreaWithLayout {...props} port={props.port} layout={props.layout} />
        : <WidgetAreaUncontrolled {...props} port={props.port} />;
}

function WidgetAreaUncontrolled(props: WidgetAreaProps & Readonly<{ port: WidgetAreaPort }>): React.ReactElement {
    const document = useWidgetAreaLayout(props.port, props.context);
    const layout = React.useMemo(() => props.area && document.state.status === 'ready' && document.state.surface.owner.kind === 'project'
        ? { ...document, state: { ...document.state, placements: document.state.placements.filter(entry => (entry.area ?? 'main') === props.area) } }
        : document, [document, props.area]);
    return <WidgetAreaWithLayout {...props} layout={layout} />;
}

function WidgetAreaWithLayout(props: WidgetAreaProps & Readonly<{ port: WidgetAreaPort; layout: WidgetAreaLayout<WidgetSurfaceContext> }>): React.ReactElement {
    const { layout } = props;
    const addAnchorRef = React.useRef<View | null>(null);
    const [addOpen, setAddOpen] = React.useState(false);
    // What the last change came to, said where it belongs (never a line that pushes the area down):
    // a refused change on the card it was for, with Retry, until a later change succeeds; one held
    // for someone's approval as the header's quiet meta. A refused add stays on its gallery tile.
    const [notice, setNotice] = React.useState<AreaNotice | null>(null);
    const [organizing, setOrganizing] = React.useState(false);
    const state = layout.state;
    const ready = state.status === 'ready' ? state : null;
    const canAdd = ready?.canEdit === true;
    // Organize is where a group shows its bar (grip, name, width, ⋯): the options route of an untitled
    // group and the handle of every group, on every pointer, including a group with one remaining
    // child. Other widgets keep the existing touch DnD route.
    const hasGroup = ready?.items.some(item => item.kind === 'group'
        && (props.area === undefined || (item.area ?? 'main') === props.area)) === true;
    const canOrganize = canAdd && (hasGroup || (ready?.placements.length ?? 0) > 1 && (Platform.OS !== 'web' || readCoarsePrimaryPointer()));
    const viewer = useActiveServerAccountScope();
    const focused = useIsFocused();
    const current = ready !== null && focused && viewer?.serverId === ready.surface.serverId
        && (viewer.accountId === ready.surface.accountId || ready.admittedViewer?.serverId === viewer.serverId && ready.admittedViewer.accountId === viewer.accountId);
    const movement = useWidgetMovementAdmission(current ? ready?.surface ?? null : null, ready?.placements, props.port.movement);
    const drop = useSessionSurfaceEntityDrag(current && ready ? {
        scope: ready.surface, title: props.surfaceName, getItem: () => null, isCurrent: () => current,
        admitWidgetMovement: movement.admit, ...(props.port.movement ? { widgetMovement: props.port.movement } : {}),
        target: { acceptedKinds: ['widget-area-instance', 'home-section', 'work-board-widget', 'session-board-item', 'companion-item', 'widget-layout-group'],
            listDestinations: () => [{ destination: { anchorId: null, placement: 'after' },
                label: props.area ? t(props.area === 'main' ? 'projects.widgets.mainArea' : 'projects.widgets.sideArea') : props.surfaceName,
                group: props.surfaceName }],
            resolve: ({ item, destination }) => resolveWidgetAreaEntityDrop({ item, destination, surface: ready.surface,
                placements: ready.items, ...(movement.sourceItem ? { sourceItem: movement.sourceItem } : {}), area: props.area, canEdit: ready.canEdit, preview: { verb: t('entityDragDrop.organize.title'), target: props.surfaceName } }),
            execute: async () => ({ status: 'refused', reason: { code: 'unsupported_widget_surface', message: t('entityDragDrop.surface.widgetMoveUnavailable') } }),
        },
    } : null);
    useSessionSurfaceGeometryRefresh(drop.refresh);
    const layoutWrite = layout.write;
    const write = React.useCallback(async (operation: Parameters<WidgetAreaWrite>[0]): Promise<WidgetAreaWriteOutcome> => {
        const outcome = await layoutWrite(operation);
        setNotice(outcome.kind === 'approvalPending' ? { kind: 'pending' }
            : outcome.kind === 'refused' && 'instanceId' in operation
                ? { kind: 'failed', instanceId: operation.instanceId, retry: () => write(operation) }
                : null);
        return outcome;
    }, [layoutWrite]);
    const closeAdd = React.useCallback(() => setAddOpen(false), []);
    const organizeControl = canOrganize ? <RoundButton size="small" display="secondary" testID={`${props.testID}.organize`}
        title={t(organizing ? 'common.done' : 'entityDragDrop.organize.title')}
        onPress={() => { setOrganizing(value => !value); drop.runtime.cancel('organize-changed'); }} /> : null;

    return (
        <View ref={drop.ref} onLayout={drop.onLayout} testID={props.testID} style={styles.area}>
            {props.dashboard ? null : <WidgetAreaHeader
                title={props.title}
                meta={notice?.kind === 'pending' ? t('widgetAdd.areaApprovalPending') : props.meta}
                testID={props.testID}
                // The Add keeps its place while the layout first loads, so nothing moves on arrival.
                add={state.status === 'loading' || canAdd ? (
                    <View style={styles.header}>
                        {organizeControl}
                        <View ref={addAnchorRef} collapsable={false}>
                            <IconButton
                                testID={`${props.testID}.add`}
                                iconName="plus"
                                variant="plain"
                                accessibilityLabel={t('widgetAdd.areaAdd', { surface: props.surfaceName })}
                                minimumInteractiveTargetSize={ADD_TARGET_PX}
                                disabled={!canAdd}
                                selected={addOpen}
                                expanded={addOpen}
                                hasPopup="dialog"
                                onPress={() => setAddOpen((open) => !open)}
                            />
                        </View>
                    </View>
                ) : null}
            />}
            {props.display === 'add' ? null : state.status === 'unavailable' ? (
                <SurfaceStateCard
                    testID={`${props.testID}.unavailable`}
                    kind="unavailable"
                    size="line"
                    layout="inline"
                    title={t('widgetAdd.areaUnavailableTitle')}
                    diagnosticCode={state.reasonCode}
                />
            ) : ready && ready.placements.length === 0 && props.dashboard ? (
                <Text testID={`${props.testID}.empty`} style={styles.dashboardEmpty}>{props.dashboard.emptyTitle}</Text>
            ) : ready && ready.placements.length === 0 ? (
                <SurfaceStateCard
                    testID={`${props.testID}.empty`}
                    kind="empty"
                    size="line"
                    layout="inline"
                    title={t('widgetAdd.areaEmptyTitle')}
                    reason={t('widgetAdd.areaEmptyReason')}
                    {...(canAdd ? { action: { label: t('widgetAdd.areaEmptyAction'), onPress: () => setAddOpen(true), testID: `${props.testID}.emptyAdd` } } : {})}
                />
            ) : ready ? (
                <WidgetAreaPlacements {...props} context={ready.context} surface={ready.surface} placements={ready.placements} items={ready.items} canEdit={ready.canEdit}
                    isShared={ready.isShared} admittedViewer={ready.admittedViewer}
                    isCurrent={ready.isCurrent}
                    current={current} organizing={organizing && canOrganize} admitWidgetMovement={movement.admit} write={write}
                    movementSourceItem={movement.sourceItem}
                    failed={notice?.kind === 'failed' ? notice : null} />
            ) : null}
            {props.display !== 'widgets' && props.dashboard && (state.status === 'loading' || canAdd) ? (
                <View style={styles.header}>
                    {organizeControl}
                <View ref={addAnchorRef} collapsable={false} style={styles.grow}>
                    {/* Dashed means "add something here": the one empty slot, as the area's one quiet line. */}
                    <EmptySlot
                        testID={`${props.testID}.add`}
                        icon="plus"
                        label={props.dashboard.addLabel}
                        labelRole="row"
                        accessibilityLabel={t('widgetAdd.areaAdd', { surface: props.surfaceName })}
                        disabled={!canAdd}
                        expanded={addOpen}
                        minHeight={ADD_TARGET_PX}
                        onPress={() => setAddOpen((open) => !open)}
                    />
                </View>
                </View>
            ) : null}
            {ready ? <SessionSurfaceEntityFeedback kind="widget-area-instance" scope={ready.surface} address={null} widgetSurface={ready.surface} testID={`${props.testID}.move`} /> : null}
            <SessionSurfaceEntityTargetFeedback drag={drop} testID={props.testID} />
            {ready && addOpen ? (
                <WidgetAreaAddPopover
                    anchorRef={addAnchorRef}
                    surface={ready.surface}
                    area={props.area}
                    placements={ready.placements}
                    context={ready.context}
                    {...(props.area ? { area: props.area } : {})}
                    surfaceName={props.surfaceName}
                    {...(props.dashboard?.addTitle ? { title: props.dashboard.addTitle } : {})}
                    write={layoutWrite}
                    onRequestClose={closeAdd}
                    testID={`${props.testID}.addPopover`}
                />
            ) : null}
        </View>
    );
}

function WidgetAreaHeader(props: Readonly<{ title: string; meta?: string | undefined; add?: React.ReactNode; testID: string }>): React.ReactElement {
    return (
        <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{props.title}</Text>
            {props.meta ? <Text style={styles.meta} numberOfLines={1} testID={`${props.testID}.meta`}>{props.meta}</Text> : null}
            <View style={styles.grow} />
            {props.add ?? null}
        </View>
    );
}

type AreaNotice =
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'failed'; instanceId: string; retry: () => Promise<WidgetAreaWriteOutcome> }>;

type PlacementsProps = WidgetAreaProps & Readonly<{
    failed: Extract<AreaNotice, { kind: 'failed' }> | null;
    surface: WidgetSurfaceRefV1;
    area?: 'main' | 'aside';
    placements: readonly WidgetPlacementV1[];
    /** The layout items (widgets and groups), as read with the placements. */
    items: readonly WidgetLayoutItemV1[];
    /** The carried widget's placement on its own surface, for a group's width admission. */
    movementSourceItem?: WidgetLayoutItemV1 | undefined;
    canEdit: boolean;
    isShared: boolean;
    admittedViewer: Extract<WidgetAreaLayout<WidgetSurfaceContext>['state'], { status: 'ready' }>['admittedViewer'];
    isCurrent: () => boolean;
    current: boolean;
    organizing: boolean;
    admitWidgetMovement(effect: EntityDropEffectV1): EntityDropAdmissionV1;
    write: WidgetAreaWrite;
}>;

/** A widget as the area draws it: a top-level placement or a group's child (always plain inside). */
type AreaWidget = Readonly<{ placement: WidgetPlacementV1; size: WidgetSizeV1 | undefined; descriptor: WidgetCandidate | null }>;

function WidgetAreaPlacements(props: PlacementsProps): React.ReactElement {
    const runtime = useAppShellPluginUiProjection();
    const phone = useDeviceType() === 'phone';
    // The layout items (widgets and groups) in the host's projection: a Project column, or the phone's
    // merged order. A group goes where its first widget is placed.
    const items = React.useMemo(() => projectWidgetAreaItems(props.items, props.placements), [props.items, props.placements]);
    const widgets = React.useMemo(() => flattenWidgetLayoutWidgetsV1(items), [items]);
    const instances = React.useMemo(() => widgets.map(entry => entry.instance), [widgets]);
    const installed = React.useMemo(() => instances.flatMap(instance => {
        const candidate = readWidgetDescriptor(runtime.pluginUiProjection, instance.definition);
        return candidate ? [candidate] : [];
    }), [instances, runtime.pluginUiProjection]);
    const descriptors = useWidgetInstanceDescriptors(props.surface, instances, installed);
    const byId = React.useMemo(() => new Map(widgets.map((entry, index): [string, AreaWidget] => [entry.instance.id, {
        placement: { instance: entry.instance, ...(entry.size ? { size: entry.size } : {}), ...(entry.frameStyle ? { frameStyle: entry.frameStyle } : {}), ...(entry.area ? { area: entry.area } : {}) },
        size: normalizeWidgetSizeForSurfaceV1(props.surface.owner.kind, entry.size, descriptors[index]?.sizeDeclaration),
        descriptor: descriptors[index] ?? null,
    }])), [widgets, descriptors, props.surface.owner.kind]);
    const operations = useWidgetAreaGroupOperations(props.write, props.area);
    // A Project item moves within its own column, even in the phone's merged list: its steps, index
    // and siblings are that column's.
    const columnOf = React.useCallback((item: WidgetLayoutItemV1) => props.surface.owner.kind === 'project' ? item.area ?? 'main' : undefined,
        [props.surface.owner.kind]);
    const columns = React.useMemo(() => items.map(item => {
        const area = columnOf(item);
        const siblings = area ? items.filter(entry => columnOf(entry) === area) : items;
        return { area, index: siblings.indexOf(item), siblings,
            placements: siblings.flatMap(entry => entry.kind === 'widget' ? [byId.get(entry.instance.id)!.placement] : []) };
    }), [items, byId, columnOf]);
    const childTitle = React.useCallback((instanceId: string) => {
        const entry = byId.get(instanceId);
        return entry?.placement.instance.displayName ?? entry?.descriptor?.title ?? instanceId;
    }, [byId]);
    const renderWidget = (instanceId: string, index: number, count: number, column: (typeof columns)[number], parent?: WidgetAreaGroupChild) => {
        const entry = byId.get(instanceId)!;
        return (
            <WidgetAreaItem
                key={instanceId}
                {...props}
                failed={props.failed?.instanceId === instanceId ? props.failed : null}
                placement={parent ? { ...entry.placement, frameStyle: 'plain' } : entry.placement}
                descriptor={entry.descriptor}
                size={entry.size}
                area={column.area}
                layoutItems={items}
                movementSiblings={column.siblings}
                movementPlacements={column.placements}
                index={index}
                count={count}
                groupOperations={operations}
                childTitle={childTitle}
                {...(parent ? { parent } : {})}
            />
        );
    };
    // Ungroup fans its widgets out to their own cards; Group with merges cards into one (lab widget-groups motion).
    const arrivals = useWidgetGroupMembershipArrivals(props.items);
    const built = items.map((item, index) => item.kind === 'widget' ? renderWidget(item.instance.id, columns[index]!.index, columns[index]!.siblings.length, columns[index]!) : (
        <WidgetAreaGroup
            key={item.id}
            {...props}
            group={item}
            items={items}
            area={columns[index]!.area}
            columns={resolveWidgetGroupColumns(item.width, phone || props.geometry === 'column')}
            cells={resolveWidgetGroupCells(props.surface.owner.kind, item.children.map(child => ({ id: child.instance.id, size: byId.get(child.instance.id)?.size })))}
            descriptors={item.children.map(child => byId.get(child.instance.id)?.descriptor ?? null)}
            operations={operations}
            childTitle={childTitle}
            renderChild={(instanceId, placement) => {
                const at = item.children.findIndex(child => child.instance.id === instanceId);
                return renderWidget(instanceId, at, item.children.length, columns[index]!, { group: item, index: at, wide: placement.wide || phone });
            }}
        />
    ));
    const rendered = items.map((item, index) => {
        const id = getWidgetLayoutItemIdV1(item);
        return <WidgetGroupMembershipArrivalView key={id} arrival={arrivals.get(id)} style={styles.cell}>{built[index]}</WidgetGroupMembershipArrivalView>;
    });
    if (props.geometry === 'column') return <View style={styles.column}>{rendered}</View>;
    return (
        <CardGrid testID={`${props.testID}.grid`} columns={2}>
            {items.map((item, index) => {
                const size = item.kind === 'widget' ? byId.get(item.instance.id)?.size : undefined;
                const full = item.kind === 'group' ? item.width === 'full'
                    : !!size && getWidgetSizeFootprintV1(props.surface.owner.kind, size)?.columnSpan === 2;
                return full ? <CardGridCell key={getWidgetLayoutItemIdV1(item)} span="row">{rendered[index]}</CardGridCell> : rendered[index];
            })}
        </CardGrid>
    );
}

/** Orders layout items by the host's placement projection; items it leaves out are not drawn here. */
export function projectWidgetAreaItems(items: readonly WidgetLayoutItemV1[], placements: readonly WidgetPlacementV1[]): WidgetLayoutItemV1[] {
    const order = new Map(placements.map((placement, index) => [placement.instance.id, index]));
    return items.flatMap(item => {
        const ids = item.kind === 'widget' ? [item.instance.id] : item.children.map(child => child.instance.id);
        const at = Math.min(...ids.map(id => order.get(id) ?? Number.POSITIVE_INFINITY));
        return Number.isFinite(at) ? [{ item, at }] : [];
    }).sort((left, right) => left.at - right.at).map(entry => entry.item);
}

/** A child's place in its group, and whether its cell spans the group (room for the full follow phrase). */
type WidgetAreaGroupChild = Readonly<{ group: WidgetLayoutGroupV1; index: number; wide: boolean }>;

/** The area's group operations, each one semantic operation through the area's port. */
function useWidgetAreaGroupOperations(write: WidgetAreaWrite, area: 'main' | 'aside' | undefined): WidgetGroupOperations {
    return React.useMemo(() => ({
        setWidth: (instanceId, width) => { void write({ actionId: 'widgets.group.set', instanceId, width }); },
        setFrame: (instanceId, frameStyle) => { void write({ actionId: 'widgets.item.frame.set', instanceId, frameStyle }); },
        setDividers: (instanceId, dividers) => { void write({ actionId: 'widgets.group.set', instanceId, dividers }); },
        ungroup: instanceId => { void write({ actionId: 'widgets.group.ungroup', instanceId }); },
        remove: instanceId => { void write({ actionId: 'widgets.item.remove', instanceId }); },
        move: (instanceId, toIndex, groupId) => { void write({ actionId: 'widgets.item.move', instanceId, toIndex, groupId, ...(area ? { area } : {}) }); },
        create: instanceIds => { void write({ actionId: 'widgets.group.create', groupId: randomUUID(), instanceIds: [...instanceIds] }); },
    }), [area, write]);
}

/** One group in an area: the shared group frame, its ⋯, Inputs…, Save group and drop target. */
function WidgetAreaGroup(props: PlacementsProps & Readonly<{
    group: WidgetLayoutGroupV1;
    items: readonly WidgetLayoutItemV1[];
    area: 'main' | 'aside' | undefined;
    columns: 1 | 2;
    cells: ReturnType<typeof resolveWidgetGroupCells>;
    descriptors: readonly (WidgetCandidate | null)[];
    operations: WidgetGroupOperations;
    childTitle: (instanceId: string) => string;
    renderChild: (instanceId: string, placement: WidgetGroupChildPlacement) => React.ReactNode;
}>) {
    const { group, write } = props;
    const hover = useRowActionHoverHost();
    const testID = `${props.testID}.group.${group.id}`;
    const name = describeWidgetGroup(group, props.childTitle);
    const menu = useWidgetGroupMenu({
        group, childTitle: props.childTitle, candidates: props.descriptors, scope: props.canEdit ? props.surface : null, context: props.context,
        operations: props.operations, showWidth: props.columns === 2 || group.width === 'half', testID,
        rename: props.canEdit ? async (title) => {
            const outcome = await write({ actionId: 'widgets.item.rename', instanceId: group.id, displayName: title ?? null });
            if (outcome.kind === 'refused') throw new Error(outcome.errorCode);
        } : undefined,
        setInputs: props.canEdit ? (bindings: WidgetInputBindingsV1) => write({ actionId: 'widgets.group.inputs.set', instanceId: group.id, bindings })
            .then(outcome => { if (outcome.kind === 'refused') throw new Error(outcome.errorCode); }) : undefined,
    });
    // The whole group lifts by its grip and is a drop target: into it, or beside it (lab wgdnd B).
    const drop = useSessionSurfaceEntityDrag(props.current && props.canEdit ? {
        scope: props.surface, title: name, isCurrent: () => props.current && props.canEdit,
        getItem: () => props.items.some(item => item.kind === 'group' && item.id === group.id) ? { kind: 'widget-layout-group',
            scope: { serverId: props.surface.serverId, accountId: props.surface.accountId }, ref: { surface: props.surface, instanceId: group.id } } : null,
        admitWidgetMovement: props.admitWidgetMovement, ...(props.port?.movement ? { widgetMovement: props.port.movement } : {}),
        getWidgetAreaTarget: () => ({ surface: props.surface, area: props.area, groupId: null, itemId: group.id,
            itemIds: props.items.filter(item => props.surface.owner.kind !== 'project' || (item.area ?? 'main') === (props.area ?? 'main')).map(getWidgetLayoutItemIdV1) }),
        pointerDestination: (bounds, pointer) => resolveWidgetGroupPointerDestination(group.id, bounds, pointer),
        target: widgetGroupDropTarget({ surface: props.surface, items: props.items, group, name, area: props.area, canEdit: props.canEdit,
            describeGroup: entry => describeWidgetGroup(entry, props.childTitle),
            sourceItem: props.movementSourceItem }),
    } : null);
    const carriedStyle = useSessionSurfaceCarriedStyle(drop);
    // The handle belongs to the bar: in view mode a hover pointer lifts the group by its header.
    const grip = props.current && props.canEdit && props.organizing ? <SessionSurfaceEntityDragHandle drag={drop} title={name} testID={`${testID}.move`} /> : null;
    // "add one" in the empty slot opens this area's Add aimed at the group.
    const slotAnchorRef = React.useRef<View | null>(null);
    const [slotAddOpen, setSlotAddOpen] = React.useState(false);
    const source = describeWidgetGroupContext(group.context);
    return (
        <View style={styles.cell} {...hover.hoverProps}>
            <WidgetGroupFrame
                testID={testID}
                group={group}
                placement={GEOMETRY_PLACEMENT[props.geometry]}
                cells={props.cells}
                columns={props.columns}
                customizing={props.organizing}
                {...(props.organizing && props.canEdit ? { bar: <WidgetGroupBar input={menu.menuInput} onRename={menu.commitName} anchorRef={menu.anchorRef} grip={grip} testID={`${testID}.bar`} /> } : {})}
                {...(props.canEdit ? { onAddToGroup: () => setSlotAddOpen(true), addAnchorRef: slotAnchorRef } : {})}
                title={props.organizing && props.canEdit ? null : group.title !== undefined || menu.renameField ? menu.renameField ?? group.title ?? null : null}
                source={source ? widgetGroupPinnedSource(source) : undefined}
                menu={props.canEdit && !props.organizing ? <WidgetGroupMenuButton input={menu.menuInput} visible={hover.isHovered} anchorRef={menu.anchorRef} testID={`${testID}.menu`} /> : null}
                accessibilityLabel={t('widgetFrame.groupA11y', { name })}
                renderChild={props.renderChild}
                dropRef={drop.ref}
                carriedStyle={carriedStyle}
                onDropLayout={drop.onLayout}
                dropFeedback={<WidgetGroupDropFeedback drag={drop} group={group} surface={props.surface} testID={`${testID}.drop`} />}
            />
            {menu.overlays}
            {slotAddOpen ? (
                <WidgetAreaAddPopover anchorRef={slotAnchorRef} surface={props.surface} {...(props.area ? { area: props.area } : {})} placements={props.placements}
                    context={props.context} surfaceName={props.surfaceName} groupId={group.id} write={write}
                    onRequestClose={() => setSlotAddOpen(false)} testID={`${testID}.slotAdd`} />
            ) : null}
        </View>
    );
}

const WidgetAreaItem = React.memo(function WidgetAreaItem(props: PlacementsProps & Readonly<{
    placement: WidgetPlacementV1;
    descriptor: WidgetCandidate | null;
    size: WidgetSizeV1 | undefined;
    index: number;
    count: number;
    movementPlacements: readonly WidgetPlacementV1[];
    /** The area's layout items, for the group entries in this widget's ⋯. */
    layoutItems: readonly WidgetLayoutItemV1[];
    /** The items in this widget's own column (a Project's main or side area), in order. */
    movementSiblings: readonly WidgetLayoutItemV1[];
    groupOperations: WidgetGroupOperations;
    childTitle: (instanceId: string) => string;
    /** Inside a group: drawn plain, no frame entry, moves within the group, follows the group's value. */
    parent?: WidgetAreaGroupChild;
}>) {
    const { placement, surface, write, context, geometry } = props;
    const instance = placement.instance;
    const [localCollapsed, setLocalCollapsed] = React.useState(() => instance.definition.kind === 'builtin' && instance.definition.id === 'project_readme');
    const collapsed = props.disclosure?.collapsedByInstanceId[instance.id] ?? localCollapsed;
    const onCollapsedChange = (next: boolean) => props.disclosure
        ? props.disclosure.onCollapsedChange(instance.id, next) : setLocalCollapsed(next);
    const testID = `${props.testID}.widget.${instance.id}`;
    const runtime = useAppShellPluginUiProjection();
    const candidate = props.descriptor;
    const size = props.size;
    const widgetPresentation = React.useMemo(() => size ? { size, footprint: getWidgetSizeFootprintV1(surface.owner.kind, size)! } : undefined,
        [size, surface.owner.kind]);
    const frameStyle = resolveWidgetFrameStyle({ placement: GEOMETRY_PLACEMENT[geometry], override: placement.frameStyle ?? null });
    const providedContext = React.useMemo(() => widgetProvidedContext(context), [context]);
    const focused = useIsFocused();
    const hover = useRowActionHoverHost();
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const sectionRef = React.useRef<View | null>(null);
    const latestMeasurement = React.useRef<Promise<NearViewportSpan | null> | null>(null);
    const [span, setSpan] = React.useState<NearViewportSpan | null>(null);
    const near = useIsNearViewport(tracker, span);
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const active = props.current && focused && near;
    const measure = React.useCallback(() => {
        if (!tracker) return;
        const node = sectionRef.current;
        const measurement = tracker.measureSpan(node);
        latestMeasurement.current = measurement;
        void measurement.then(next => {
            if (latestMeasurement.current !== measurement || sectionRef.current !== node) return;
            setSpan(current => current?.top === next?.top && current?.height === next?.height ? current : next);
        });
    }, [tracker]);
    React.useEffect(() => {
        if (!tracker) return;
        let revision = tracker.getLayoutRevision();
        measure();
        const unsubscribe = tracker.subscribe(() => {
            const next = tracker.getLayoutRevision();
            if (next === revision) return;
            revision = next;
            measure();
        });
        return () => { unsubscribe(); latestMeasurement.current = null; };
    }, [measure, tracker, focused, instance.id]);
    const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        setBodyHeight(current => current === height ? current : height);
    }, []);
    const parent = props.parent;
    const groupContext = parent?.group.context;
    const itemContext = React.useMemo(() => widgetGroupSurfaceContext(context, groupContext), [context, groupContext]);
    const bindingLabel = useWidgetInstanceBindingLabel(instance, candidate, itemContext);
    const followed = readWidgetGroupFollowedValue(instance, groupContext);
    // The body may name what it shows; a followed group value still wins the source slot.
    const [bodyCaption, setBodyCaption] = React.useState<string | null>(null);
    // The body may also lend the entries that act on what it shows; the frame's ⋯ stays the one menu.
    const [bodyActions, setBodyActions] = React.useState<readonly ItemAction[] | null>(null);
    const supportsGroups = supportsWidgetGroupsV1(surface.owner.kind);

    const saveInputs = React.useCallback((bindings: WidgetInstanceV1['bindings']) => runAcknowledgedWidgetSetupCommand(
        () => write({ actionId: 'widgets.item.inputs.set', instanceId: instance.id, bindings }),
        t('widgetAdd.saveFailed'),
    ), [instance.id, write]);
    const edit = useWidgetInputsEditor({
        instance, candidate, scope: surface, context: itemContext, audience: props.isShared ? 'shared' : 'personal',
        ...(props.canEdit ? { setInputs: saveInputs } : {}), testID,
    });
    const definition = useWidgetDefinitionFlows({ instance, scope: surface, providedContext, anchorRef: edit.anchorRef, editInputs: edit.editInputs, testID });
    const title = instance.displayName ?? candidate?.title ?? t('sessionBoard.item.pluginUnavailable.title');
    const drag = useSessionSurfaceEntityDrag(props.current && props.canEdit ? {
        scope: surface, title, isCurrent: () => props.current && props.canEdit && findWidgetLayoutItemV1(props.layoutItems, instance.id) !== undefined,
        getItem: () => ({ kind: 'widget-area-instance', scope: { serverId: surface.serverId, accountId: surface.accountId }, ref: { surface, instanceId: instance.id } }),
        admitWidgetMovement: props.admitWidgetMovement,
        ...(props.port?.movement ? { widgetMovement: props.port.movement } : {}),
        getWidgetAreaTarget: () => ({ surface, area: props.area, groupId: parent?.group.id ?? null, itemId: instance.id,
            itemIds: parent ? parent.group.children.map(child => child.instance.id) : props.movementSiblings.map(getWidgetLayoutItemIdV1) }),
        // Inside a group, the line on the hairline reorders within it (lab wgdnd B).
        pointerDestination: (bounds, pointer) => ({ ...resolveEntityFlatRowPosition(instance.id, bounds, pointer), ...(parent ? { groupId: parent.group.id } : {}) }),
        target: widgetLayoutCardDropTarget({ surface, items: props.layoutItems, itemId: instance.id, title,
            groupLabel: props.surfaceName, groupId: parent?.group.id,
            describeGroup: group => describeWidgetGroup(group, props.childTitle),
            sourceItem: props.movementSourceItem, area: props.area, canEdit: props.canEdit }),
    } : null);
    const carriedStyle = useSessionSurfaceCarriedStyle(drag);
    const renaming = useWidgetFrameRename({
        title,
        testID,
        ...(props.canEdit ? { onRename: async (next: string) => {
            // An empty name, or the widget's own, goes back to it.
            const displayName = next.length > 0 && next !== candidate?.title ? next : null;
            if ((displayName ?? undefined) === instance.displayName) return;
            const outcome = await write({ actionId: 'widgets.item.rename', instanceId: instance.id, displayName });
            if (outcome.kind === 'refused') throw new Error(outcome.errorCode);
        } } : {}),
    });

    const alwaysVisible = Platform.OS !== 'web' || readCoarsePrimaryPointer();
    const choices = resolveWidgetSizeChoicesV1(surface.owner.kind, candidate?.sizeDeclaration);
    const sizeLimit = parent ? resolveWidgetGroupChildSizeLimit({ group: parent.group, groupName: describeWidgetGroup(parent.group, props.childTitle),
        surface: surface.owner.kind, sizes: choices.sizes }) : undefined;
    const sizeControl: WidgetSizeControl | undefined = props.canEdit && candidate && choices.defaultSize ? {
        surface: surface.owner.kind, sizes: choices.sizes,
        size,
        onSet: size => { void write({ actionId: 'widgets.item.size.set', instanceId: instance.id, size }); },
        ...(sizeLimit ? { unavailable: sizeLimit } : {}),
    } : undefined;
    const menu = props.canEdit ? (
        <View
            ref={edit.anchorRef}
            collapsable={false}
            testID={`${testID}.menu`}
        >
            {/* The shared reveal owner: it fades, and shows itself while the ⋯ or grip has keyboard focus. */}
            <RowActionRevealSlot revealed={alwaysVisible || hover.isHovered}>
            <SessionSurfaceEntityDragHandle drag={drag} title={title} testID={`${testID}.move`}
                renderTrigger={({ toggle, grip }) => <View style={styles.header}>
                    {props.organizing ? grip : null}
                    <ItemRowActions
                title={title}
                compactThreshold={ALWAYS_OVERFLOW}
                compactActionIds={[]}
                overflowMaxHeightCap={WIDGET_MENU_MAX_HEIGHT_PX}
                overflowTriggerTestID={`${testID}.menuTrigger`}
                overflowTriggerAccessibilityLabel={`${t('widgetAdd.widgetOptions')}: ${title}`}
                onOverflowTriggerKeyDown={key => stepWidgetSizeControl(sizeControl, key)}
                renderOverflowSection={({ id }) => renderWidgetSizeMenuSection(sizeControl, id, `${testID}.size`)}
                actions={orderWidgetMenu({
                    instance: buildWidgetInstanceActions({ editInputs: edit.editInputs, onRename: renaming.begin }),
                    size: buildWidgetSizeActions(sizeControl),
                    frame: parent ? [] : buildWidgetFrameStyleActions({
                        placement: GEOMETRY_PLACEMENT[geometry],
                        surfaceDefault: WIDGET_FRAME_PLACEMENT_DEFAULTS[GEOMETRY_PLACEMENT[geometry]],
                        override: placement.frameStyle ?? null,
                        surfaceLabel: props.surfaceName,
                        onSet: (style) => { void write({ actionId: 'widgets.item.frame.set', instanceId: instance.id, frameStyle: style }); },
                    }),
                    // One Move… where the host binds widget movement: the Organize chooser lists every place
                    // it can go (lab dbind E). Without it, the steps that reorder this area.
                    move: [
                        ...(parent ? buildWidgetMoveActions({ index: props.index, count: props.count,
                            onMove: (delta: -1 | 1) => props.groupOperations.move(instance.id, props.index + delta, parent.group.id) })
                        : buildWidgetMoveActions({
                            index: props.index,
                            count: props.count,
                            ...(props.port?.movement ? { chooser: toggle } : {
                                onMove: (delta: -1 | 1) => { void write({ actionId: 'widgets.item.move', instanceId: instance.id, toIndex: props.index + delta,
                                    ...(props.area ? { area: props.area } : {}) }); },
                            }),
                        })),
                        ...(supportsGroups ? buildWidgetGroupMembershipActions({ instanceId: instance.id, size, items: props.layoutItems,
                            childTitle: props.childTitle, operations: props.groupOperations }) : []),
                    ],
                    definition: buildWidgetDefinitionActions({ onAbout: definition.about }),
                    surface: bodyActions ?? [],
                    remove: [{ id: 'remove', title: t('common.remove'), icon: 'trash', destructive: true,
                        onPress: () => { void write({ actionId: 'widgets.item.remove', instanceId: instance.id }); } }],
                })}
                    />
                </View>} />
            </RowActionRevealSlot>
        </View>
    ) : null;

    const body = React.useMemo(() => ({
        kind: 'content' as const,
        // Release executable demand outside the host's admitted window while retaining its room.
        children: active ? (
            <View testID={`${testID}.bodyHeight`} onLayout={onBodyLayout}>
            <WidgetFrameBodyCaptionContext.Provider value={setBodyCaption}>
            <WidgetFrameBodyActionsContext.Provider value={setBodyActions}>
            <WidgetSurface
                scope={surface}
                admittedViewer={props.admittedViewer ?? undefined}
                isCurrent={props.isCurrent}
                instance={instance}
                descriptor={candidate}
                providedContext={providedContext}
                groupBindings={groupContext}
                recordRevision={stableJsonStringify(instance)}
                presentation="content"
                size={size}
                appRuntime={runtime}
                {...(edit.onRepairInputs ? { onRepairInputs: edit.onRepairInputs } : {})}
                testID={`${testID}.body`}
            />
            </WidgetFrameBodyActionsContext.Provider>
            </WidgetFrameBodyCaptionContext.Provider>
            </View>
        ) : <View testID={`${testID}.deferred`} style={{ minHeight: bodyHeight }} />,
    }), [active, bodyHeight, candidate, edit.onRepairInputs, instance, onBodyLayout, providedContext, groupContext, runtime, surface, testID, size, props.admittedViewer, props.isCurrent]);

    return (
        <View ref={node => { sectionRef.current = node; drag.ref(node); }} collapsable={false}
            onLayout={() => { measure(); drag.onLayout(); }} testID={testID} style={[styles.cell, carriedStyle]} {...hover.hoverProps}>
            <WidgetFrame
                testID={`${testID}.frame`}
                frameStyle={frameStyle}
                placement={GEOMETRY_PLACEMENT[geometry]}
                widgetPresentation={widgetPresentation}
                mark={candidate?.icon ?? 'squares-four'}
                title={renaming.field ?? title}
                source={followed
                    ? widgetGroupFollowSource(followed, parent?.wide === true)
                    : bodyCaption ?? bindingLabel ?? candidate?.pluginName ?? undefined}
                grouped={parent !== undefined}
                compactHeader={parent !== undefined && !parent.wide}
                // A core page's rows take their content height (A6/A7): no fixed viewport, size and width kept.
                {...(surface.owner.kind === 'corePage' ? { bodyHeight: 'content' as const } : {})}
                menu={menu}
                {...(surface.owner.kind === 'project' ? { disclosure: {
                    collapsed, onCollapsedChange,
                    expandLabel: t('projects.widgets.expand'), collapseLabel: t('projects.widgets.collapse'),
                } } : {})}
                body={body}
                // A change to this card that was refused stays on it, with Retry, until one succeeds.
                footer={props.failed ? { kind: 'refreshFailed', reason: t('widgetAdd.areaWriteFailed'), onRetry: props.failed.retry } : null}
            />
            {edit.popover}
            {definition.panel}
            <SessionSurfaceEntityTargetFeedback drag={drag} testID={testID} />
        </View>
    );
});

const AREA_LABELS = (surfaceName: string): AccountWidgetSurfaceLabels => ({
    count: (count) => t('widgetAdd.countHere', { count }),
    submit: t('widgetAdd.areaAddTo', { surface: surfaceName }),
});

/** The shared Add surface, counted "N here"; every add is the area's `widgets.item.add`. */
function WidgetAreaAddPopover(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    surface: WidgetSurfaceRefV1;
    area?: 'main' | 'aside';
    placements: readonly WidgetPlacementV1[];
    context: WidgetSurfaceContext;
    surfaceName: string;
    /** Adds into this group (its empty slot) instead of at the end of the area. */
    groupId?: string;
    /** Overrides the gallery title (a dashboard area names its dashboard and area). */
    title?: string;
    write: WidgetAreaWrite;
    onRequestClose: () => void;
    testID: string;
}>): React.ReactElement {
    const { write } = props;
    const instances = React.useMemo(() => props.placements.map((placement) => placement.instance), [props.placements]);
    const labels = React.useMemo(() => AREA_LABELS(props.surfaceName), [props.surfaceName]);
    const addInstance = React.useCallback((instance: WidgetInstanceV1, size?: WidgetSizeV1) => runAcknowledgedWidgetSetupCommand(
        () => write({ actionId: 'widgets.item.add', instance, ...(props.area ? { area: props.area } : {}), ...(size ? { size } : {}),
            ...(props.groupId ? { groupId: props.groupId } : {}) }), t('widgetAdd.addFailed'),
    ), [props.area, props.groupId, write]);
    const sections = useAccountWidgetAddSections({ scope: props.surface, instances, addInstance, labels, context: props.context,
        ...(props.area ? { area: props.area } : {}), testID: props.testID });
    return (
        <WidgetAddSurface
            open
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            title={props.title ?? labels.submit}
            hint={t('widgetAdd.areaHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            addLabel={labels.submit}
            sections={sections}
            serverId={props.surface.serverId}
            testID={props.testID}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    area: { gap: 8 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: ADD_TARGET_PX },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary, flexShrink: 1 },
    meta: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary, flexShrink: 1 },
    grow: { flex: 1 },
    column: { gap: 12 },
    dashboardEmpty: { ...Typography.default(), ...happierPageTextMetrics('sectionDescription'), color: theme.colors.text.secondary },
    // The frame fills its grid cell, so cards in one row share a height.
    cell: { flexGrow: 1 },
}));
