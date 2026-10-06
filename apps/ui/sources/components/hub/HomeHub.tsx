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
import type { WidgetInputBindingsV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { HubCustomizeButton } from './header/HubCustomizeButton';
import { VoiceBriefBlock, VoiceBriefButton } from '@/components/voice/brief/VoiceBrief';
import { useVoiceBriefHomeRequest } from '@/components/voice/brief/useVoiceBriefRequest';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useIsTablet } from '@/utils/platform/responsive';
import { HubStatusLine } from './header/HubStatusLine';
import { useHomeGreeting } from './header/homeGreeting';
import { findHomeHubBuiltinSection } from './homeHubSections';
import { HomeHubSectionList } from './HomeHubSectionList';
import { HubWidgetSection } from './HubWidgetSection';
import type { HomeHubSection } from './layout/homeHubLayout';
import { HubSectionMenu } from './layout/HubSectionMenu';
import { useHomeHubLayout, type HomeHubLayout } from './layout/useHomeHubLayout';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { SessionSurfaceEntityFeedback, SessionSurfaceEntityTargetFeedback, useSessionSurfaceEntityDrag, useSessionSurfaceGeometryRefresh, type SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';
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
    onCustomize: () => void;
    placeholder: string;
    tracker: NearViewportTracker;
    widgetDrag: Pick<SessionSurfaceEntityBinding, 'scope' | 'isCurrent' | 'admitWidgetMovement'> | null;
}>;

/**
 * One home section with its hover-revealed "⋯" menu. Memoized on stable props, so a hub render
 * (the layout arriving, Customize opening) leaves every other section, and each widget, untouched.
 */
const HubSectionSlot = React.memo(function HubSectionSlot(props: SlotProps & Readonly<{
    section: HomeHubSection<WidgetCandidate>;
}>) {
    const section = props.section;
    if (section.kind === 'widget') return <HubWidgetSlot {...props} section={section} />;
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

function HubWidgetSlot(props: SlotProps & Readonly<{
    section: Extract<HomeHubSection<WidgetCandidate>, { kind: 'widget' }>;
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
    const edit = useWidgetInputsEditor({ instance, candidate: widget, scope, context: HOME_CONTEXT, audience: 'personal', setInputs: saveInputs, testID });
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
        />
    );
    return (
        <>
            <HubWidgetSection
                testID={testID}
                widget={props.section.widget}
                instance={props.section.instance}
                menu={menu}
                frameStyle={frameStyle}
                tracker={props.tracker}
                hoverProps={hover.hoverProps}
                titleEditor={renaming.field}
                {...(edit.onRepairInputs ? { onRepairInputs: edit.onRepairInputs } : {})}
                {...(props.widgetDrag ? { entityDrag: { ...props.widgetDrag,
                    title: props.section.instance.displayName ?? props.section.widget?.title ?? props.section.id,
                    getItem: () => props.layout.sections.some(section => section.kind === 'widget' && section.id === props.section.id)
                        ? { kind: 'home-section', scope: props.widgetDrag!.scope, sectionId: props.section.id } : null,
                } } : {})}
            />
            {edit.popover}
            {definition.panel}
        </>
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
    const admitWidgetMovement = movement.admit;
    const widgetDrag = React.useMemo(() => accountScope && focused && layout.status === 'ready' && guidance.kind !== 'loading'
        && guidance.kind !== 'connect_machine' && guidance.kind !== 'start_daemon' ? {
            scope: accountScope, admitWidgetMovement,
            isCurrent: () => { const current = getActiveServerAccountScope(); return current?.serverId === accountScope.serverId && current.accountId === accountScope.accountId; },
        } : null, [accountScope, focused, layout.status, guidance.kind, admitWidgetMovement]);
    const homeDrop = useSessionSurfaceEntityDrag(widgetDrag && surface ? { ...widgetDrag, title: t('common.home'), getItem: () => null,
        target: { acceptedKinds: ['session-board-item', 'companion-item', 'home-section', 'work-board-widget', 'widget-area-instance'],
            listDestinations: () => [{ destination: { index: 0 }, label: t('common.home'), group: t('common.home') }],
            resolve: ({ item }) => {
                const ref = widgetEntitySourceRef(item);
                if (!ref) return widgetMovementRefused('unsupported_widget_surface');
                return { status: 'allowed', effect: { actionId: 'widgets.instance.move', input: { ref, to: { surface, index: 0 } },
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

    const slotProps = { layout, onCustomize: openCustomize, placeholder: greeting.subtitle, tracker, widgetDrag };

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
                renderSection={(section, index) => (
                    <HubSectionSlot key={section.id} section={section} index={index} {...slotProps} />
                )}
            />
        </ItemList>
    );
});

const styles = {
    card: { flexGrow: 1 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
} as const;
