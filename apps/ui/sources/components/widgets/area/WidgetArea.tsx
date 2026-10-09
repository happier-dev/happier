import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_EMPTY_STATE_FRAME, HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { normalizeWidgetSizeForSurfaceV1, resolveWidgetSizeChoicesV1, type WidgetInstanceV1, type WidgetPlacementV1, type WidgetSurfaceRefV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
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
} from '@/components/widgets/frame/widgetFrameMenu';
import { WIDGET_FRAME_PLACEMENT_DEFAULTS, resolveWidgetFrameStyle } from '@/components/widgets/frame/widgetFrameStyle';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
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
import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityFeedback, SessionSurfaceEntityTargetFeedback, useSessionSurfaceEntityDrag, useSessionSurfaceGeometryRefresh } from '@/components/sessions/board/SessionSurfaceEntityDrag';
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
    const { theme } = useUnistyles();
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
    // Organize exists only when there is something to organize (two or more widgets) and only for a
    // coarse pointer: a hover-capable pointer already has each widget's grip (lab PG; DnD K1h).
    const canOrganize = canAdd && (ready?.placements.length ?? 0) > 1 && (Platform.OS !== 'web' || readCoarsePrimaryPointer());
    const viewer = useActiveServerAccountScope();
    const focused = useIsFocused();
    const current = ready !== null && focused && viewer?.serverId === ready.surface.serverId
        && (viewer.accountId === ready.surface.accountId || ready.admittedViewer?.serverId === viewer.serverId && ready.admittedViewer.accountId === viewer.accountId);
    const movement = useWidgetMovementAdmission(current ? ready?.surface ?? null : null, ready?.placements, props.port.movement);
    const drop = useSessionSurfaceEntityDrag(current && ready ? {
        scope: ready.surface, title: props.surfaceName, getItem: () => null, isCurrent: () => current,
        admitWidgetMovement: movement.admit, ...(props.port.movement ? { widgetMovement: props.port.movement } : {}),
        target: { acceptedKinds: ['widget-area-instance', 'home-section', 'work-board-widget', 'session-board-item', 'companion-item'],
            listDestinations: () => [{ destination: { anchorId: null, placement: 'after' },
                label: props.area ? t(props.area === 'main' ? 'projects.widgets.mainArea' : 'projects.widgets.sideArea') : props.surfaceName,
                group: props.surfaceName }],
            resolve: ({ item, destination }) => resolveWidgetAreaEntityDrop({ item, destination, surface: ready.surface,
                placements: ready.placements, area: props.area, canEdit: ready.canEdit, preview: { verb: t('entityDragDrop.organize.title'), target: props.surfaceName } }),
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

    return (
        <View ref={drop.ref} onLayout={drop.onLayout} testID={props.testID} style={styles.area}>
            {props.dashboard ? null : <WidgetAreaHeader
                title={props.title}
                meta={notice?.kind === 'pending' ? t('widgetAdd.areaApprovalPending') : props.meta}
                testID={props.testID}
                // The Add keeps its place while the layout first loads, so nothing moves on arrival.
                add={state.status === 'loading' || canAdd ? (
                    <View style={styles.header}>
                        {canOrganize ? <RoundButton size="small" display="secondary" testID={`${props.testID}.organize`}
                            title={t(organizing ? 'common.done' : 'entityDragDrop.organize.title')}
                            onPress={() => { setOrganizing(value => !value); drop.runtime.cancel('organize-changed'); }} /> : null}
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
                <WidgetAreaPlacements {...props} context={ready.context} surface={ready.surface} placements={ready.placements} canEdit={ready.canEdit}
                    isShared={ready.isShared} admittedViewer={ready.admittedViewer}
                    isCurrent={ready.isCurrent}
                    current={current} organizing={organizing && canOrganize} admitWidgetMovement={movement.admit} write={write}
                    failed={notice?.kind === 'failed' ? notice : null} />
            ) : null}
            {props.display !== 'widgets' && props.dashboard && (state.status === 'loading' || canAdd) ? (
                <View ref={addAnchorRef} collapsable={false}>
                    <HappierPressable
                        testID={`${props.testID}.add`}
                        accessibilityRole="button"
                        accessibilityLabel={t('widgetAdd.areaAdd', { surface: props.surfaceName })}
                        disabled={!canAdd}
                        expanded={addOpen}
                        hasPopup="dialog"
                        onPress={() => setAddOpen((open) => !open)}
                        style={(pressState) => [styles.dashboardAdd, pressState.hovered || pressState.pressed || addOpen ? styles.dashboardAddActive : null]}
                    >
                        <Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                        <Text style={styles.dashboardAddLabel}>{props.dashboard.addLabel}</Text>
                    </HappierPressable>
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
    canEdit: boolean;
    isShared: boolean;
    admittedViewer: Extract<WidgetAreaLayout<WidgetSurfaceContext>['state'], { status: 'ready' }>['admittedViewer'];
    isCurrent: () => boolean;
    current: boolean;
    organizing: boolean;
    admitWidgetMovement(effect: EntityDropEffectV1): EntityDropAdmissionV1;
    write: WidgetAreaWrite;
}>;

function WidgetAreaPlacements(props: PlacementsProps): React.ReactElement {
    const runtime = useAppShellPluginUiProjection();
    const instances = React.useMemo(() => props.placements.map(placement => placement.instance), [props.placements]);
    const installed = React.useMemo(() => instances.flatMap(instance => {
        const candidate = readWidgetDescriptor(runtime.pluginUiProjection, instance.definition);
        return candidate ? [candidate] : [];
    }), [instances, runtime.pluginUiProjection]);
    const descriptors = useWidgetInstanceDescriptors(props.surface, instances, installed);
    const sizes = React.useMemo(() => props.placements.map((placement, index) => normalizeWidgetSizeForSurfaceV1(
        props.surface.owner.kind, placement.size, descriptors[index]?.sizeDeclaration)), [props.placements, props.surface.owner.kind, descriptors]);
    const projectAreas = React.useMemo(() => ({
        main: props.placements.filter(placement => (placement.area ?? 'main') === 'main'),
        aside: props.placements.filter(placement => placement.area === 'aside'),
    }), [props.placements]);
    const areaOffsets = { main: 0, aside: 0 };
    const items = props.placements.map((placement, index) => {
        const area = props.surface.owner.kind === 'project' ? placement.area ?? 'main' : undefined;
        const siblings = area ? projectAreas[area] : props.placements;
        return (
            <WidgetAreaItem
                key={placement.instance.id}
                {...props}
                failed={props.failed?.instanceId === placement.instance.id ? props.failed : null}
                placement={placement}
                descriptor={descriptors[index] ?? null}
                size={sizes[index]}
                area={area}
                movementPlacements={siblings}
                index={area ? areaOffsets[area]++ : index}
                count={siblings.length}
            />
        );
    });
    if (props.geometry === 'column') return <View style={styles.column}>{items}</View>;
    return (
        <CardGrid testID={`${props.testID}.grid`} columns={2}>
            {props.placements.map((placement, index) => (sizes[index] && getWidgetSizeFootprintV1(props.surface.owner.kind, sizes[index])?.columnSpan === 2
                ? <CardGridCell key={placement.instance.id} span="row">{items[index]}</CardGridCell>
                : items[index]))}
        </CardGrid>
    );
}

const WidgetAreaItem = React.memo(function WidgetAreaItem(props: PlacementsProps & Readonly<{
    placement: WidgetPlacementV1;
    descriptor: WidgetCandidate | null;
    size: WidgetSizeV1 | undefined;
    index: number;
    count: number;
    movementPlacements: readonly WidgetPlacementV1[];
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
    const [menuFocused, setMenuFocused] = React.useState(false);
    const bindingLabel = useWidgetInstanceBindingLabel(instance, candidate, context);

    const saveInputs = React.useCallback((bindings: WidgetInstanceV1['bindings']) => runAcknowledgedWidgetSetupCommand(
        () => write({ actionId: 'widgets.item.inputs.set', instanceId: instance.id, bindings }),
        t('widgetAdd.saveFailed'),
    ), [instance.id, write]);
    const edit = useWidgetInputsEditor({
        instance, candidate, scope: surface, context, audience: props.isShared ? 'shared' : 'personal',
        ...(props.canEdit ? { setInputs: saveInputs } : {}), testID,
    });
    const definition = useWidgetDefinitionFlows({ instance, scope: surface, providedContext, anchorRef: edit.anchorRef, editInputs: edit.editInputs, testID });
    const title = instance.displayName ?? candidate?.title ?? t('sessionBoard.item.pluginUnavailable.title');
    const drag = useSessionSurfaceEntityDrag(props.current && props.canEdit ? {
        scope: surface, title, isCurrent: () => props.current && props.canEdit && props.placements.some(entry => entry.instance.id === instance.id),
        getItem: () => ({ kind: 'widget-area-instance', scope: { serverId: surface.serverId, accountId: surface.accountId }, ref: { surface, instanceId: instance.id } }),
        admitWidgetMovement: props.admitWidgetMovement,
        ...(props.port?.movement ? { widgetMovement: props.port.movement } : {}),
        getWidgetAreaTarget: () => ({ surface, area: props.area, itemId: instance.id, itemIds: props.movementPlacements.map(entry => entry.instance.id) }),
        pointerDestination: (bounds, pointer) => resolveEntityFlatRowPosition(instance.id, bounds, pointer),
        target: { acceptedKinds: ['widget-area-instance', 'home-section', 'work-board-widget', 'session-board-item', 'companion-item'],
            listDestinations: () => (['before', 'after'] as const).map(placement => ({ destination: { anchorId: instance.id, placement },
                label: t(placement === 'before' ? 'entityDragDrop.preview.moveAbove' : 'entityDragDrop.preview.moveBelow', { target: title }), group: props.surfaceName })),
            resolve: ({ item, destination }) => resolveWidgetAreaEntityDrop({ item, destination, surface, placements: props.placements,
                area: props.area, canEdit: props.canEdit, preview: { verb: t('entityDragDrop.organize.title'), target: title } }),
            execute: async () => ({ status: 'refused', reason: { code: 'unsupported_widget_surface', message: t('entityDragDrop.surface.widgetMoveUnavailable') } }),
        },
    } : null);
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
    const sizeControl: WidgetSizeControl | undefined = props.canEdit && candidate && choices.defaultSize ? {
        surface: surface.owner.kind, sizes: choices.sizes,
        size,
        onSet: size => { void write({ actionId: 'widgets.item.size.set', instanceId: instance.id, size }); },
    } : undefined;
    const menu = props.canEdit ? (
        <View
            ref={edit.anchorRef}
            collapsable={false}
            testID={`${testID}.menu`}
            style={{ opacity: alwaysVisible || hover.isHovered || menuFocused ? 1 : 0 }}
            onFocus={() => setMenuFocused(true)}
            onBlur={() => setMenuFocused(false)}
        >
            <SessionSurfaceEntityDragHandle drag={drag} title={title} testID={`${testID}.move`}
                renderTrigger={({ toggle, grip }) => <View style={styles.header}>
                    {props.organizing || !alwaysVisible ? grip : null}
                    <ItemRowActions
                title={title}
                compactThreshold={ALWAYS_OVERFLOW}
                compactActionIds={[]}
                overflowTriggerTestID={`${testID}.menuTrigger`}
                overflowTriggerAccessibilityLabel={`${t('widgetAdd.widgetOptions')}: ${title}`}
                onOverflowTriggerKeyDown={key => stepWidgetSizeControl(sizeControl, key)}
                renderOverflowSection={({ id }) => renderWidgetSizeMenuSection(sizeControl, id, `${testID}.size`)}
                actions={orderWidgetMenu({
                    instance: buildWidgetInstanceActions({ editInputs: edit.editInputs, onRename: renaming.begin }),
                    size: buildWidgetSizeActions(sizeControl),
                    frame: buildWidgetFrameStyleActions({
                        placement: GEOMETRY_PLACEMENT[geometry],
                        surfaceDefault: WIDGET_FRAME_PLACEMENT_DEFAULTS[GEOMETRY_PLACEMENT[geometry]],
                        override: placement.frameStyle ?? null,
                        surfaceLabel: props.surfaceName,
                        onSet: (style) => { void write({ actionId: 'widgets.item.frame.set', instanceId: instance.id, frameStyle: style }); },
                    }),
                    // One Move… where the host binds widget movement: the Organize chooser lists every place
                    // it can go (lab dbind E). Without it, the steps that reorder this area.
                    move: buildWidgetMoveActions({
                        index: props.index,
                        count: props.count,
                        ...(props.port?.movement ? { chooser: toggle } : {
                            onMove: (delta: -1 | 1) => { void write({ actionId: 'widgets.item.move', instanceId: instance.id, toIndex: props.index + delta,
                                ...(props.area ? { area: props.area } : {}) }); },
                        }),
                    }),
                    definition: buildWidgetDefinitionActions({ onAbout: definition.about }),
                    remove: [{ id: 'remove', title: t('common.remove'), icon: 'trash', destructive: true,
                        onPress: () => { void write({ actionId: 'widgets.item.remove', instanceId: instance.id }); } }],
                })}
                    />
                </View>} />
        </View>
    ) : null;

    const body = React.useMemo(() => ({
        kind: 'content' as const,
        // Release executable demand outside the host's admitted window while retaining its room.
        children: active ? (
            <View testID={`${testID}.bodyHeight`} onLayout={onBodyLayout}>
            <WidgetSurface
                scope={surface}
                admittedViewer={props.admittedViewer ?? undefined}
                isCurrent={props.isCurrent}
                instance={instance}
                descriptor={candidate}
                providedContext={providedContext}
                recordRevision={stableJsonStringify(instance)}
                presentation="content"
                size={size}
                appRuntime={runtime}
                {...(edit.onRepairInputs ? { onRepairInputs: edit.onRepairInputs } : {})}
                testID={`${testID}.body`}
            />
            </View>
        ) : <View testID={`${testID}.deferred`} style={{ minHeight: bodyHeight }} />,
    }), [active, bodyHeight, candidate, edit.onRepairInputs, instance, onBodyLayout, providedContext, runtime, surface, testID, size, props.admittedViewer, props.isCurrent]);

    return (
        <View ref={node => { sectionRef.current = node; drag.ref(node); }} collapsable={false}
            onLayout={() => { measure(); drag.onLayout(); }} testID={testID} style={styles.cell} {...hover.hoverProps}>
            <WidgetFrame
                testID={`${testID}.frame`}
                frameStyle={frameStyle}
                placement={GEOMETRY_PLACEMENT[geometry]}
                widgetPresentation={widgetPresentation}
                mark={candidate?.icon ?? 'squares-four'}
                title={renaming.field ?? title}
                source={bindingLabel ?? candidate?.pluginName ?? undefined}
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
        () => write({ actionId: 'widgets.item.add', instance, ...(props.area ? { area: props.area } : {}), ...(size ? { size } : {}) }), t('widgetAdd.addFailed'),
    ), [props.area, write]);
    const sections = useAccountWidgetAddSections({ scope: props.surface, instances, addInstance, labels, context: props.context, testID: props.testID });
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
    // Dashed means "add something here" (the empty-state owner's add frame), as one quiet line per area.
    dashboardAdd: {
        ...HAPPIER_EMPTY_STATE_FRAME.add,
        borderColor: theme.colors.border.default,
        minHeight: ADD_TARGET_PX,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    dashboardAddActive: { backgroundColor: theme.colors.surface.selected },
    dashboardAddLabel: { ...Typography.default(), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.secondary },
    // The frame fills its grid cell, so cards in one row share a height.
    cell: { flexGrow: 1 },
}));
