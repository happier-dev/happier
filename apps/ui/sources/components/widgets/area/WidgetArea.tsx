import * as React from 'react';
import { WidgetFrameDemandContext, WidgetFrameInstanceIdContext } from '@/components/widgets/frame/widgetFrameDemand';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_EMPTY_SLOT_METRICS, HAPPIER_ICON_BUTTON_SIZE, HAPPIER_PAGE_METRICS, HappierPageSectionContext, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { EmptySlot } from '@/components/ui/empty/EmptySlot';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { findWidgetLayoutItemV1, flattenWidgetLayoutWidgetsV1, getWidgetLayoutItemIdV1, normalizeWidgetSizeForSurfaceV1, resolveWidgetSizeChoicesV1, supportsWidgetGroupsV1, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetLayoutGroupV1, type WidgetLayoutItemV1, type WidgetPlacementV1, type WidgetSurfaceRefV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { WidgetGroupFrame, type WidgetGroupChildPlacement } from '@/components/widgets/group/WidgetGroupFrame';
import { WidgetGroupMenuButton } from '@/components/widgets/group/WidgetGroupMenuButton';
import { WidgetGroupBar } from '@/components/widgets/group/WidgetGroupBar';
import { readWidgetGroupTitle } from '@/components/widgets/group/widgetGroupTitle';
import { buildWidgetGroupMembershipActions, describeWidgetGroup, describeWidgetGroupAmong, resolveWidgetGroupChildSizeLimit, WIDGET_GROUP_ICON, type WidgetGroupOperations } from '@/components/widgets/group/widgetGroupMenu';
import { useWidgetCarriedIdentity } from '@/components/widgets/surface/widgetCarriedIdentity';
import { describeWidgetGroupContext, readWidgetGroupFollowedValue, widgetGroupFollowSource, widgetGroupPinnedSource, widgetGroupSurfaceContext } from '@/components/widgets/group/widgetGroupInputs';
import { resolveWidgetGroupCells } from '@happier-dev/plugin-ui/components';
import { resolveWidgetGroupColumns } from '@happier-dev/plugin-ui/presentation';
import { resolveWidgetGroupPointerDestination, widgetGroupDropTarget, widgetLayoutCardDropTarget } from '@/components/widgets/group/widgetGroupDropTarget';
import { WidgetGroupDropFeedback } from '@/components/widgets/group/WidgetGroupDropFeedback';
import { WidgetGroupMembershipArrivalView, useWidgetGroupMembershipArrivals } from '@/components/widgets/group/widgetGroupMembershipArrival';
import { useWidgetGroupMenu } from '@/components/widgets/group/useWidgetGroupMenu';
import { randomUUID } from '@/platform/randomUUID';
import { useDeviceType } from '@/utils/platform/responsive';
import { useWidgetMenuSurface } from '@/components/widgets/flow/WidgetFlowShell';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';

import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
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
    useWidgetMenuAlwaysShown,
    WIDGET_MENU_MAX_HEIGHT_PX,
} from '@/components/widgets/frame/widgetFrameMenu';
import { useWidgetAreaFrame } from '@/components/widgets/frame/useWidgetFrameStyle';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { WidgetFrameBodyCaptionContext, WidgetFrameBodyMetaContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { WidgetFrameBodyActionsContext } from '@/components/widgets/frame/widgetFrameBodyActions';
import { useWidgetDefinitionFlows } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { isWidgetFollowingSurfaceSlot, useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import type { WidgetBindingValueLabels } from '@/components/widgets/surface/useWidgetBindingValueLabels';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { runAcknowledgedWidgetSetupCommand, widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { isBuiltinWidgetSwitchedOff, readWidgetDescriptor, resolveWidgetInstanceTitle, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useAtmosphereMoments } from '@/components/atmosphere/atmosphereMoments';
import { t } from '@/text';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useWidgetMovementAdmission } from '@/components/widgets/surface/useWidgetMovementAdmission';
import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityFeedback, SessionSurfaceEntityTargetFeedback, useSessionSurfaceCarriedStyle, useSessionSurfaceEntityDrag, useSessionSurfaceGeometryRefresh } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';
import { resolveEntityFlatRowPosition } from '@/components/ui/treeDragDrop/geometry/entityFlatListStrategy';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
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
// The header row holds the add IconButton at its drawn size; a finger reaches past it through the hit area.
const HEADER_MIN_HEIGHT_PX = HAPPIER_ICON_BUTTON_SIZE;
// The dashed Add line's own height (its padding and one row title line), so its placeholder holds the same room.
const ADD_LINE_PX = 2 * HAPPIER_EMPTY_SLOT_METRICS.paddingPx + happierPageTextMetrics('rowTitle').lineHeight;
/** The settled empty line's height (its description step), held while a page-section area loads. */
const EMPTY_LINE_PX = happierPageTextMetrics('sectionDescription').lineHeight;

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
    /** Split Project renderers and trailing controls use their document's one editing state. */
    organize?: Readonly<{ active: boolean; onChange: (active: boolean) => void }>;
    /** A document host retains viewer-local disclosure while responsive areas remount. */
    disclosure?: Readonly<{
        collapsedByInstanceId: Readonly<Record<string, boolean>>;
        onCollapsedChange: (instanceId: string, collapsed: boolean) => void;
    }>;
    geometry: WidgetAreaGeometry;
    /** A measured host pairs one column's saved order without replacing its mounted bodies. */
    columnLayout?: Readonly<{ columns: 1 | 2; gap: number }>;
    title: string;
    /** One quiet fact beside the title ("your widgets on this page"). */
    meta?: string;
    /**
     * One line about the area itself, under its header as a section's description sits under its title
     * (an edited preset's "… is yours now" with Reset to preset): the header's controls and the line's own
     * action then stand on separate lines rather than stacking at the trailing edge above the header.
     */
    notice?: React.ReactNode;
    /** The page's or project's name: "Add to PRs & Issues", "PRs & Issues uses Card". */
    surfaceName: string;
    /** Replaces the layout state with the host's own refusal (a Project without a known source). */
    unavailable?: Readonly<{ title: string; reason?: string; reasonCode: string }>;
    /**
     * A dashboard area (lab `p-overview`): no area header; the widgets, then one dashed "Add widget" line
     * that opens the same Add surface; an area emptied by Remove keeps its place and says so quietly.
     */
    dashboard?: Readonly<{ addLabel: string;
        /** The quiet line an emptied area says; absent where a sibling area already says it (one message per state). */
        emptyTitle?: string; /** The gallery says where the widget goes ("Add to Release · side area"). */ addTitle?: string;
        /**
         * An area that is one section of a page (a plugin page's widget area) holds its settled empty
         * line's place while it loads, rather than a card that may never come: the page around it does
         * not jump, and the heading above it already reads as it will.
         */
        holdsEmptyLineWhileLoading?: true;
        /** The page draws the Home's one offline line above the area, so a read failed by that cause says nothing more. */
        homeLineAbove?: true;
        /**
         * One Add that serves both areas of a dashboard (stacked and on a phone): the gallery offers the
         * areas, each with its own title, and adds into the chosen one through the same layout write.
         */
        areaChoice?: readonly Readonly<{ area: 'main' | 'aside'; label: string; title: string }>[] }>;
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
                <DashboardAreaEdge active={!!props.dashboard}>
                <SurfaceStateCard
                    testID={`${props.testID}.unavailable`}
                    kind="unavailable"
                    size="line"
                    layout="inline"
                    title={unavailable.title}
                    {...(unavailable.reason ? { reason: unavailable.reason } : {})}
                    diagnosticCode={unavailable.reasonCode}
                />
                </DashboardAreaEdge>
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
    const loadingFrame = useWidgetAreaFrame(GEOMETRY_PLACEMENT[props.geometry]).style;
    const addAnchorRef = React.useRef<View | null>(null);
    const [addOpen, setAddOpen] = React.useState(false);
    // What the last change came to, said where it belongs (never a line that pushes the area down):
    // a refused change on the card it was for, with Retry, until a later change succeeds; one held
    // for someone's approval as the header's quiet meta. A refused add stays on its gallery tile.
    const [noticeRecord, setNotice] = React.useState<Readonly<{ write: WidgetAreaWrite; value: AreaNotice | null }> | null>(null);
    // A replaced page/context/Account binding cannot inherit the old operation's feedback.
    const notice = noticeRecord?.write === layout.write ? noticeRecord.value : null;
    const [localOrganizing, setLocalOrganizing] = React.useState(false);
    const organizing = props.organize?.active ?? localOrganizing;
    const setOrganizing = props.organize?.onChange ?? setLocalOrganizing;
    const state = layout.state;
    const scopeRefused = state.status === 'unavailable' && (state.reasonCode === 'widget_scope_unavailable'
        || state.reasonCode === 'widget_area_scope_retired' || state.reasonCode === 'account_target_mismatch'
        || state.reasonCode === 'server_target_mismatch');
    const ready = state.status === 'ready' ? state : null;
    const readFailure = state.status === 'unavailable' ? state : ready?.readFailure;
    const homeUnavailable = useActiveHomeUnavailable();
    const readFailureNotice = readFailure && !(props.dashboard?.homeLineAbove && homeUnavailable) ? (
        <DashboardAreaEdge active={!!props.dashboard}>
            <SurfaceStateCard
                testID={`${props.testID}.${ready ? 'readFailed' : 'unavailable'}`}
                kind="unavailable"
                size="line"
                layout="inline"
                title={t('widgetAdd.areaUnavailableTitle')}
                {...(readFailure.reason || scopeRefused ? { reason: readFailure.reason ?? t('widgetAdd.areaScopeRecovery') } : {})}
                diagnosticCode={readFailure.reasonCode}
                {...(!scopeRefused ? { action: { label: t('common.retry'), onPress: async () => { await layout.reload(); }, testID: `${props.testID}.retry` } } : {})}
            />
        </DashboardAreaEdge>
    ) : null;
    const areaFailure = notice?.kind === 'failed' && !ready?.placements.some(entry => entry.instance.id === notice.instanceId) ? notice : null;
    const canAdd = ready?.canEdit === true;
    // An open Add surface outlives a re-read that finds the area unavailable: it keeps the layout it was opened on, so a
    // failed Add still says why in its own footer instead of vanishing with the area. Closing releases it.
    const addBasis = React.useRef(ready);
    if (!addOpen) addBasis.current = null;
    else if (ready) addBasis.current = ready;
    const addReady = addOpen ? addBasis.current : null;
    // Organize is where a group shows its bar (grip, name, width, ⋯): the options route of an untitled
    // group and the handle of every group, on every pointer, including a group with one remaining
    // child. Other widgets keep the existing touch DnD route.
    const hasGroup = ready?.items.some(item => item.kind === 'group'
        && (props.area === undefined || (item.area ?? 'main') === props.area)) === true;
    const canOrganize = canAdd && (hasGroup || (ready?.placements.length ?? 0) > 1 && (Platform.OS !== 'web' || readCoarsePrimaryPointer()));
    const viewer = useActiveServerAccountScope();
    const focused = useIsFocused();
    const current = ready !== null && focused && !!viewer && areServerProfileIdentifiersEquivalent(viewer.serverId, ready.surface.serverId)
        && (viewer.accountId === ready.surface.accountId || ready.admittedViewer?.serverId === viewer.serverId && ready.admittedViewer.accountId === viewer.accountId);
    const movement = useWidgetMovementAdmission(current ? ready?.surface ?? null : null, ready?.placements, props.port.movement);
    const drop = useSessionSurfaceEntityDrag(current && ready ? {
        scope: ready.surface, title: props.surfaceName, getItem: () => null, isCurrent: () => current,
        admitWidgetMovement: movement.admit, ...(props.port.movement ? { widgetMovement: props.port.movement } : {}),
        target: { acceptedKinds: ['widget-area-instance', 'home-section', 'work-board-widget', 'session-board-item', 'companion-item', 'widget-layout-group'],
            listDestinations: () => [{ destination: { anchorId: null, placement: 'after' },
                label: t('widgetFrame.moveIntoGroupNamed', { group: props.area ? t(props.area === 'main' ? 'projects.widgets.mainArea' : 'projects.widgets.sideArea') : props.surfaceName }),
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
        const describe = (result: Exclude<WidgetAreaWriteOutcome, { kind: 'approvalPending' }>): AreaNotice | null =>
            result.kind === 'refused'
                ? { kind: 'failed', ...('instanceId' in operation ? { instanceId: operation.instanceId } : {}), errorCode: result.errorCode, retry: () => write(operation) }
                : null;
        if (outcome.kind === 'approvalPending') {
            const pending = { write: layoutWrite, value: { kind: 'pending' as const, artifactId: outcome.artifactId,
                ...('instanceId' in operation ? { instanceId: operation.instanceId } : {}) } };
            setNotice(pending);
            void outcome.settled.then(terminal => setNotice(previous => previous === pending ? { write: layoutWrite, value: describe(terminal) } : previous));
        } else setNotice({ write: layoutWrite, value: describe(outcome) });
        return outcome;
    }, [layoutWrite]);
    const closeAdd = React.useCallback(() => setAddOpen(false), []);
    const changeOrganizing = React.useCallback((next: boolean) => {
        setOrganizing(next);
        drop.runtime.cancel('organize-changed');
    }, [setOrganizing, drop.runtime]);
    useCurrentUiContextLocalCommands(current && canOrganize && ready ? [{
        key: `${stableJsonStringify(ready.surface)}:${props.area ?? 'all'}:organize`,
        title: `${t(organizing ? 'common.done' : 'entityDragDrop.organize.title')}: ${props.surfaceName}`,
        invoke: () => changeOrganizing(!organizing),
    }] : []);
    const organizeControl = canOrganize ? <RoundButton size="small" display="secondary" testID={`${props.testID}.organize`}
        title={t(organizing ? 'common.done' : 'entityDragDrop.organize.title')}
        onPress={() => changeOrganizing(!organizing)} /> : null;

    return (
        <View ref={drop.ref} onLayout={drop.onLayout} testID={props.testID} style={styles.area}>
            {props.dashboard ? null : <WidgetAreaHeader
                title={props.title}
                meta={notice?.kind === 'pending' ? t('widgetAdd.areaApprovalPending')
                    : areaFailure ? resolveActionExecutionErrorMessage({ errorCode: areaFailure.errorCode }, t('widgetAdd.areaWriteFailed')) : props.meta}
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
            {props.display === 'add' ? null : props.notice}
            {props.display === 'add' ? null : state.status === 'loading' && props.dashboard?.holdsEmptyLineWhileLoading ? (
                <View testID={`${props.testID}.loading`} style={styles.dashboardLoading}>
                    <SkeletonRows rows={1} lines={1} rowHeight={EMPTY_LINE_PX}
                        geometry={{ insetStart: 0, insetEnd: 0, glyphColumn: 0, gap: 0 }} accessibilityLabel={t('common.loading')} />
                    {/* The dashed Add line's place: it arrives once the layout says the viewer may add. */}
                    <View style={styles.addLineSpace} />
                </View>
            ) : state.status === 'loading' ? (
                <WidgetFrame
                    testID={`${props.testID}.loading`}
                    title={null}
                    frameStyle={loadingFrame}
                    placement={GEOMETRY_PLACEMENT[props.geometry]}
                    body={{ kind: 'loading', accessibilityLabel: t('common.loading') }}
                />
            ) : state.status === 'unavailable' ? (
                readFailureNotice
            ) : ready && ready.placements.length === 0 && props.dashboard ? (
                props.dashboard.emptyTitle
                    ? <Text testID={`${props.testID}.empty`} style={styles.dashboardEmpty}>{props.dashboard.emptyTitle}</Text>
                    : null

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
                    isReadPending={ready.isReadPending}
                    current={current} organizing={organizing && canOrganize} admitWidgetMovement={movement.admit} write={write}
                    movementSourceItem={movement.sourceItem}
                    failed={notice?.kind === 'failed' ? notice : null}
                    pendingInstanceId={notice?.kind === 'pending' ? notice.instanceId ?? null : null} />
            ) : null}
            {props.display !== 'add' && ready?.readFailure ? readFailureNotice : null}
            {areaFailure && props.dashboard ? <SurfaceStateCard testID={`${props.testID}.writeFailed`} kind="error" size="line" layout="inline"
                title={resolveActionExecutionErrorMessage({ errorCode: areaFailure.errorCode }, t('widgetAdd.areaWriteFailed'))}
                diagnosticCode={areaFailure.errorCode} action={{ label: t('common.retry'), onPress: () => { void areaFailure.retry(); } }} /> : null}
            {props.display !== 'widgets' && props.dashboard && canAdd ? (
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
                        onPress={() => setAddOpen((open) => !open)}
                    />
                </View>
                </View>
            ) : null}
            {ready ? <SessionSurfaceEntityFeedback kind="widget-area-instance" scope={ready.surface} address={null} widgetSurface={ready.surface} testID={`${props.testID}.move`} /> : null}
            <SessionSurfaceEntityTargetFeedback drag={drop} testID={props.testID} />
            {addReady ? (
                <WidgetAreaAddPopover
                    anchorRef={addAnchorRef}
                    surface={addReady.surface}
                    area={props.area}
                    placements={addReady.placements}
                    context={addReady.context}
                    {...(props.area ? { area: props.area } : {})}
                    surfaceName={props.surfaceName}
                    {...(props.dashboard?.addTitle ? { title: props.dashboard.addTitle } : {})}
                    {...(props.dashboard?.areaChoice ? { areaChoice: props.dashboard.areaChoice } : {})}
                    write={layoutWrite}
                    onRequestClose={closeAdd}
                    testID={`${props.testID}.addPopover`}
                />
            ) : null}
        </View>
    );
}

/**
 * A dashboard area draws no sheet: its cards, empty line and Add line start on the area's own edge.
 * Its area-level state line stands there too (glyph on that edge), as a section's line stands on its
 * rows' edge, rather than inset like a line among a list's rows.
 */
function DashboardAreaEdge(props: Readonly<{ active: boolean; children: React.ReactNode }>): React.ReactElement {
    const { theme } = useUnistyles();
    const section = React.useMemo(() => ({ rowDividerColor: theme.colors.border.subtle, rowInsetPx: 0 }), [theme.colors.border.subtle]);
    return props.active
        ? <HappierPageSectionContext.Provider value={section}>{props.children}</HappierPageSectionContext.Provider>
        : <>{props.children}</>;
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
    | Readonly<{ kind: 'pending'; artifactId: string; /** The card the write changes, when it is one (a remove, a resize). */ instanceId?: string }>
    | Readonly<{ kind: 'failed'; instanceId?: string; errorCode: string; retry: () => Promise<WidgetAreaWriteOutcome> }>;

type PlacementsProps = WidgetAreaProps & Readonly<{
    failed: Extract<AreaNotice, { kind: 'failed' }> | null;
    /** The card whose change waits for someone's approval: it says so until the area re-reads. */
    pendingInstanceId: string | null;
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
    isReadPending: () => boolean;
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
    const localize = usePluginLocalizedTextResolver({ projection: runtime.pluginUiProjection });
    const installed = React.useMemo(() => instances.flatMap(instance => {
        const candidate = readWidgetDescriptor(runtime.pluginUiProjection, instance.definition, instance.displayName ? undefined : localize);
        return candidate ? [candidate] : [];
    }), [instances, runtime.pluginUiProjection, localize]);
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
        return resolveWidgetInstanceTitle(entry?.placement.instance, entry?.descriptor);
    }, [byId]);
    const renderWidget = (instanceId: string, index: number, count: number, column: (typeof columns)[number], parent?: WidgetAreaGroupChild) => {
        const entry = byId.get(instanceId)!;
        return (
            <WidgetAreaItem
                key={instanceId}
                {...props}
                failed={props.failed?.instanceId === instanceId ? props.failed : null}
                pending={props.pendingInstanceId === instanceId}
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
            renderChild={(instanceId, placement, labels) => {
                const at = item.children.findIndex(child => child.instance.id === instanceId);
                return renderWidget(instanceId, at, item.children.length, columns[index]!, { group: item, index: at, wide: placement.wide || phone, labels });
            }}
        />
    ));
    const rendered = items.map((item, index) => {
        const id = getWidgetLayoutItemIdV1(item);
        return <WidgetGroupMembershipArrivalView key={id} arrival={arrivals.get(id)} style={styles.cell}>{built[index]}</WidgetGroupMembershipArrivalView>;
    });
    if (props.geometry === 'column') {
        if (!props.columnLayout) return <View style={styles.column}>{rendered}</View>;
        const split = Math.ceil(rendered.length / 2);
        // Both partitions stay mounted at every width; only the shared primitive's cell width changes.
        return <ItemGroupColumns columns={2} activeColumns={props.columnLayout.columns}
            paddingHorizontal={0} paddingVertical={0} columnGap={props.columnLayout.gap} rowGap={12}>
            <ItemGroupColumn><View style={styles.column}>{rendered.slice(0, split)}</View></ItemGroupColumn>
            <ItemGroupColumn><View style={styles.column}>{rendered.slice(split)}</View></ItemGroupColumn>
        </ItemGroupColumns>;
    }
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
type WidgetAreaGroupChild = Readonly<{ group: WidgetLayoutGroupV1; index: number; wide: boolean; labels: WidgetBindingValueLabels }>;

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
    renderChild: (instanceId: string, placement: WidgetGroupChildPlacement, labels: WidgetBindingValueLabels) => React.ReactNode;
}>) {
    const { group, write } = props;
    const hover = useRowActionHoverHost();
    const phone = useDeviceType() === 'phone';
    const testID = `${props.testID}.group.${group.id}`;
    const name = describeWidgetGroupAmong(props.items, group, props.childTitle);
    const menu = useWidgetGroupMenu({
        group, childTitle: props.childTitle, candidates: props.descriptors, scope: props.canEdit ? props.surface : null, context: props.context,
        operations: props.operations, showWidth: true, geometry: { phone, columns: props.columns }, testID,
        rename: props.canEdit ? async (title) => {
            const outcome = await write({ actionId: 'widgets.item.rename', instanceId: group.id, displayName: title ?? null });
            if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
        } : undefined,
        setInputs: props.canEdit ? (bindings: WidgetInputBindingsV1) => runAcknowledgedWidgetSetupCommand(
            () => write({ actionId: 'widgets.group.inputs.set', instanceId: group.id, bindings }), t('widgetAdd.saveFailed'),
        ) : undefined,
    });
    const labels = menu.labels;
    // The whole group lifts by its grip and is a drop target: into it, or beside it (lab wgdnd B).
    const carried = useWidgetCarriedIdentity({ kind: 'group', mark: WIDGET_GROUP_ICON, childCount: group.children.length });
    const drop = useSessionSurfaceEntityDrag(props.current && props.canEdit ? {
        scope: props.surface, title: name, ...carried, isCurrent: () => props.current && props.canEdit,
        getItem: () => props.items.some(item => item.kind === 'group' && item.id === group.id) ? { kind: 'widget-layout-group',
            scope: { serverId: props.surface.serverId, accountId: props.surface.accountId }, ref: { surface: props.surface, instanceId: group.id } } : null,
        admitWidgetMovement: props.admitWidgetMovement, ...(props.port?.movement ? { widgetMovement: props.port.movement } : {}),
        getWidgetAreaTarget: () => ({ surface: props.surface, area: props.area, groupId: null, itemId: group.id,
            itemIds: props.items.filter(item => props.surface.owner.kind !== 'project' || (item.area ?? 'main') === (props.area ?? 'main')).map(getWidgetLayoutItemIdV1) }),
        pointerDestination: (bounds, pointer) => resolveWidgetGroupPointerDestination(group.id, bounds, pointer),
        target: widgetGroupDropTarget({ surface: props.surface, items: props.items, group, name, area: props.area, canEdit: props.canEdit, surfaceLabel: props.surfaceName,
            describeGroup: entry => describeWidgetGroup(entry, props.childTitle),
            sourceItem: props.movementSourceItem }),
    } : null);
    const carriedStyle = useSessionSurfaceCarriedStyle(drop);
    // The handle belongs to the bar: in view mode a hover pointer lifts the group by its header.
    const grip = props.current && props.canEdit && props.organizing ? <SessionSurfaceEntityDragHandle drag={drop} title={name} testID={`${testID}.move`} /> : null;
    // "add one" in the empty slot opens this area's Add aimed at the group.
    const slotAnchorRef = React.useRef<View | null>(null);
    const [slotAddOpen, setSlotAddOpen] = React.useState(false);
    const source = describeWidgetGroupContext(group.context, labels);
    return (
        <View style={styles.cell} {...hover.hoverProps}>
            <WidgetGroupFrame
                testID={testID}
                group={group}
                placement={GEOMETRY_PLACEMENT[props.geometry]}
                cells={props.cells}
                columns={props.columns}
                customizing={props.organizing}
                {...(props.organizing && props.canEdit ? { bar: <WidgetGroupBar input={menu.menuInput} serverId={props.surface.serverId} onRename={menu.commitName} anchorRef={menu.anchorRef} grip={grip} testID={`${testID}.bar`} /> } : {})}
                {...(props.canEdit ? { onAddToGroup: () => setSlotAddOpen(true), addAnchorRef: slotAnchorRef } : {})}
                title={props.organizing && props.canEdit ? null : menu.renameField ?? readWidgetGroupTitle(group) ?? null}
                source={source ? widgetGroupPinnedSource(source) : undefined}
                menu={props.canEdit && !props.organizing ? <WidgetGroupMenuButton input={menu.menuInput} visible={hover.isHovered} anchorRef={menu.anchorRef} testID={`${testID}.menu`} /> : null}
                accessibilityLabel={t('widgetFrame.groupA11y', { name })}
                renderChild={(instanceId, placement) => props.renderChild(instanceId, placement, labels)}
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
    /** This card's own change is waiting for approval. */
    pending: boolean;
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
    // A Project widget collapses from its ⋯ (lab p-overview): only README, which is read collapsed,
    // carries its caret at rest; another widget shows it while collapsed, so it can come back. A viewer
    // without the ⋯ keeps the caret, so collapsing stays theirs either way.
    const collapsible = surface.owner.kind === 'project';
    const caretShown = collapsible && (collapsed || !props.canEdit
        || (instance.definition.kind === 'builtin' && instance.definition.id === 'project_readme'));
    const testID = `${props.testID}.widget.${instance.id}`;
    const runtime = useAppShellPluginUiProjection();
    const candidate = props.descriptor;
    const size = props.size;
    const widgetPresentation = React.useMemo(() => size ? { size, footprint: getWidgetSizeFootprintV1(surface.owner.kind, size)! } : undefined,
        [size, surface.owner.kind]);
    const frame = useWidgetAreaFrame(GEOMETRY_PLACEMENT[geometry], placement.frameStyle);
    // A group's child stands inside its group's own card.
    const frameStyle = props.parent ? 'plain' : frame.style;
    const providedContext = React.useMemo(() => widgetProvidedContext(context), [context]);
    const focused = useIsFocused();
    const hover = useRowActionHoverHost();
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const sectionRef = React.useRef<View | null>(null);
    const { near, measured, measure } = useMeasuredNearViewport(tracker, sectionRef, focused, instance.id);
    const demand = React.useContext(WidgetFrameDemandContext);
    const demandBuiltinId = instance.definition.kind === 'builtin' ? instance.definition.id
        : candidate?.authoredDefinition?.body.kind === 'builtin' ? candidate.authoredDefinition.body.id : undefined;
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const active = props.current && focused && near;
    const shown = active && !collapsed;
    React.useLayoutEffect(() => demand?.place(instance.id, demandBuiltinId, measured ? shown : null),
        [demand, instance.id, demandBuiltinId, measured, shown]);
    const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        setBodyHeight(current => current === height ? current : height);
    }, []);
    const parent = props.parent;
    const groupContext = parent?.group.context;
    const groupLabels = parent?.labels;
    const itemContext = React.useMemo(() => widgetGroupSurfaceContext(context, groupContext, groupLabels), [context, groupContext, groupLabels]);
    const followedLabel = useWidgetInstanceBindingLabel(instance, candidate, itemContext);
    // A Project page's header chip and a core page's filter bar (Usage) already name what their widgets
    // follow: "This checkout" or "This page" on each frame would repeat it on every card (lab p-overview
    // HOME, wgusage-CD). A copy pinned to another value still says which.
    const namesOwnScope = surface.owner.kind === 'project' || surface.owner.kind === 'corePage';
    const followsPage = namesOwnScope && isWidgetFollowingSurfaceSlot(instance, itemContext);
    const bindingLabel = followsPage ? null : followedLabel;
    // Nor do those pages call their own built-ins "Built in": the source slot is for a plugin's name.
    // A plugin whose name is also the widget's title is not said twice ("qaf1 footprints  qaf1 footprints").
    const shownTitle = resolveWidgetInstanceTitle(instance, candidate).trim().toLocaleLowerCase();
    const sourceName = namesOwnScope && instance.definition.kind === 'builtin' ? undefined
        : candidate?.pluginName && candidate.pluginName.trim().toLocaleLowerCase() === shownTitle ? undefined : candidate?.pluginName;
    const followed = readWidgetGroupFollowedValue(instance, groupContext, groupLabels);
    // A group with a header names the value it fills once; each widget that follows it does not say it again
    // (nor does a binding label, which would read the same slot). An untitled group has no header to say it.
    const groupNamesFollowed = followed !== null && parent !== undefined && readWidgetGroupTitle(parent.group) !== undefined;
    // The body may name what it shows; a followed group value still wins the source slot.
    const [bodyCaption, setBodyCaption] = React.useState<string | null>(null);
    const [bodyMeta, setBodyMeta] = React.useState<React.ReactNode>(null);
    // A built-in withdrawn by its own switch keeps its place in the layout, undrawn (as on Home).
    const switchedOff = isBuiltinWidgetSwitchedOff(instance.definition, useAtmosphereMoments());
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
    const definition = useWidgetDefinitionFlows({ instance, scope: surface,
        admittedViewer: props.admittedViewer ?? undefined, isCurrent: props.isCurrent,
        providedContext: widgetProvidedContext(itemContext), anchorRef: edit.anchorRef, editInputs: edit.editInputs, testID });
    const title = resolveWidgetInstanceTitle(instance, candidate);
    useCurrentUiContextLocalCommands(props.current && focused && collapsible && !switchedOff ? [{
        key: `${stableJsonStringify(surface)}:${instance.id}:disclosure`,
        title: `${t(collapsed ? 'projects.widgets.expand' : 'projects.widgets.collapse')}: ${title}`,
        invoke: () => onCollapsedChange(!collapsed),
    }] : []);
    // Carried, the card keeps its mark and says its source and the size it keeps (lab wgdnd 1).
    const carried = useWidgetCarriedIdentity({ kind: 'widget', mark: candidate?.icon ?? 'squares-four',
        source: groupNamesFollowed ? bodyCaption ?? undefined : followed ?? bodyCaption ?? bindingLabel ?? sourceName, size });
    // A readable copy can be mentioned; movement still admits edit permission at its Action owner.
    const drag = useSessionSurfaceEntityDrag(props.current ? {
        scope: surface, title, ...carried, isCurrent: () => props.current && findWidgetLayoutItemV1(props.layoutItems, instance.id) !== undefined,
        getItem: () => ({ kind: 'widget-area-instance', scope: { serverId: surface.serverId, accountId: surface.accountId }, ref: { surface, instanceId: instance.id } }),
        admitWidgetMovement: props.admitWidgetMovement,
        ...(props.port?.movement ? { widgetMovement: props.port.movement } : {}),
        getWidgetAreaTarget: () => ({ surface, area: props.area, groupId: parent?.group.id ?? null, itemId: instance.id,
            itemIds: parent ? parent.group.children.map(child => child.instance.id) : props.movementSiblings.map(getWidgetLayoutItemIdV1) }),
        // Inside a group, the line on the hairline reorders within it (lab wgdnd B).
        pointerDestination: (bounds, pointer) => ({ ...resolveEntityFlatRowPosition(instance.id, bounds, pointer), ...(parent ? { groupId: parent.group.id } : {}) }),
        target: widgetLayoutCardDropTarget({ surface, items: props.layoutItems, itemId: instance.id, title,
            groupLabel: parent ? describeWidgetGroupAmong(props.layoutItems, parent.group, props.childTitle) : props.surfaceName, groupId: parent?.group.id,
            describeGroup: group => describeWidgetGroup(group, props.childTitle),
            sourceItem: props.movementSourceItem, area: props.area, canEdit: props.canEdit }),
    } : null);
    const carriedStyle = useSessionSurfaceCarriedStyle(drag);
    const mention = useEntityComposerMention();
    const renaming = useWidgetFrameRename({
        title,
        testID,
        serverId: surface.serverId,
        ...(props.canEdit ? { onRename: async (next: string) => {
            // An empty name, or the widget's own, goes back to it.
            const displayName = next.length > 0 && next !== candidate?.title ? next : null;
            if ((displayName ?? undefined) === instance.displayName) return;
            const outcome = await write({ actionId: 'widgets.item.rename', instanceId: instance.id, displayName });
            if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
        } } : {}),
    });

    const alwaysVisible = useWidgetMenuAlwaysShown();
    const menuSurface = useWidgetMenuSurface({ title, testID: `${testID}.menu` });
    const choices = resolveWidgetSizeChoicesV1(surface.owner.kind, candidate?.sizeDeclaration);
    const sizeLimit = parent ? resolveWidgetGroupChildSizeLimit({ group: parent.group, groupName: describeWidgetGroup(parent.group, props.childTitle),
        surface: surface.owner.kind, sizes: choices.sizes }) : undefined;
    const sizeControl: WidgetSizeControl | undefined = props.canEdit && candidate && choices.defaultSize ? {
        surface: surface.owner.kind, sizes: choices.sizes,
        size,
        onSet: size => { void write({ actionId: 'widgets.item.size.set', instanceId: instance.id, size }); },
        ...(sizeLimit ? { unavailable: sizeLimit } : {}),
    } : undefined;
    const menu = props.current ? (
        <View
            ref={edit.anchorRef}
            collapsable={false}
            testID={`${testID}.menu`}
        >
            {/* The shared reveal owner: it fades, and shows itself while the ⋯ or grip has keyboard focus. */}
            <RowActionRevealSlot revealed={alwaysVisible || hover.isHovered}>
            <SessionSurfaceEntityDragHandle drag={drag} title={title} testID={`${testID}.move`}
                renderTrigger={({ toggle, grip }) => <View style={styles.header}>
                    {props.canEdit && props.organizing ? grip : null}
                    <ItemRowActions
                title={title}
                compactThreshold={ALWAYS_OVERFLOW}
                compactActionIds={[]}
                overflowMaxHeightCap={WIDGET_MENU_MAX_HEIGHT_PX}
                overflowTriggerTestID={`${testID}.menuTrigger`}
                overflowTriggerAccessibilityLabel={`${t('widgetAdd.widgetOptions')}: ${title}`}
                renderOverflowSurface={menuSurface}
                onOverflowTriggerKeyDown={key => stepWidgetSizeControl(sizeControl, key)}
                renderOverflowSection={({ id }) => renderWidgetSizeMenuSection(sizeControl, id, `${testID}.size`)}
                actions={orderWidgetMenu({
                    instance: buildWidgetInstanceActions({ ...(props.canEdit ? { editInputs: edit.editInputs, onRename: renaming.begin } : {}),
                        onMention: () => { void mention({ kind: 'widget-area-instance', scope: { serverId: surface.serverId, accountId: surface.accountId }, ref: { surface, instanceId: instance.id } }, title); } }),
                    size: buildWidgetSizeActions(sizeControl),
                    frame: !props.canEdit || parent ? [] : buildWidgetFrameStyleActions({
                        placement: GEOMETRY_PLACEMENT[geometry],
                        surfaceDefault: frame.areaDefault,
                        override: placement.frameStyle ?? null,
                        surfaceLabel: props.surfaceName,
                        onSet: (style) => { void write({ actionId: 'widgets.item.frame.set', instanceId: instance.id, frameStyle: style }); },
                    }),
                    // One Move… where the host binds widget movement: the Organize chooser lists every place
                    // it can go (lab dbind E). Without it, the steps that reorder this area.
                    move: props.canEdit ? [
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
                        ...(supportsGroups ? buildWidgetGroupMembershipActions({ instanceId: instance.id, size, items: props.layoutItems, area: props.area,
                            childTitle: props.childTitle, operations: props.groupOperations }) : []),
                    ] : [],
                    ...(props.canEdit && collapsible ? { collapse: [collapsed
                        ? { id: 'expand', title: t('projects.widgets.expand'), icon: 'arrows-out' as const, onPress: () => onCollapsedChange(false) }
                        : { id: 'collapse', title: t('projects.widgets.collapse'), icon: 'arrows-in' as const, onPress: () => onCollapsedChange(true) }] } : {}),
                    definition: buildWidgetDefinitionActions({ onAbout: definition.about, ...(props.canEdit ? { onAddTo: definition.addTo } : {}) }),
                    surface: props.canEdit ? bodyActions ?? [] : [],
                    remove: props.canEdit ? [{ id: 'remove', title: t('common.remove'), icon: 'trash', destructive: true,
                        onPress: () => { void write({ actionId: 'widgets.item.remove', instanceId: instance.id }); } }] : [],
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
            // Fills the frame's body room so a state replacing the body sits balanced in the card.
            <View testID={`${testID}.bodyHeight`} onLayout={onBodyLayout} style={{ flexGrow: 1 }}>
            <WidgetFrameBodyCaptionContext.Provider value={setBodyCaption}>
            <WidgetFrameBodyMetaContext.Provider value={setBodyMeta}>
            <WidgetFrameBodyActionsContext.Provider value={setBodyActions}>
            <WidgetFrameInstanceIdContext.Provider value={instance.id}>
            <WidgetSurface
                scope={surface}
                admittedViewer={props.admittedViewer ?? undefined}
                isCurrent={props.isCurrent}
                isReadPending={props.isReadPending}
                instance={instance}
                descriptor={candidate}
                providedContext={providedContext}
                projectContext={context.projectContext}
                groupBindings={groupContext}
                recordRevision={stableJsonStringify(instance)}
                presentation="content"
                size={size}
                appRuntime={runtime}
                {...(edit.onRepairInputs ? { onRepairInputs: edit.onRepairInputs } : {})}
                testID={`${testID}.body`}
            />
            </WidgetFrameInstanceIdContext.Provider>
            </WidgetFrameBodyActionsContext.Provider>
            </WidgetFrameBodyMetaContext.Provider>
            </WidgetFrameBodyCaptionContext.Provider>
            </View>
        ) : <View testID={`${testID}.deferred`} style={{ minHeight: bodyHeight }} />,
    }), [active, bodyHeight, candidate, edit.onRepairInputs, instance, onBodyLayout, providedContext, context.projectContext, groupContext, runtime, surface, testID, size, props.admittedViewer, props.isCurrent, props.isReadPending]);

    if (switchedOff) return null;
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
                source={groupNamesFollowed
                    ? bodyCaption ?? undefined
                    : followed
                        ? widgetGroupFollowSource(followed, parent?.wide === true)
                        : bodyCaption ?? bindingLabel ?? sourceName ?? undefined}
                meta={bodyMeta}
                grouped={parent !== undefined}
                // Every column's first widget leads: paired, the row reads level, with no hairline on one side only.
                leadsArea={props.index < (props.columnLayout?.columns ?? 1)}
                fill
                // A core page's rows take their content height (A6/A7): no fixed viewport, size and width kept.
                {...(surface.owner.kind === 'corePage' ? { bodyHeight: 'content' as const } : {})}
                menu={menu}
                {...(caretShown ? { disclosure: {
                    collapsed, onCollapsedChange,
                    expandLabel: t('projects.widgets.expand'), collapseLabel: t('projects.widgets.collapse'),
                } } : {})}
                body={body}
                // A change to this card that was refused stays on it, with Retry, until one succeeds.
                // The reason is the one failure presenter's (the same copy an Add refusal gets); a code it does not map keeps the static line.
                // A change that waits for someone's approval says so on the card it changes, as an add says Adding….
                footer={props.failed ? { kind: 'refreshFailed', reason: resolveActionExecutionErrorMessage({ errorCode: props.failed.errorCode }, t('widgetAdd.areaWriteFailed')), onRetry: props.failed.retry }
                    : props.pending ? { kind: 'pending', reason: t('widgetAdd.areaApprovalPending') } : null}
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
    areaChoice?: readonly Readonly<{ area: 'main' | 'aside'; label: string; title: string }>[];
    write: WidgetAreaWrite;
    onRequestClose: () => void;
    testID: string;
}>): React.ReactElement {
    const { write } = props;
    const [chosenArea, setChosenArea] = React.useState(props.area);
    const area = props.areaChoice ? chosenArea : props.area;
    const chosen = props.areaChoice?.find((option) => option.area === area);
    const instances = React.useMemo(() => props.placements.map((placement) => placement.instance), [props.placements]);
    const labels = React.useMemo(() => AREA_LABELS(props.surfaceName), [props.surfaceName]);
    const addInstance = React.useCallback((instance: WidgetInstanceV1, size?: WidgetSizeV1) => runAcknowledgedWidgetSetupCommand(
        () => write({ actionId: 'widgets.item.add', instance, ...(area ? { area } : {}), ...(size ? { size } : {}),
            ...(props.groupId ? { groupId: props.groupId } : {}) }), t('widgetAdd.addFailed'),
    ), [area, props.groupId, write]);
    const { sections, pendingSections } = useAccountWidgetAddSections({ scope: props.surface, instances, addInstance, labels, context: props.context,
        ...(area ? { area } : {}), testID: props.testID });
    const destination = props.areaChoice && area ? (
        <SegmentedTabBar
            tabs={props.areaChoice.map((option) => ({ id: option.area, label: option.label }))}
            activeTabId={area}
            onSelectTab={setChosenArea}
            segmentSizing="content"
            compact
            accessibilityLabel={chosen?.title ?? labels.submit}
            testIDPrefix={`${props.testID}.area`}
        />
    ) : undefined;
    return (
        <WidgetAddSurface
            open
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            title={chosen?.title ?? props.title ?? labels.submit}
            {...(destination ? { destination } : {})}
            hint={t('widgetAdd.areaHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            addLabel={labels.submit}
            sections={sections}
            pendingSections={pendingSections}
            serverId={props.surface.serverId}
            testID={props.testID}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    area: { gap: theme.space.s8 },
    header: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minHeight: HEADER_MIN_HEIGHT_PX },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary, flexShrink: 0 },
    // The section's title keeps its room; the quiet meta beside it is what gives way.
    meta: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary, flexShrink: 1, minWidth: 0 },
    grow: { flex: 1 },
    column: { gap: theme.space.s12 },
    // Below the layout tabs' rule the line keeps a section header's breath, as a description under a title does.
    dashboardEmpty: { ...Typography.default(), ...happierPageTextMetrics('sectionDescription'), color: theme.colors.text.secondary, paddingTop: HAPPIER_PAGE_METRICS.sectionHeaderGapPx },
    dashboardLoading: { gap: theme.space.s8, paddingTop: HAPPIER_PAGE_METRICS.sectionHeaderGapPx },
    addLineSpace: { height: ADD_LINE_PX },
    // The frame fills its grid cell, so cards in one row share a height.
    cell: { flexGrow: 1 },
}));
