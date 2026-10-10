import * as React from 'react';
import { useWindowDimensions, View, type ScrollView } from 'react-native';

import { HomeWhereLine } from '@/components/homes/journeys/label/HomeWhereLine';
import { useReturningGreeting } from '@/components/onboarding/preAuth/useReturningGreeting';
import { useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useSessionGettingStartedGuidanceBaseModel } from '@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';
import { useWidgetFrameStyle } from '@/components/widgets/frame/useWidgetFrameStyle';
import { createNearViewportTracker, type NearViewportTracker } from '@/components/widgets/nearViewport';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { useWidgetDefinitionFlows } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { runWidgetSetupCommand, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { resolveWidgetSizeChoicesV1, type WidgetInputBindingsV1, type WidgetLayoutItemV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { WidgetGroupFrame } from '@/components/widgets/group/WidgetGroupFrame';
import { WidgetGroupMenuButton } from '@/components/widgets/group/WidgetGroupMenuButton';
import { WidgetGroupBar } from '@/components/widgets/group/WidgetGroupBar';
import { buildWidgetGroupMembershipActions, describeWidgetGroup, resolveWidgetGroupChildSizeLimit, type WidgetGroupOperations } from '@/components/widgets/group/widgetGroupMenu';
import { describeWidgetGroupContext, readWidgetGroupFollowedValue, widgetGroupPinnedSource, widgetGroupSurfaceContext } from '@/components/widgets/group/widgetGroupInputs';
import { resolveWidgetGroupCells, resolveWidgetGroupColumns } from '@/components/widgets/group/widgetGroupLayout';
import { resolveWidgetCardPointerDestination, resolveWidgetGroupPointerDestination, widgetGroupDropTarget, widgetLayoutCardDropTarget, widgetLayoutEndDropTarget, widgetLayoutSiblingIds } from '@/components/widgets/group/widgetGroupDropTarget';
import { HomeWidgetAddPopover } from '@/components/widgets/add/HomeWidgetAddPopover';
import { useWidgetGroupMenu } from '@/components/widgets/group/useWidgetGroupMenu';
import { WidgetGroupDropFeedback } from '@/components/widgets/group/WidgetGroupDropFeedback';
import { WidgetGroupMembershipArrivalView, useWidgetGroupMembershipArrivals } from '@/components/widgets/group/widgetGroupMembershipArrival';
import { useHomeWidgetGroupOperations } from './layout/useHomeWidgetGroupOperations';

import { HubCustomizeButton } from './header/HubCustomizeButton';
import { HomeCustomizeBar } from './header/HomeCustomizeBar';
import { EmptySlot } from '@/components/ui/empty/EmptySlot';
import { VoiceBriefBlock, VoiceBriefButton } from '@/components/voice/brief/VoiceBrief';
import { useVoiceBriefHomeRequest } from '@/components/voice/brief/useVoiceBriefRequest';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useIsTablet } from '@/utils/platform/responsive';
import { HubStatusLine } from './header/HubStatusLine';
import { useHomeGreeting } from './header/homeGreeting';
import { findHomeHubBuiltinSection, homeHubSectionTitle } from './homeHubSections';
import { HomeHubSectionList } from './HomeHubSectionList';
import { HubWidgetSection } from './HubWidgetSection';
import type { HomeHubSection } from './layout/homeHubLayout';
import { HubSectionMenu } from './layout/HubSectionMenu';
import { useHomeHubLayout, type HomeHubLayout } from './layout/useHomeHubLayout';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityFeedback, SessionSurfaceEntityTargetFeedback, useSessionSurfaceCarriedStyle, useSessionSurfaceEntityDrag, useSessionSurfaceGeometryRefresh, type SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { useWidgetMovementAdmission } from '@/components/widgets/surface/useWidgetMovementAdmission';
import { widgetEntitySourceRef, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { t } from '@/text';

// The Home on the status line: its name, and where it lives while nothing is running (J1).
const renderHomeLine = (detail: 'full' | 'name') => <HomeWhereLine detail={detail} separated />;


/** Home has no Session of its own: a Session input there is chosen, never borrowed from the page. */
const HOME_CONTEXT: WidgetSurfaceContext = Object.freeze({});

type SlotProps = Readonly<{
    index: number;
    layout: HomeHubLayout;
    topLevelIds: readonly string[];
    onCustomize: () => void;
    placeholder: string;
    tracker: NearViewportTracker;
    homeSurface: WidgetSurfaceRefV1 | null;
    widgetDrag: Pick<SessionSurfaceEntityBinding, 'scope' | 'isCurrent' | 'admitWidgetMovement'> | null;
    /** Customize is open: a lone grouped widget keeps its half beside an empty slot. */
    customizing: boolean;
    /** Move handles show only while Home is being customized; in view mode a card shows ⋯ on hover and nothing else. */
    showGrips: boolean;
    groupOperations: WidgetGroupOperations;
    /** The carried widget's current placement on its own surface, for a group's width admission. */
    movementSourceItem: WidgetLayoutItemV1 | undefined;
}>;

type HubGroupSection = Extract<HomeHubSection<WidgetCandidate>, { kind: 'group' }>;
type HubWidgetSectionModel = Extract<HomeHubSection<WidgetCandidate>, { kind: 'widget' }>;

/** A widget inside a group: where it sits there, and whether its cell has room for the full follow phrase. */
type HubGroupChildPlacement = Readonly<{ group: HubGroupSection; index: number; wide: boolean }>;

/**
 * One home section with its hover-revealed "⋯" menu. Memoized on stable props, so a hub render
 * (the layout arriving, Customize opening) leaves every other section, and each widget, untouched.
 */
const HubSectionSlot = React.memo(function HubSectionSlot(props: SlotProps & Readonly<{
    section: HomeHubSection<WidgetCandidate>;
}>) {
    const section = props.section;
    if (section.kind === 'widget') return <HubWidgetSlot {...props} section={section} />;
    if (section.kind === 'group') return <HubGroupSlot {...props} section={section} />;
    return <HubBuiltinSlot {...props} section={section} />;
});

function HubBuiltinSlot(props: SlotProps & Readonly<{
    section: Extract<HomeHubSection<WidgetCandidate>, { kind: 'builtin' }>;
}>) {
    const hover = useRowActionHoverHost();
    const definition = findHomeHubBuiltinSection(props.section.id);
    const frameStyle = useWidgetFrameStyle('home', props.section.frameStyle);
    if (!definition) return null;
    const menu = (
        <HubSectionMenu
            section={props.section}
            index={props.index}
            layout={props.layout}
            hovered={hover.isHovered}
            onCustomize={props.onCustomize}
        />
    );
    return (
        <View testID={`home-hub.section.${props.section.id}`} style={definition.card ? styles.card : undefined} {...hover.hoverProps}>
            {definition.render({ menu, placeholder: props.placeholder, frameStyle })}
        </View>
    );
}

/** A Home card's drop target: the line above or below it, in its group when it is grouped. */
function homeCardTarget(input: Readonly<{ surface: WidgetSurfaceRefV1; items: readonly WidgetLayoutItemV1[]; itemId: string; title: string;
    topLevelIds: readonly string[];
    groupId: string | undefined; sourceItem: WidgetLayoutItemV1 | undefined; childTitle: (instanceId: string) => string }>): Pick<SessionSurfaceEntityBinding, 'target' | 'pointerDestination' | 'getWidgetAreaTarget'> {
    return {
        target: widgetLayoutCardDropTarget({ surface: input.surface, items: input.items, itemId: input.itemId, title: input.title,
            topLevelIds: input.topLevelIds,
            groupId: input.groupId, groupLabel: t('common.home'), sourceItem: input.sourceItem,
            describeGroup: group => describeWidgetGroup(group, input.childTitle) }),
        pointerDestination: (bounds, pointer) => resolveWidgetCardPointerDestination(input.itemId, input.groupId, bounds, pointer),
        getWidgetAreaTarget: () => ({ surface: input.surface, groupId: input.groupId ?? null, itemId: input.itemId,
            itemIds: widgetLayoutSiblingIds(input.items, input.groupId, input.topLevelIds) }),
    };
}

/** What a widget or group is called on Home, for group names and menus. */
function homeChildTitle(layout: HomeHubLayout) {
    return (instanceId: string): string => {
        for (const section of layout.sections) {
            if (section.kind === 'widget' && section.id === instanceId) return homeHubSectionTitle(section);
            if (section.kind === 'group') {
                const child = section.children.find(entry => entry.id === instanceId);
                if (child) return homeHubSectionTitle(child);
            }
        }
        return instanceId;
    };
}

/**
 * One widget group on Home (lab widget-groups wgpres): the group frame with its widgets packed
 * inside. A titled group carries its ⋯; an untitled one has no header and its options live in
 * Customize. The group is also a drop target: a widget dropped on it goes in, through the shared
 * entity owner's admission (width fit, no nesting).
 */
function HubGroupSlot(props: SlotProps & Readonly<{ section: HubGroupSection }>) {
    const hover = useRowActionHoverHost();
    const phone = !useIsTablet();
    const { section, layout } = props;
    const group = section.group;
    const testID = `home-hub.section.${section.id}`;
    const childTitle = React.useMemo(() => homeChildTitle(layout), [layout]);
    const name = describeWidgetGroup(group, childTitle);
    const cells = React.useMemo(() => resolveWidgetGroupCells('home', section.children.map(child => ({ id: child.id, size: child.size }))),
        [section.children]);
    const columns = resolveWidgetGroupColumns(group.width, phone);
    const menu = useWidgetGroupMenu({
        group, childTitle, candidates: section.children.map(child => child.widget ?? null), scope: props.homeSurface, context: HOME_CONTEXT,
        operations: props.groupOperations, showWidth: !phone,
        rename: title => layout.rename(group.id, title), setInputs: bindings => layout.setGroupInputs(group.id, bindings), testID,
    });
    // The whole group lifts by its grip (or, with a fine pointer, by its frame) and is a drop target:
    // into it, or beside it at its top or bottom edge (lab wgdnd B).
    const homeSurface = props.homeSurface;
    const drop = useSessionSurfaceEntityDrag(props.widgetDrag && homeSurface ? {
        ...props.widgetDrag, title: name,
        getItem: () => layout.items.some(item => item.kind === 'group' && item.id === group.id)
            ? { kind: 'widget-layout-group', scope: props.widgetDrag!.scope, ref: { surface: homeSurface, instanceId: group.id } } : null,
        getWidgetAreaTarget: () => ({ surface: homeSurface, groupId: null, itemId: group.id, itemIds: widgetLayoutSiblingIds(layout.items, undefined, props.topLevelIds) }),
        pointerDestination: (bounds, pointer) => resolveWidgetGroupPointerDestination(group.id, bounds, pointer),
        target: widgetGroupDropTarget({ surface: homeSurface, items: layout.items, topLevelIds: props.topLevelIds, group, name, sourceItem: props.movementSourceItem,
            describeGroup: entry => describeWidgetGroup(entry, childTitle) }),
    } : null);
    const carriedStyle = useSessionSurfaceCarriedStyle(drop);
    // "add one" in a group's empty slot opens Add aimed at this group (lab wgvar 6).
    const slotAnchorRef = React.useRef<View | null>(null);
    const [slotAddOpen, setSlotAddOpen] = React.useState(false);
    const openSlotAdd = React.useCallback(() => setSlotAddOpen(true), []);
    const closeSlotAdd = React.useCallback(() => setSlotAddOpen(false), []);
    const grip = props.widgetDrag && props.showGrips ? <SessionSurfaceEntityDragHandle drag={drop} title={name} testID={`${testID}.move`} /> : null;
    const sourceValue = describeWidgetGroupContext(group.context);
    const renderChild = React.useCallback((instanceId: string, placement: Readonly<{ wide: boolean }>) => {
        const index = section.children.findIndex(child => child.id === instanceId);
        const child = section.children[index];
        if (!child) return null;
        return <HubWidgetSlot {...props} section={child} index={index} parent={{ group: section, index, wide: placement.wide }} />;
    }, [props, section]);
    return (
        <View {...hover.hoverProps} style={styles.card}>
            <WidgetGroupFrame
                testID={testID}
                group={group}
                placement="home"
                cells={cells}
                columns={columns}
                customizing={props.customizing}
                // Customizing: the bar stands in the header's place (grip, name field, width, ⋯), for titled and untitled groups alike.
                {...(props.customizing ? { bar: <WidgetGroupBar input={menu.menuInput} onRename={menu.commitName} anchorRef={menu.anchorRef} grip={grip} testID={`${testID}.bar`} /> } : {})}
                onAddToGroup={openSlotAdd}
                addAnchorRef={slotAnchorRef}
                title={props.customizing ? null : group.title !== undefined || menu.renameField ? menu.renameField ?? group.title ?? null : null}
                source={sourceValue ? widgetGroupPinnedSource(sourceValue) : undefined}
                menu={props.customizing ? null : <WidgetGroupMenuButton input={menu.menuInput} visible={hover.isHovered} anchorRef={menu.anchorRef} testID={`${testID}.menu`} />}
                accessibilityLabel={t('widgetFrame.groupA11y', { name })}
                renderChild={renderChild}
                dropRef={drop.ref}
                carriedStyle={carriedStyle}
                onDropLayout={drop.onLayout}
                dropFeedback={homeSurface ? <WidgetGroupDropFeedback drag={drop} group={group} surface={homeSurface} testID={`${testID}.drop`} /> : null}
            />
            {menu.overlays}
            <HomeWidgetAddPopover open={slotAddOpen} anchorRef={slotAnchorRef} onRequestClose={closeSlotAdd} groupId={group.id} testID={`${testID}.slotAdd`} />
        </View>
    );
}

function HubWidgetSlot(props: SlotProps & Readonly<{
    section: HubWidgetSectionModel;
    parent?: HubGroupChildPlacement;
}>) {
    const hover = useRowActionHoverHost();
    const frameStyle = useWidgetFrameStyle('home', props.section.frameStyle);
    const testID = `home-hub.section.${props.section.id}`;
    const { instance, widget } = props.section;
    const { setInputs, rename } = props.layout;
    const account = useActiveServerAccountScope();
    const scope = React.useMemo<WidgetSurfaceRefV1 | null>(() => (
        account ? { serverId: account.serverId, accountId: account.accountId, owner: { kind: 'home' } } : null
    ), [account]);
    // Edit inputs… and the card's repair line: this copy only, through the Home layout owner.
    const saveInputs = React.useCallback((bindings: WidgetInputBindingsV1) => (
        runWidgetSetupCommand(() => setInputs(instance.id, bindings), t('widgetAdd.saveFailed'))
    ), [instance.id, setInputs]);
    // Inside a group with inputs, following the group is one of this copy's choices.
    const groupContext = props.parent?.group.group.context;
    const context = React.useMemo(() => widgetGroupSurfaceContext(HOME_CONTEXT, groupContext), [groupContext]);
    const edit = useWidgetInputsEditor({ instance, candidate: widget, scope, context, audience: 'personal', setInputs: saveInputs, testID });
    const followed = readWidgetGroupFollowedValue(instance, groupContext);
    const childTitle = React.useMemo(() => homeChildTitle(props.layout), [props.layout]);
    const groupActions = buildWidgetGroupMembershipActions({ instanceId: instance.id, size: props.section.size, items: props.layout.items,
        childTitle, operations: props.groupOperations });
    const parent = props.parent;
    const sizeLimit = parent ? resolveWidgetGroupChildSizeLimit({ group: parent.group.group, groupName: homeHubSectionTitle(parent.group),
        surface: 'home', sizes: resolveWidgetSizeChoicesV1('home', widget?.sizeDeclaration).sizes }) : undefined;
    const inGroup = parent ? { index: parent.index, count: parent.group.children.length,
        onMove: (delta: -1 | 1) => props.groupOperations.move(instance.id, parent.index + delta, parent.group.id) } : undefined;
    // About this widget (lab dagent G2) for a copy of one of the Account's own widgets.
    const definition = useWidgetDefinitionFlows({ instance, scope, anchorRef: edit.anchorRef, editInputs: edit.editInputs, testID });
    // Rename stays optional (lab dbind N1): an empty name, or the widget's own, goes back to it.
    const renaming = useWidgetFrameRename({
        title: instance.displayName ?? widget?.title ?? instance.id,
        testID,
        onRename: (next) => {
            const displayName = next.length > 0 && next !== widget?.title ? next : undefined;
            if (displayName !== instance.displayName) return rename(instance.id, displayName);
        },
    });
    // "Open <plugin>" is the card's footer; the menu keeps Edit inputs, Rename, width, hide, move and Customize.
    const menu = (
        <HubSectionMenu
            section={props.section}
            index={props.index}
            layout={props.layout}
            hovered={hover.isHovered}
            onCustomize={props.onCustomize}
            anchorRef={edit.anchorRef}
            {...(edit.editInputs ? { editInputs: edit.editInputs } : {})}
            {...(renaming.begin ? { onRename: renaming.begin } : {})}
            {...(definition.about ? { onAbout: definition.about } : {})}
            {...(inGroup ? { inGroup } : {})}
            groupActions={groupActions}
            {...(sizeLimit ? { sizeLimit } : {})}
        />
    );
    return (
        <>
            <HubWidgetSection
                testID={testID}
                widget={props.section.widget}
                instance={props.section.instance}
                size={props.section.size}
                menu={menu}
                frameStyle={frameStyle}
                tracker={props.tracker}
                hoverProps={hover.hoverProps}
                titleEditor={renaming.field}
                grouped={parent !== undefined}
                halfCell={parent !== undefined && !parent.wide}
                showGrip={props.showGrips}
                groupBindings={groupContext}
                {...(followed ? { followSource: { value: followed, wide: parent?.wide ?? true } } : {})}
                {...(edit.onRepairInputs ? { onRepairInputs: edit.onRepairInputs } : {})}
                {...(props.widgetDrag && props.homeSurface ? { entityDrag: { ...props.widgetDrag,
                    // The line between cards reorders here; inside a group, within that group (lab wgdnd B).
                    ...homeCardTarget({ surface: props.homeSurface, items: props.layout.items, itemId: props.section.id,
                        topLevelIds: props.topLevelIds,
                        title: props.section.instance.displayName ?? props.section.widget?.title ?? props.section.id,
                        groupId: props.parent?.group.id, sourceItem: props.movementSourceItem, childTitle }),
                    title: props.section.instance.displayName ?? props.section.widget?.title ?? props.section.id,
                    getItem: () => props.layout.items.some(item => item.kind === 'widget' ? item.instance.id === props.section.id
                        : item.children.some(child => child.instance.id === props.section.id))
                        ? { kind: 'home-section', scope: props.widgetDrag!.scope, sectionId: props.section.id } : null,
                } } : {})}
            />
            {edit.popover}
            {definition.panel}
        </>
    );
}

/** The id the new-row target answers the indicator owner with: it is no card, so the whole slot outlines. */
const NEW_ROW_TARGET_ID = 'home-hub.new-row';
/** Tall enough to aim at while carrying a card: two touch rows. */
const NEW_ROW_MIN_HEIGHT_PX = 2 * PAGE_ROW_TOUCH_MIN_HEIGHT_PX;

/**
 * The one "new row" target that ends Home while it is customized (lab wgmenu E): a widget or a whole
 * group dropped here goes to the end of Home, out of any group, through `widgets.item.move`.
 */
function HomeNewRowTarget(props: Readonly<{
    widgetDrag: NonNullable<SlotProps['widgetDrag']>;
    surface: WidgetSurfaceRefV1;
    layout: HomeHubLayout;
    topLevelIds: readonly string[];
    sourceItem: WidgetLayoutItemV1 | undefined;
}>) {
    const { surface, layout } = props;
    const drop = useSessionSurfaceEntityDrag({
        ...props.widgetDrag, title: t('homeIndex.newRow'), getItem: () => null,
        getWidgetAreaTarget: () => ({ surface, groupId: null, itemId: NEW_ROW_TARGET_ID, itemIds: [] }),
        target: widgetLayoutEndDropTarget({ surface, items: layout.items, topLevelIds: props.topLevelIds, sourceItem: props.sourceItem,
            verb: t('homeIndex.newRowVerb'), label: t('homeIndex.newRow'), groupLabel: t('common.home') }),
    });
    return (
        <ItemGroup surface="none">
            <View ref={drop.ref} collapsable={false} onLayout={drop.onLayout}>
                <EmptySlot testID="home-hub.new-row" icon="plus" label={t('homeIndex.newRow')} minHeight={NEW_ROW_MIN_HEIGHT_PX} />
                <SessionSurfaceEntityTargetFeedback drag={drop} testID="home-hub.new-row.drop" />
            </View>
        </ItemGroup>
    );
}

/**
 * The app home (the main pane when no session is open, and the page the phone's logo opens): a
 * greeting with one line about the present and Customize, then the Account's sections in its
 * chosen order. It composes the hub section owners the Settings Overview also uses. Before a machine
 * can run a session (none yet, or none running), and while that is not known yet, the
 * getting-started guidance is the home instead.
 */
export const HomeHub = React.memo(function HomeHub() {
    const guidance = useSessionGettingStartedGuidanceBaseModel();
    const greeting = useReturningGreeting();
    const title = useHomeGreeting();
    const layout = useHomeHubLayout();
    const topLevelIds = layout.order;
    const [customizeOpen, setCustomizeOpen] = React.useState(false);
    // Brief me (lab voice-moments B0/B1): the greeting turns into the brief, in place, while open.
    const [briefOpen, setBriefOpen] = React.useState(false);
    const phone = !useIsTablet();
    const listRef = React.useRef<ScrollView>(null);
    const contentRef = React.useRef<View>(null);
    // A section's "⋯ → Customize" opens the header's popover; bring the header into view first so
    // the popover opens beside its button, not off-screen.
    const openCustomize = React.useCallback(() => {
        listRef.current?.scrollTo({ y: 0, animated: false });
        setCustomizeOpen(true);
    }, []);
    // Where the page is scrolled, for the widgets' near-viewport rule. It is a store the widgets
    // subscribe to one by one; scrolling never re-renders the hub.
    const initialViewportHeight = useWindowDimensions().height;
    const [tracker] = React.useState(() => createNearViewportTracker({
        quantum: PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
        initialViewportHeight,
        readContentNode: () => contentRef.current ?? listRef.current?.getInnerViewNode(),
    }));
    React.useEffect(() => { tracker.invalidateLayout(); }, [tracker, layout.sections]);
    const accountScope = useActiveServerAccountScope();
    const focused = useIsFocused();
    useVoiceBriefHomeRequest({
        available: focused && guidance.kind !== 'loading' && guidance.kind !== 'connect_machine' && guidance.kind !== 'start_daemon',
        onOpen: () => setBriefOpen(true),
    });
    const surface = React.useMemo(() => accountScope ? { ...accountScope, owner: { kind: 'home' as const } } : null, [accountScope]);
    const movement = useWidgetMovementAdmission(focused ? surface : null, layout.sections);
    const groupOperations = useHomeWidgetGroupOperations(layout);
    const arrivals = useWidgetGroupMembershipArrivals(layout.items);
    const admitWidgetMovement = movement.admit;
    const widgetDrag = React.useMemo(() => accountScope && focused && layout.status === 'ready' && guidance.kind !== 'loading'
        && guidance.kind !== 'connect_machine' && guidance.kind !== 'start_daemon' ? {
            scope: accountScope, admitWidgetMovement,
            isCurrent: () => { const current = getActiveServerAccountScope(); return current?.serverId === accountScope.serverId && current.accountId === accountScope.accountId; },
        } : null, [accountScope, focused, layout.status, guidance.kind, admitWidgetMovement]);
    const homeDrop = useSessionSurfaceEntityDrag(widgetDrag && surface ? { ...widgetDrag, title: t('common.home'), getItem: () => null,
        target: { acceptedKinds: ['session-board-item', 'companion-item', 'home-section', 'work-board-widget', 'widget-area-instance', 'widget-layout-group'],
            listDestinations: () => [{ destination: { index: 0 }, label: t('common.home'), group: t('common.home') }],
            resolve: ({ item }) => {
                const ref = widgetEntitySourceRef(item);
                if (!ref) return widgetMovementRefused('unsupported_widget_surface');
                return { status: 'allowed', effect: { actionId: 'widgets.item.move', input: { ref, to: { surface, index: 0 } },
                    preview: { glyph: 'move', verb: t('sessionBoard.item.moveTargetView', { title: t('common.home') }), target: t('common.home') } } };
            },
            execute: async () => ({ status: 'refused', reason: { code: 'invalid_parameters', message: t('entityDragDrop.reasons.generic') } }),
        },
    } : null);
    useSessionSurfaceGeometryRefresh(homeDrop.refresh);
    const homeListRef = React.useCallback((node: ScrollView | null) => { listRef.current = node; homeDrop.ref(node); }, [homeDrop.ref]);

    // Until the model knows, the pane holds a quiet page: neither the hub (which could swap to the
    // guidance) nor the guidance's mark draws before the answer, so nothing moves on arrival.
    if (guidance.kind === 'loading') {
        // A Home that does not answer turns this into "Can't reach {Home}" with Retry, not an endless wait.
        return (
            <HomeReachabilityGate variant="pane">
                <ItemList testID="home-hub.loading">{null}</ItemList>
            </HomeReachabilityGate>
        );
    }
    if (guidance.kind === 'connect_machine' || guidance.kind === 'start_daemon') {
        return <SessionGettingStartedGuidance variant="primaryPane" />;
    }

    const closeCustomize = () => setCustomizeOpen(false);
    const slotProps = { layout, topLevelIds, onCustomize: openCustomize, placeholder: greeting.subtitle, tracker, widgetDrag,
        customizing: customizeOpen, showGrips: customizeOpen, groupOperations, movementSourceItem: movement.sourceItem, homeSurface: surface };

    return (
        // RN's innerViewRef declaration omits the null lifecycle supported by its native forwarder.
        <ItemList
            ref={homeListRef}
            innerViewRef={contentRef as React.RefObject<View>}
            testID="home-hub"
            onScroll={tracker.onScroll}
            onLayout={event => { tracker.onLayout(event); homeDrop.onLayout(event); }}
            onContentSizeChange={tracker.onContentSizeChange}
            scrollEventThrottle={16}
        >
            <PageHeader
                title={title}
                titleProminence={phone ? 'hero' : 'page'}
                alwaysShowTitle
                details={<HubStatusLine home={renderHomeLine} />}
                actions={(
                    <View style={styles.headerActions}>
                        {phone ? null : <VoiceBriefButton open={briefOpen} onOpen={() => setBriefOpen(true)} />}
                        <HubCustomizeButton open={customizeOpen} onOpenChange={setCustomizeOpen} />
                    </View>
                )}
            />
            {customizeOpen ? <HomeCustomizeBar onDone={closeCustomize} interactionBoundaryRef={contentRef} /> : null}
            {phone && !briefOpen ? (
                // Phone (lab B0p): the brief's entry spans the page under the greeting.
                <ItemGroup surface="none">
                    <VoiceBriefButton open={briefOpen} onOpen={() => setBriefOpen(true)} block />
                </ItemGroup>
            ) : null}
            {briefOpen ? <VoiceBriefBlock onClose={() => setBriefOpen(false)} /> : null}
            <SessionSurfaceEntityFeedback kind="home-section" scope={accountScope} address={null} testID="home-hub.widget-move" />
            <SessionSurfaceEntityTargetFeedback drag={homeDrop} testID="home-hub.widget-move" />
            <HomeHubSectionList
                sections={layout.sections}
                renderSection={(section, index) => section.kind === 'builtin' ? (
                    <HubSectionSlot key={section.id} section={section} index={index} {...slotProps} />
                ) : (
                    // Ungroup fans its widgets out to their own cards; Group with merges cards into one.
                    <WidgetGroupMembershipArrivalView key={section.id} arrival={arrivals.get(section.id)} style={styles.card}>
                        <HubSectionSlot section={section} index={index} {...slotProps} />
                    </WidgetGroupMembershipArrivalView>
                )}
            />
            {customizeOpen && widgetDrag && surface ? (
                <HomeNewRowTarget widgetDrag={widgetDrag} surface={surface} layout={layout} topLevelIds={topLevelIds} sourceItem={movement.sourceItem} />
            ) : null}
        </ItemList>
    );
});

const styles = {
    card: { flexGrow: 1 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
} as const;
