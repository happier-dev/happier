import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import type { Href } from 'expo-router';
import Animated, { type SharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFloatingBackdropPicture } from '@/components/atmosphere/atmosphereBackdrop';
import { AtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { useAtmosphereStageSnapshot } from '@/components/atmosphere/atmosphereStage';
import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { NewSessionScreen } from '../NewSessionScreen';
import { NewSessionEmbeddedHostProvider, type NewSessionEmbeddedHost } from '../navigation/newSessionHost';
import { useNewSessionShellHost } from '../navigation/newSessionEntry';
import { resolveNewSessionDockPaneElement } from './newSessionDockPane';
import { SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT } from './NewSessionSimplePanel';
import { useFloatingComposerEntrance } from './useFloatingComposerEntrance';
import { requestRegisteredComposerBlur } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { ComposerKeyboardScaffold } from '@/components/sessions/keyboardAvoidance';
import { PopoverScope } from '@/components/ui/popover';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { EscapeLayerProvider, ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { SCREEN_OVERLAY_Z_INDEX } from '@/components/ui/overlays/overlayLayers';
import { NativeBackLayerBoundary } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { ScrimBand } from '@/components/ui/overlays/ScrimBand';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { useSessionViewContentBottomSpacing } from '@/components/sessions/shell/view/useSessionViewContentBottomSpacing';
import { SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX } from '@/components/sessions/shell/view/resolveSessionViewContentBottomSpacing';
import { useReportSessionCockpitFloatingBottomChromeHeight, useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useActiveServerAccountScope, useSession, useSetting } from '@/sync/store/hooks';
import { getStorage, useLocalSetting } from '@/sync/domains/state/storage';
import { focusNewSessionComposerWhenPresented } from '../navigation/newSessionComposerFocus';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { OVERLAY_CAPSULE_BUTTON_SIZE, OverlayCapsuleButton } from '@/components/ui/overlays/OverlayCapsuleButton';
import { ResizableDockedPane } from '@/components/ui/panels/ResizableDockedPane';
import { AgentInputPopoverWidthContext } from '@/components/sessions/agentInput/selection/useAgentInputPopoverLayout';
import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { NewSessionComposerCloseButton } from './NewSessionComposerCloseButton';
import { useNewSessionDraftHasText } from '../hooks/useNewSessionDraftPresentation';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { t } from '@/text';
import { blurActiveElementOnWeb } from '@/utils/platform/deferOnWeb';

/**
 * How far the band runs above the dock on a desktop: it holds the page colour from the card's top edge down
 * and dissolves over the rest, so a longer run than the phone's keeps that dissolve soft over a wide page.
 */
const DESKTOP_DOCK_RAMP_HEIGHT = 200;
/** A narrowed card stops at the dialog width (or the pane's composer width, when that is narrower). */
const DOCK_MIN_WIDTH = PAGE_LIST_METRICS.dialogWidthPx.default;

/** The page column the dock centres on, in window coordinates: its left edge, width and bottom edge. */
type DockPane = Readonly<{ left: number; width: number; bottom: number }>;

/**
 * Where the page column sits, measured from the shell the page draws (web desktop; it follows the window,
 * the navigation column, a side panel and the page shown). Elsewhere the window is the column.
 */
function useDockPane(enabled: boolean, windowWidth: number, windowHeight: number, origin: unknown): DockPane {
    const pathname = usePathname();
    const [measured, setMeasured] = React.useState<DockPane | null>(null);
    React.useEffect(() => {
        if (!enabled || typeof document === 'undefined' || typeof ResizeObserver === 'undefined') return undefined;
        let observed: Element | null = null;
        const update = () => {
            const element = resolveNewSessionDockPaneElement(origin);
            if (element !== observed) {
                if (observed) observer.unobserve(observed);
                observed = element;
                if (element) observer.observe(element);
            }
            if (!element) return;
            const rect = element.getBoundingClientRect();
            const next = { left: Math.round(rect.left), width: Math.round(rect.width), bottom: Math.round(rect.bottom) };
            setMeasured((previous) => previous && previous.left === next.left && previous.width === next.width
                && previous.bottom === next.bottom ? previous : next);
        };
        const observer = new ResizeObserver(update);
        update();
        // A page shown by this navigation lays out after it.
        const frame = requestAnimationFrame(update);
        window.addEventListener('resize', update);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', update);
            observer.disconnect();
        };
    }, [enabled, pathname, origin]);
    return enabled && measured ? measured : { left: 0, width: windowWidth, bottom: windowHeight };
}

/**
 * Where the dock sits: a phone seats it above whatever bar the page has, full width; a desktop seats it where
 * the page's Session composer sits, centred on the page column at that composer's width and bottom gap, so
 * New is already where the Session continues after Send. The card and its folded pill share the seat.
 */
function useDockSeat() {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const phone = isMobileLayoutWidth(width);
    const origin = useNewSessionShellHost()?.origin ?? null;
    const pane = useDockPane(Platform.OS === 'web' && !phone, width, height, origin);
    const sessionComposerGap = useSessionViewContentBottomSpacing(pane.width);
    const composerMaxWidth = useLayoutMaxWidth('conversation');
    const bottomChrome = useSessionCockpitBottomChromeHeight();
    const reach = phone ? { right: 0, bottom: bottomChrome + theme.space.s8 } : { right: 0, bottom: height - pane.bottom + sessionComposerGap };
    // The bar the seat clears on a phone: a keyboard covers it first, so the card rides the keyboard at its gap.
    const clearedChrome = phone ? bottomChrome : 0;
    // The Session composer's own width in this column: the reading width, inside its side insets.
    // The widest the card may be: the column inside the composer's own side insets.
    const columnWidth = Math.max(0, pane.width - COMPOSER_CONTENT_HORIZONTAL_INSET * 2);
    const composerWidth = Math.min(composerMaxWidth, columnWidth);
    // The folded pill rests centred in the band under that composer (its gap and its own bottom padding), so on a
    // Session page it never covers the composer; where the band is narrower it rests on the column's bottom edge.
    const bandBelowComposer = sessionComposerGap + SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX;
    const pillBottom = height - pane.bottom + Math.max(0, (bandBelowComposer - OVERLAY_CAPSULE_BUTTON_SIZE) / 2);
    return { phone, pane, reach, pillBottom, clearedChrome, sessionComposerGap, composerWidth, columnWidth, windowWidth: width };
}

const commitDockWidth = (widthPx: number | null) => getStorage().getState().applyLocalSettings({ newSessionDockedWidthPx: widthPx }, { source: 'ui' });
// Reset returns the card to the Session composer's width, whatever that is in the column it is in.
const resetDockWidth = () => commitDockWidth(null);

/** The folded dock: a capsule in the card's seat that names it and marks a draft with text. Pressing it is New again. */
function DockedPill() {
    const shell = useNewSessionShellHost()!;
    const { pane, pillBottom } = useDockSeat();
    const scope = useActiveServerAccountScope() ?? null;
    const draftId = typeof shell.host.params.draftId === 'string' ? shell.host.params.draftId : null;
    const hasText = useNewSessionDraftHasText(scope, draftId);
    const { open } = shell;
    const restore = React.useCallback(() => open(), [open]);
    return <View pointerEvents="box-none" style={[styles.pillSeat, { left: pane.left, width: pane.width, bottom: pillBottom }]}>
        <OverlayCapsuleButton testID="new-session-docked-pill" icon="caret-up" label={t('sessionDrafts.new.action')} dot={hasText}
            accessibilityLabel={t('sessionDrafts.new.action')} accessibilityValue={hasText ? { text: t('sessionDrafts.badge') } : undefined}
            onPress={restore} />
    </View>;
}

/** The frost around the dock, carrying the picture of whatever the page shows. */
function DockedBackdrop(props: Readonly<{ shown: boolean; progress: SharedValue<number>; phone: boolean; reach: Readonly<{ left?: number; right: number; bottom: number }> }>) {
    const stage = useAtmosphereStageSnapshot().stage;
    const picture = useFloatingBackdropPicture(stage?.backdrop ?? null);
    const strength = useSetting('newSessionBackdropStrengthV1');
    return <ScrimBand testID="new-session-docked-band" shown={props.shown} progress={props.progress} picture={picture} strength={strength} reach={props.reach}
        axes={props.phone ? 'top' : 'centre'} rampHeight={props.phone ? SIMPLE_NEW_SESSION_SCRIM_RAMP_HEIGHT : DESKTOP_DOCK_RAMP_HEIGHT} />;
}

/** The root keeps the card above the navigator and consumes only the first outside keyboard-dismissal tap. */
export function NewSessionDockedHost(props: React.PropsWithChildren) {
    const shell = useNewSessionShellHost();
    const draftId = shell?.visible && typeof shell.host.params.draftId === 'string' ? shell.host.params.draftId : null;
    const [nativeFocused, setNativeFocused] = React.useState(false);
    React.useEffect(() => { setNativeFocused(false); }, [draftId]);
    const pointer = resolveOverlayPointerEvents('box-none');
    return <View style={{ flex: 1 }}>
        {props.children}
        {/* Open on another screen, the dock is hidden, not retired: it stays mounted (its draft and composer document
            live, readable by their exact ref) but takes no layout, touch, focus or inset until its screen is back. */}
        {shell?.retained ? <PluginSurfaceFocusEligibilityProvider active={shell.visible}>
        <View testID="new-session-docked-retained" pointerEvents={shell.visible ? pointer.nativePointerEvents : 'none'}
            aria-hidden={shell.visible ? undefined : true}
            importantForAccessibility={shell.visible ? 'auto' : 'no-hide-descendants'}
            style={[StyleSheet.absoluteFillObject, styles.layer, pointer.webStyle, shell.visible ? null : styles.hidden]}>
            {Platform.OS !== 'web' && nativeFocused ? <Pressable
                testID="new-session-docked-dismiss-keyboard" style={StyleSheet.absoluteFillObject}
                accessibilityRole="button" accessibilityLabel={t('common.dismissKeyboard')}
                onPress={() => {
                    if (draftId) requestRegisteredComposerBlur({ kind: 'newSession', instanceId: draftId });
                }} /> : null}
            {shell.collapsed ? <DockedPill /> : <PopoverScope><DockedComposer nativeFocused={nativeFocused} onNativeFocusChange={setNativeFocused} /></PopoverScope>}
        </View>
        </PluginSurfaceFocusEligibilityProvider> : null}
    </View>;
}

function DockedComposer(props: Readonly<{ nativeFocused: boolean; onNativeFocusChange: (focused: boolean) => void }>) {
    const shell = useNewSessionShellHost()!;
    const router = useRouter();
    const { phone, pane, reach, clearedChrome, sessionComposerGap, composerWidth, columnWidth, windowWidth: width } = useDockSeat();
    const portalTarget = useModalPortalTarget();
    const composerRef = React.useRef<View | null>(null);
    const [webFocused, setFocused] = React.useState(false);
    const focused = Platform.OS === 'web' ? webFocused : props.nativeFocused;
    const bandBoundary = React.useMemo(() => ({ ref: undefined, onLayout: () => {},
        onFocusChange: (next: boolean) => { if (Platform.OS !== 'web') props.onNativeFocusChange(next); },
    }), [props.onNativeFocusChange]);
    const [leaving, setLeaving] = React.useState(false);
    const entrance = useFloatingComposerEntrance(true);
    // The page under the dock clears it like the shell's other floating band, so nothing it covers is out of reach.
    const reportCoveredBottom = useReportSessionCockpitFloatingBottomChromeHeight(!leaving && shell.visible);
    // What the page under the card must clear past its own bottom edge: on a phone the gap above the bar; on a
    // desktop the card sits in the page's pane, so only its gap above that pane's bottom.
    const coveredGap = phone ? reach.bottom - clearedChrome : sessionComposerGap;
    const onDockLayout = React.useCallback((event: LayoutChangeEvent) => {
        reportCoveredBottom(event.nativeEvent.layout.height + coveredGap);
    }, [coveredGap, reportCoveredBottom]);
    const { close, collapse } = shell;
    const dismiss = React.useCallback(() => {
        setLeaving(true);
        entrance.leave(close);
    }, [close, entrance.leave]);
    // Folding plays the same exit; the pill takes the seat once the card has gone, and the draft is kept.
    const fold = React.useCallback(() => {
        setLeaving(true);
        entrance.leave(collapse);
    }, [collapse, entrance.leave]);
    // Open hands the seat to the Session it started: that page's own composer and its permission footer sit
    // exactly where the card does, so the card folds to its pill (same exit, draft kept) as the Session opens.
    const openCreated = React.useCallback((href: string) => {
        router.push(href as Href);
        fold();
    }, [fold, router]);
    const host = React.useMemo<NewSessionEmbeddedHost>(() => ({
        ...shell.host,
        onOpenStartedSession: openCreated,
        // The status row is the card's header, seated on the dock's frost: quiet icons, as on every width.
        // A phone keeps its labelled draft actions and has no fold (portrait Docked is never collapsed).
        // Unwrapped, so each icon is the row's own item and takes the row's one gap, like the draft actions.
        statusTrailingActions: <>
            {phone ? null : <IconButton testID="new-session-docked-collapse" variant="plain" iconName="caret-down" tooltipPlacement="top"
                size={AGENT_INPUT_QUIET_ICON_SIZE_PX}
                accessibilityLabel={t('common.collapse')} tooltip={t('common.collapse')} onPress={fold} />}
            <NewSessionComposerCloseButton onPress={dismiss} />
        </>,
    }), [dismiss, fold, openCreated, phone, shell.host]);
    const draftId = typeof shell.host.params.draftId === 'string' ? shell.host.params.draftId : null;
    const layer = useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.overlay,
        enabled: focused,
        allowEditableTarget: true,
        onEscape: () => { dismiss(); return true; },
    });

    React.useEffect(() => {
        if (!draftId) return;
        return focusNewSessionComposerWhenPresented(draftId);
    }, [draftId, shell.focusRequest]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !isMobileLayoutWidth(width) || typeof document === 'undefined') return;
        let dismissingKeyboard = false;
        const dismissKeyboardFirst = (event: PointerEvent) => {
            dismissingKeyboard = false;
            const node = composerRef.current as unknown as HTMLElement | null;
            const active = document.activeElement;
            const target = event.target;
            if (!(target instanceof Node) || !node || !(active instanceof HTMLElement)) return;
            if (node.contains(target) || portalTarget?.contains(target)) return;
            if (!node.contains(active) || !active.matches('input, textarea, [contenteditable="true"]')) return;
            dismissingKeyboard = true;
            blurActiveElementOnWeb();
            event.preventDefault();
            event.stopPropagation();
        };
        const consumeDismissalClick = (event: MouseEvent) => {
            if (!dismissingKeyboard) return;
            dismissingKeyboard = false;
            event.preventDefault();
            event.stopPropagation();
        };
        document.addEventListener('pointerdown', dismissKeyboardFirst, true);
        document.addEventListener('click', consumeDismissalClick, true);
        return () => {
            document.removeEventListener('pointerdown', dismissKeyboardFirst, true);
            document.removeEventListener('click', consumeDismissalClick, true);
        };
    }, [portalTarget, width]);

    const pointer = resolveOverlayPointerEvents('box-none');
    // A desktop web card opens at the Session composer's width and narrows or widens from either side edge
    // around its centre, up to the column; kept on this device like the shell's pane widths, and clamped
    // to the column it is in now (a side panel opening, a narrower window).
    const resizable = Platform.OS === 'web' && !phone;
    const minWidth = Math.min(DOCK_MIN_WIDTH, composerWidth);
    const storedWidth = useLocalSetting('newSessionDockedWidthPx');
    const dockWidth = storedWidth === null ? composerWidth : Math.min(columnWidth, Math.max(minWidth, storedWidth));
    // The frost clears within the page column: it never spills over the navigation column or a side panel.
    const sideRoom = Math.max(0, (pane.width - dockWidth) / 2);
    const card = <Animated.View onLayout={entrance.onComposerLayout} style={entrance.style}>
        <AtmosphereBandBoundary.Provider value={bandBoundary}>
        <NewSessionEmbeddedHostProvider host={host}>
            <AgentInputPopoverWidthContext.Provider value="window">
                <ComposerBannerCollapseProvider key={draftId}>
                    <NewSessionScreen presentation="embedded" />
                </ComposerBannerCollapseProvider>
            </AgentInputPopoverWidthContext.Provider>
        </NewSessionEmbeddedHostProvider>
        </AtmosphereBandBoundary.Provider>
    </Animated.View>;
    const dock = <View
        ref={composerRef}
        testID="new-session-docked-host"
        onLayout={onDockLayout}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
            const next = (event as unknown as { relatedTarget?: Node }).relatedTarget;
            const node = composerRef.current as unknown as HTMLElement | null;
            if (!next || (!node?.contains(next) && !portalTarget?.contains(next))) setFocused(false);
        }}
        style={phone ? [styles.phone, { marginBottom: reach.bottom }] : resizable ? null : { width: dockWidth }}
    >
        {/* The card clears the bar; its paint reaches only through the gap above that bar. */}
        <DockedBackdrop shown={!leaving} progress={entrance.enterProgress} phone={phone}
            reach={phone ? { right: reach.right, bottom: reach.bottom - clearedChrome } : { left: sideRoom, right: sideRoom, bottom: reach.bottom }} />
        {resizable ? (
            <ResizableDockedPane testID="new-session-docked-resize" resizeEdge="both"
                widthPx={dockWidth} minWidthPx={minWidth} maxWidthPx={columnWidth}
                onCommitWidthPx={commitDockWidth} onResetRequest={resetDockWidth}>
                {card}
            </ResizableDockedPane>
        ) : card}
    </View>;
    // A desktop seat spans the page column and centres the card in it, so a resize keeps the centre.
    const composer = phone ? dock : <View pointerEvents={pointer.nativePointerEvents}
        style={[styles.desktopSeat, pointer.webStyle, { marginLeft: pane.left, width: pane.width, marginBottom: reach.bottom }]}>
        {dock}
    </View>;
    return <EscapeLayerProvider layer={layer}>
        <NativeBackLayerBoundary active={focused} onRequestClose={dismiss} forwardInputBack>
        <View pointerEvents={pointer.nativePointerEvents} style={[{ flex: 1 }, pointer.webStyle]}>
            <ComposerKeyboardScaffold mode="newSession" surface="transparent" layoutBottomInset={clearedChrome} composer={composer} composerPointerEvents="box-none" pointerEvents="box-none"
                contentProps={{ pointerEvents: 'box-none' }}
                style={pointer.webStyle} contentStyle={pointer.webStyle}>
                {null}
            </ComposerKeyboardScaffold>
        </View>
        </NativeBackLayerBoundary>
    </EscapeLayerProvider>;
}

const styles = StyleSheet.create((theme) => ({
    layer: { zIndex: SCREEN_OVERLAY_Z_INDEX },
    hidden: { display: 'none' },
    desktopSeat: { alignSelf: 'flex-start', alignItems: 'center' },
    phone: { width: '100%', paddingHorizontal: theme.space.s12 },
    pillSeat: { position: 'absolute', alignItems: 'center' },
}));
