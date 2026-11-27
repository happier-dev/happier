import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { welcomePlanetPose, type WelcomePlanetState } from '@happier-dev/brand/planet-placement';

import { useFirstOpenContentLayout } from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { FIRST_RUN_WORKFLOW_LAYER, StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';

import { BrandWordmark } from './BrandWordmark';
import { WelcomeFooterLinks } from './WelcomeFooterLinks';
import { STEP_ROW_BUTTON_PX, StepBackContext, StepRowBackButton, UNAUTH_BACK_TEST_ID, useStepBackSlot, WIDE_STEP_COLUMN_PX, WideStepColumnContext } from './stepBack';

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { RELAY_RETENTION_LINE_PX, RelayRetentionDisclosure } from './RelayRetentionDisclosure';
import { ShellCornerContext, ShellCornerNoteContext, ShellHeaderClearanceContext, ShellWelcomeOverflowContext, type ShellCornerDoor, type ShellCornerNote } from './shellCorner';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';

/** The wordmark's corner (lab direction A): 24 px tall, 24 px in from a phone's side and 20 px down. */
const MOBILE_WORDMARK_INSET_PX = 24;
const MOBILE_WORDMARK_TOP_PX = 20;
const WORDMARK_HEIGHT_PX = 24;
/** The welcome column starts this far below a phone's corner wordmark. */
const MOBILE_ROW_WORDMARK_CLEARANCE_PX = 24;
/** A phone's Back row (lab phone steps): the round Back well a little in from the corner, the column below it. */
const MOBILE_BACK_ROW_TOP_PX = 12;
const MOBILE_BACK_ROW_CLEARANCE_PX = 8;
const MOBILE_WORDMARK_ROW_BOTTOM_PX = MOBILE_WORDMARK_TOP_PX + WORDMARK_HEIGHT_PX + MOBILE_ROW_WORDMARK_CLEARANCE_PX;

/**
 * Matches the legacy WizardCardLayout card-width hint (`size: 'md'`, `width: 500`).
 * The effective content max width is `min(useModalCardDimensions(...).width,
 * layout.maxWidth)`, which resolves to ~500px on desktop and scales down
 * gracefully on narrow viewports — identical to the cap the pre-redesign
 * wizard used.
 */
const WORKFLOW_CARD_WIDTH_HINT = 500;
const WORKFLOW_MOBILE_TOP_PADDING = 28;
/** The phone's side gutter (direction A: 16 px). */
const WORKFLOW_MOBILE_HORIZONTAL_PADDING = 16;
const WORKFLOW_MOBILE_BOTTOM_PADDING = 28;
/**
 * The desktop horizontal padding that sits inside the pane's `maxWidth`. The
 * visible pane width = content width + 2× this gutter. Kept in sync with the
 * `desktopPadding` style below.
 */
const WORKFLOW_DESKTOP_HORIZONTAL_GUTTER = 64;
const DESKTOP_WELCOME_TOP_PADDING_PX = 56;
/** The desktop wordmark's corner inset, on the page's outer gutter (lab direction A). */
const DESKTOP_WORDMARK_INSET_PX = 40;
/** A computer's wordmark sits 52 px down, its centre on the corner pill's (lab direction A). */
const DESKTOP_WORDMARK_TOP_PX = 52;
/** A computer's wordmark is a size up from a phone's (lab direction A: 26 px against 24). */
const DESKTOP_WORDMARK_HEIGHT_PX = 26;
const CORNER_PILL_HEIGHT_PX = 40;
const DESKTOP_PANE_BOTTOM_PADDING_PX = 28;
const FOOTER_CONTROL_SIZE_PX = 28;
/** The retention disclosure's widest measure on a computer; its words wrap inside it. */
const RETENTION_NOTE_MAX_WIDTH_PX = 400;
/** The footer row carries the disclosure only while it reads in this many lines there. */
const RETENTION_ROW_MAX_LINES = 2;
const STEP_SCROLL_FADE_EDGES = { bottom: true } as const;
const STEP_TRANSITION_FILL_STYLE: ViewStyle = {
    flex: 1,
    minHeight: 0,
};
// On the welcome step we don't want the transition frame to flex-stretch
// inside the scroll column — its natural height is the height of the welcome
// content, and a flexible spacer below it pushes the footer to the bottom on
// tall viewports while collapsing on short ones (and scrolling kicks in).
const STEP_TRANSITION_NATURAL_STYLE: ViewStyle = {
    width: '100%',
};

export type WorkflowPanelPresentation = 'padded' | 'fullBleed';

export type WorkflowPanelProps = Readonly<{
    variant: 'desktop' | 'mobile';
    children: React.ReactNode;
    isWelcomeStep: boolean;
    planetState?: WelcomePlanetState;
    /** Shows the compact mobile product mark on focused public entry flows. */
    showMobileWordmark?: boolean;
    onBack?: () => void;
    transitionKey: string;
    warmStepMotion?: boolean;
    presentation?: WorkflowPanelPresentation;
    onColumnLayout?: (event: LayoutChangeEvent) => void;
    webAtmosphere?: () => HTMLElement | undefined;
    /**
     * One trailing control at the pane's bottom right (the signed-out Updates entry): the end of
     * the welcome help row, and a row of its own under every later step, so it never floats over
     * a step's heading.
     */
    footerAccessory?: React.ReactNode;
    testID?: string;
}>;

/**
 * The workflow pane of the desktop split (or the full-screen content area on
 * mobile-workflow). Registers the step body with the app motion stage and
 * renders the round Back well when the wizard/route
 * supports back navigation; renders the welcome footer links only when the
 * current step is the welcome decision screen.
 *
 * All colors come from theme tokens; the workflow pane respects light/dark.
 */
export const WorkflowPanel = React.memo(function WorkflowPanel(props: WorkflowPanelProps) {
    const { theme } = useUnistyles();
    const safeAreaInsets = useSafeAreaInsets();
    const styles = stylesheet;
    const isMobile = props.variant === 'mobile';
    const isFullBleed = props.presentation === 'fullBleed';
    const focused = useOptionalScreenIsFocused();
    const { slot: backSlot, inRow } = useStepBackSlot(focused ? props.onBack : undefined, isMobile || isFullBleed ? 'platform' : 'row');
    // Android Back and Escape use the same slot as the visible control.
    useNativeBackLayerBackHandler(backSlot !== null, () => {
        backSlot?.onBack();
        return true;
    });
    useEscapeLayer({
        enabled: backSlot !== null,
        priority: ESCAPE_LAYER_PRIORITIES.pane,
        onEscape: () => backSlot?.onBack(),
    });
    // A step that draws Back itself (in its row on a computer, or a dead end's pill on any device) claims the slot.
    const cornerBack = !inRow;
    // The welcome's "Run your own Home" door, in the page's top-right corner on a computer (lab direction A).
    const [cornerDoor, setCornerDoor] = React.useState<ShellCornerDoor | null>(null);
    const cornerSlot = isMobile ? null : setCornerDoor;
    // Welcome publishes its disclosure to the shell footer on both widths.
    const [cornerNote, setCornerNote] = React.useState<ShellCornerNote | null>(null);
    const [noteHeight, setNoteHeight] = React.useState(0);
    const [trailHeight, setTrailHeight] = React.useState<number | null>(null);
    const onCornerNoteLayout = React.useCallback((event: LayoutChangeEvent) => {
        setNoteHeight(event.nativeEvent.layout.height);
    }, []);
    const onTrailLayout = React.useCallback((event: LayoutChangeEvent) => {
        setTrailHeight(event.nativeEvent.layout.height);
    }, []);
    const noteGap = theme.space.s8;
    const [paneSize, setPaneSize] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    // On a computer the disclosure is laid out at one width wherever it stands: at most half the footer row less the
    // trailing control, so it never reaches the links in the left corner or the centre of the window.
    const footerRowWidth = !isMobile && paneSize ? paneSize.width - 2 * DESKTOP_WORDMARK_INSET_PX : null;
    const noteWidth = footerRowWidth === null ? null : Math.max(0, Math.min(RETENTION_NOTE_MAX_WIDTH_PX,
        footerRowWidth / 2 - (props.footerAccessory ? FOOTER_CONTROL_SIZE_PX + noteGap : 0)));
    const noteMeasured = noteHeight > 0 && trailHeight !== null && (isMobile || noteWidth !== null);
    const noteRowMaxHeight = RETENTION_ROW_MAX_LINES * RELAY_RETENTION_LINE_PX + 2 * (theme.space.s8 + StyleSheet.hairlineWidth);
    // Beside Updates when it reads in two lines there; otherwise stacked over (or, without room, under) the footer.
    // Before its first measure it lays out unseen where a computer would carry it.
    const noteInRow = noteWidth !== null && (!noteMeasured || noteHeight <= noteRowMaxHeight + 0.5);
    const noteBelowFooter = !noteInRow && trailHeight !== null && noteHeight + noteGap > trailHeight;
    const noteOverflow = props.isWelcomeStep && cornerNote && noteBelowFooter ? noteHeight + noteGap : 0;
    const pane = React.useRef<View>(null);
    const readWebChrome = React.useCallback((scope?: 'shell') => {
        const root = pane.current;
        if (typeof HTMLElement === 'undefined' || !(root instanceof HTMLElement)) return [];
        // The opening builds the wordmark. A step move only copies a compact mark that can disappear.
        const welcomeWordmark = scope === 'shell' || (isMobile && !props.showMobileWordmark)
            ? ', [data-testid="welcome-mobile-wordmark"]' : '';
        return Array.from(root.querySelectorAll<HTMLElement>(
            `[data-testid="unauth-shell-corner"], [data-testid="unauth-shell-welcome-footer"]${welcomeWordmark}`,
        ));
    }, [isMobile, props.showMobileWordmark]);
    const cardDimensions = useModalCardDimensions({ size: 'md', width: WORKFLOW_CARD_WIDTH_HINT });
    const layoutMaxWidth = useLayoutMaxWidth();
    // The pane is capped at exactly the wizard card width (~500px) including
    // its own horizontal padding — i.e. the visible right block is at most
    // 500px wide, with the padding absorbed inside that cap. On mobile the
    // cap is undefined so the pane fills the screen.
    // A choice step claims the wide column (two option cards side by side), and gives it back when it leaves.
    const [wideColumnClaims, setWideColumnClaims] = React.useState(0);
    const claimWideColumn = React.useCallback(() => {
        setWideColumnClaims((count) => count + 1);
        return () => setWideColumnClaims((count) => count - 1);
    }, []);
    const paneMaxWidth = isMobile
        ? undefined
        : Math.min(wideColumnClaims > 0 ? WIDE_STEP_COLUMN_PX : cardDimensions.width, layoutMaxWidth);
    // Padding lives on the inner scroll content (not the outer pane) so the
    // back-chevron stays anchored to the viewport while the welcome content +
    // footer flow through a single vertically-scrollable column. On tall
    // screens the flex spacer inside the column pushes the footer to the
    // bottom (visual parity with the prior fixed-position layout); on short
    // screens the spacer collapses and the column scrolls — content and
    // footer always remain reachable instead of overlapping.
    // The wordmark stands top-left on every welcome step and wherever a step asks for it (direction A).
    const showMobileWordmark = !isMobile || props.isWelcomeStep || props.showMobileWordmark === true;
    const mobileBackRow = isMobile && props.onBack != null && !isFullBleed && cornerBack;
    const mobileBackTop = showMobileWordmark ? MOBILE_WORDMARK_ROW_BOTTOM_PX : MOBILE_BACK_ROW_TOP_PX;
    const contentPaddingStyle: ViewStyle = isMobile
        ? isFullBleed
            ? styles.contentMobileFullBleedPadding
            : {
                // A welcome column taller than a short phone scrolls from below the corner wordmark,
                // never under it.
                paddingTop: (mobileBackRow
                    ? mobileBackTop + STEP_ROW_BUTTON_PX + MOBILE_BACK_ROW_CLEARANCE_PX
                    : showMobileWordmark ? MOBILE_WORDMARK_ROW_BOTTOM_PX : WORKFLOW_MOBILE_TOP_PADDING)
                    + safeAreaInsets.top,
                paddingRight: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.right,
                paddingBottom: WORKFLOW_MOBILE_BOTTOM_PADDING + safeAreaInsets.bottom,
                paddingLeft: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left,
            }
        : props.isWelcomeStep ? styles.contentDesktopPadding : styles.contentDesktopStepPadding;
    const headerBottom = isMobile
        ? MOBILE_WORDMARK_ROW_BOTTOM_PX + safeAreaInsets.top
        : DESKTOP_WORDMARK_TOP_PX + DESKTOP_WORDMARK_HEIGHT_PX;
    const [headerClearance, setHeaderClearance] = React.useState(0);
    const [welcomeScrollHeight, setWelcomeScrollHeight] = React.useState(0);
    const [welcomeOverflow, setWelcomeOverflow] = React.useState(0);
    const onWelcomeScrollLayout = React.useCallback((event: LayoutChangeEvent) => {
        setWelcomeScrollHeight(event.nativeEvent.layout.height);
    }, []);
    // Grow the scroll extent by the same amount as the tail, leaving the original flex space for the column.
    const scrollOverflow = welcomeOverflow + noteOverflow;
    const welcomeScrollMinimum = props.isWelcomeStep && scrollOverflow > 0 && welcomeScrollHeight > 0
        ? { minHeight: welcomeScrollHeight + scrollOverflow }
        : undefined;
    // A step's column scrolls in the sky above the planet: its viewport ends a clearance above the limb the
    // atmosphere draws (the same pose owner), so a tall form scrolls there instead of running into the glyphs. The
    // band under it holds only the pane's corner accessory. The welcome lays out its own doors above the planet.
    const onPaneLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setPaneSize(current => current?.width === width && current.height === height ? current : { width, height });
    }, []);
    const planetBand = !props.isWelcomeStep && !isFullBleed && paneSize
        ? Math.max(0, Math.round(paneSize.height
            - welcomePlanetPose(props.planetState ?? 'deep', paneSize, { phone: isMobile }).limb
            + theme.space.s24))
        : 0;
    // A step longer than that sky fades out at its edge while more of it (its actions) lies below.
    const stepFades = useScrollEdgeFades({ enabledEdges: STEP_SCROLL_FADE_EDGES });
    const stepEdgeMask = !props.isWelcomeStep && Platform.OS === 'web' ? resolveVerticalScrollEdgeMaskStyle(stepFades.visibility) : null;
    const { onColumnLayout } = props;
    const onOpeningLayout = useFirstOpenContentLayout();
    const onStepLayout = React.useCallback((event: LayoutChangeEvent) => {
        onColumnLayout?.(event);
        onOpeningLayout?.(event, props.planetState);
    }, [onColumnLayout, onOpeningLayout, props.planetState]);
    const onWelcomeColumnLayout = React.useCallback((event: LayoutChangeEvent) => {
        setHeaderClearance(Math.max(0, Math.floor(event.nativeEvent.layout.y - headerBottom)));
        onStepLayout(event);
    }, [headerBottom, onStepLayout]);

    // The disclosure stands on the Welcome's glass, as its doors and corner pill do: the planet reads through it, and
    // its words take the stronger ink the material gives text over the atmosphere.
    const retentionNote = props.isWelcomeStep && cornerNote ? (
        <View
            testID="unauth-shell-retention"
            onLayout={onCornerNoteLayout}
            pointerEvents={noteMeasured ? 'auto' : 'none'}
            style={[noteWidth === null ? styles.cornerNoteCompact : { width: noteWidth }, noteMeasured ? null : styles.measuringNote]}
        >
            <GlassSurface surfaceGroup="card" nested finishRole={null} solidColor={theme.colors.surface.base}
                style={[styles.cornerNoteSurface, { borderColor: theme.colors.border.default }]}>
                <RelayRetentionDisclosure testID="welcome-retention"
                    disclosure={{ ...cornerNote.disclosure, retry: cornerNote.onRetry }} />
            </GlassSurface>
        </View>
    ) : null;

    return (
        <View
            ref={pane}
            testID={props.testID ?? 'unauth-shell-workflow-pane'}
            // The pane is transparent: the shell's welcome atmosphere draws the page behind it.
            style={styles.paneOuter}
            onLayout={onPaneLayout}
        >
            {showMobileWordmark ? (
                <View
                    testID="welcome-mobile-wordmark"
                    style={[
                        styles.mobileWordmark,
                        isMobile ? {
                            top: MOBILE_WORDMARK_TOP_PX + safeAreaInsets.top,
                            left: MOBILE_WORDMARK_INSET_PX + safeAreaInsets.left,
                        } : styles.desktopWordmark,
                    ]}
                    pointerEvents="box-none"
                >
                    <BrandWordmark height={isMobile ? WORDMARK_HEIGHT_PX : DESKTOP_WORDMARK_HEIGHT_PX} />
                </View>
            ) : null}
            {backSlot && isFullBleed ? (
                <View
                    style={[
                        styles.backChevronContainer,
                        isMobile ? {
                            top: MOBILE_BACK_ROW_TOP_PX + safeAreaInsets.top,
                            left: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left,
                        } : null,
                    ]}
                >
                    <StepRowBackButton onPress={backSlot.onBack} />
                </View>
            ) : null}
            {backSlot && !isFullBleed && cornerBack ? (
                <View
                    testID="unauth-shell-back-row"
                    style={[
                        styles.backRowFloating,
                        isMobile
                            ? {
                                top: mobileBackTop + safeAreaInsets.top,
                                left: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left,
                            }
                            : styles.backRowDesktop,
                    ]}
                >
                    <StepRowBackButton onPress={backSlot.onBack} />
                </View>
            ) : null}

            {cornerDoor ? (
                <View testID="unauth-shell-corner" style={styles.cornerDoor} pointerEvents="box-none">
                    <WelcomeActionCard testID={cornerDoor.testID} title={cornerDoor.label} presentation="pill"
                        iconName="hard-drives" trailingIconName="caret-right"
                        disabled={!cornerDoor.onPress} onPress={() => cornerDoor.onPress?.()} />
                </View>
            ) : null}
            <ShellCornerContext.Provider value={cornerSlot}>
            <ShellCornerNoteContext.Provider value={props.isWelcomeStep ? setCornerNote : null}>
            <ShellHeaderClearanceContext.Provider value={props.isWelcomeStep ? headerClearance : 0}>
            <ShellWelcomeOverflowContext.Provider value={props.isWelcomeStep ? setWelcomeOverflow : null}>
            <StepBackContext.Provider value={backSlot}>
            <WideStepColumnContext.Provider value={isMobile ? null : claimWideColumn}>
            <ScrollView
                testID="unauth-shell-workflow-scroll"
                style={[styles.scrollFill, stepEdgeMask]}
                contentContainerStyle={[styles.scrollContent, contentPaddingStyle, welcomeScrollMinimum]}
                onLayout={props.isWelcomeStep ? onWelcomeScrollLayout : stepFades.onViewportLayout}
                onContentSizeChange={props.isWelcomeStep ? undefined : stepFades.onContentSizeChange}
                onScroll={props.isWelcomeStep ? undefined : stepFades.onScroll}
                onMomentumScrollEnd={props.isWelcomeStep ? undefined : stepFades.onMomentumScrollEnd}
                scrollEventThrottle={64}
                showsVerticalScrollIndicator={false}
                bounces={false}
                keyboardShouldPersistTaps="handled"
            >
                {props.isWelcomeStep ? (
                    // Welcome layout depends on platform:
                    //  - Desktop: content at the top of the pane, spacer in
                    //    the middle, footer at the bottom — content-first
                    //    reading order, matches the original visual rhythm.
                    //  - Mobile:  spacer at the top, content at the bottom,
                    //    footer below content — keeps the buttons close to
                    //    the user's thumb and stacks the heading directly
                    //    above the buttons against the rising planet
                    //    backdrop. Footer sits just below.
                    isMobile ? (
                        <>
                            {/* As on a computer: the column stands above the planet, two parts of the free height above it. */}
                            <View style={styles.welcomeLead} />
                            <View onLayout={onWelcomeColumnLayout}>
                                <StepMotionLayer
                                    layerKey={FIRST_RUN_WORKFLOW_LAYER}
                                    webChrome={readWebChrome}
                                    webAtmosphere={props.webAtmosphere}
                                    active={focused}
                                    warmOnMount={props.warmStepMotion}
                                    backTestID={UNAUTH_BACK_TEST_ID}
                                    testID="unauth-shell-step-transition"
                                    stepKey={props.transitionKey}
                                    compact={isMobile}
                                    style={STEP_TRANSITION_NATURAL_STYLE}
                                >
                                    {props.children}
                                </StepMotionLayer>
                            </View>
                        </>
                    ) : (
                        <>
                            {/* The welcome's doors stand above the planet: two parts of the free height above, three below. */}
                            <View style={[styles.welcomeLead, styles.welcomeLeadDesktop]} />
                            <StepMotionLayer
                                layerKey={FIRST_RUN_WORKFLOW_LAYER}
                                webChrome={readWebChrome}
                                webAtmosphere={props.webAtmosphere}
                                active={focused}
                                warmOnMount={props.warmStepMotion}
                                backTestID={UNAUTH_BACK_TEST_ID}
                                testID="unauth-shell-step-transition"
                                stepKey={props.transitionKey}
                                compact={isMobile}
                                onLayout={onWelcomeColumnLayout}
                                style={[STEP_TRANSITION_NATURAL_STYLE, { maxWidth: paneMaxWidth }, styles.desktopColumn]}
                            >
                                {props.children}
                            </StepMotionLayer>
                        </>
                    )
                ) : (
                    // Non-welcome steps keep the legacy fill behaviour so step
                    // bodies that center themselves vertically (restore, scan…)
                    // continue to look right.
                    <>
                        <StepMotionLayer
                            layerKey={FIRST_RUN_WORKFLOW_LAYER}
                            webChrome={readWebChrome}
                            webAtmosphere={props.webAtmosphere}
                            active={focused}
                            warmOnMount={props.warmStepMotion}
                            backTestID={UNAUTH_BACK_TEST_ID}
                            testID="unauth-shell-step-transition"
                            stepKey={props.transitionKey}
                            compact={isMobile}
                            onLayout={onColumnLayout || onOpeningLayout ? onStepLayout : undefined}
                            style={isMobile ? STEP_TRANSITION_FILL_STYLE : [STEP_TRANSITION_FILL_STYLE, { maxWidth: paneMaxWidth }, styles.desktopColumn]}
                        >
                            {props.children}
                        </StepMotionLayer>
                    </>
                )}
                {props.isWelcomeStep ? (
                    <>
                        <View testID="unauth-shell-welcome-trail" style={styles.welcomeTrail} onLayout={onTrailLayout} />
                        <View testID="unauth-shell-welcome-footer" style={isMobile ? undefined : styles.desktopFooterCorner}>
                            <WelcomeFooterLinks variant={props.variant} trailing={props.footerAccessory}
                                trailingSize={FOOTER_CONTROL_SIZE_PX} note={noteInRow ? retentionNote : null} />
                            {retentionNote && !noteInRow ? (
                                <View
                                    pointerEvents="box-none"
                                    style={[
                                        styles.cornerNote,
                                        noteBelowFooter
                                            ? { top: '100%', marginTop: noteGap }
                                            : { bottom: '100%', marginBottom: noteGap },
                                    ]}
                                >
                                    {retentionNote}
                                </View>
                            ) : null}
                        </View>
                        {noteOverflow > 0 ? <View style={{ height: noteOverflow }} /> : null}
                    </>
                ) : null}
            </ScrollView>
            {props.isWelcomeStep ? null : (
                <View testID="unauth-shell-planet-band" pointerEvents="box-none"
                    style={[styles.planetBand, { minHeight: planetBand }]}>
                    {props.footerAccessory ? (
                        <View
                            testID="unauth-shell-footer-accessory"
                            style={[
                                styles.footerAccessoryRow,
                                isMobile
                                    ? {
                                        paddingRight: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.right,
                                        paddingBottom: WORKFLOW_MOBILE_BOTTOM_PADDING + safeAreaInsets.bottom,
                                    }
                                    : styles.footerAccessoryRowDesktop,
                            ]}
                        >
                            {props.footerAccessory}
                        </View>
                    ) : null}
                </View>
            )}
            </WideStepColumnContext.Provider>
            </StepBackContext.Provider>
            </ShellWelcomeOverflowContext.Provider>
            </ShellHeaderClearanceContext.Provider>
            </ShellCornerNoteContext.Provider>
            </ShellCornerContext.Provider>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    paneOuter: {
        flex: 1,
        minHeight: 0,
    },
    scrollFill: {
        flex: 1,
        width: '100%',
    },
    // flexGrow:1 makes the inner column fill the ScrollView viewport on tall
    // screens (so the flex spacer below the welcome content can push the
    // footer down). When the column's intrinsic height exceeds the viewport,
    // the ScrollView scrolls instead of clipping.
    scrollContent: {
        flexGrow: 1,
        flexDirection: 'column',
    },
    contentDesktopPadding: {
        paddingTop: DESKTOP_WELCOME_TOP_PADDING_PX,
        paddingHorizontal: WORKFLOW_DESKTOP_HORIZONTAL_GUTTER,
        paddingBottom: DESKTOP_PANE_BOTTOM_PADDING_PX,
    },
    // A step after the welcome starts its column where the lab's steps do (direction A: the heading's first line at the
    // lab's 100 px), clear of the wordmark row, rather than at the welcome's pane edge.
    contentDesktopStepPadding: {
        paddingTop: 96,
        paddingHorizontal: WORKFLOW_DESKTOP_HORIZONTAL_GUTTER,
        paddingBottom: DESKTOP_PANE_BOTTOM_PADDING_PX,
    },
    contentMobileFullBleedPadding: {
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
    },
    welcomeLead: {
        flex: 2,
        minHeight: 0,
    },
    welcomeLeadDesktop: {
        minHeight: DESKTOP_WORDMARK_TOP_PX + DESKTOP_WORDMARK_HEIGHT_PX - DESKTOP_WELCOME_TOP_PADDING_PX,
    },
    welcomeTrail: {
        flex: 3,
        minHeight: 0,
    },
    planetBand: {
        justifyContent: 'flex-end',
    },
    footerSpacer: {
        flex: 1,
        // Allow the spacer to collapse below its natural height on short
        // viewports so the column's intrinsic content+footer height exceeds
        // the viewport and the ScrollView takes over.
        minHeight: 0,
    },
    // The welcome footer's row height and bottom inset, so the accessory sits in the same corner on
    // every step: desktop adds the footer's own 28px bottom padding, mobile adds none.
    footerAccessoryRow: {
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingTop: 20,
        minHeight: 20 + FOOTER_CONTROL_SIZE_PX,
    },
    // The welcome footer's corner: the links' inset from the pane's side, their 28 px from its bottom.
    footerAccessoryRowDesktop: {
        paddingRight: DESKTOP_WORDMARK_INSET_PX,
        paddingBottom: 28,
        minHeight: 20 + FOOTER_CONTROL_SIZE_PX + 28,
    },
    backChevronContainer: {
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 1,
    },
    backRowFloating: {
        position: 'absolute',
        zIndex: 1,
    },
    // Under the wordmark on the page's outer gutter (lab direction A), for a step without its own row.
    backRowDesktop: {
        top: DESKTOP_WORDMARK_TOP_PX + WORDMARK_HEIGHT_PX + 16,
        left: DESKTOP_WORDMARK_INSET_PX,
    },
    // Stacked on the footer, right-aligned with its trailing control, outside the main column's flow.
    cornerNote: {
        position: 'absolute',
        left: 0,
        right: 0,
        alignItems: 'flex-end',
    },
    // A phone's footer is a centred line of words: the disclosure takes the column's width above it.
    cornerNoteCompact: {
        width: '100%',
        maxWidth: RETENTION_NOTE_MAX_WIDTH_PX,
    },
    measuringNote: {
        opacity: 0,
    },
    cornerNoteSurface: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: theme.borderRadius.lg,
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s12,
    },
    cornerDoor: {
        position: 'absolute',
        zIndex: 1,
        top: DESKTOP_WORDMARK_TOP_PX + (WORDMARK_HEIGHT_PX - CORNER_PILL_HEIGHT_PX) / 2,
        right: 32,
        // A long Home address truncates in its middle inside this width instead of reaching the column.
        maxWidth: 360,
    },
    mobileWordmark: {
        position: 'absolute',
        // top + left are applied inline alongside the safe-area insets.
        zIndex: 1,
    },
    // Direction A: the step column stands centred in the window, the wordmark in its top-left corner.
    desktopColumn: {
        width: '100%',
        alignSelf: 'center',
    },
    desktopFooterCorner: {
        marginHorizontal: DESKTOP_WORDMARK_INSET_PX - WORKFLOW_DESKTOP_HORIZONTAL_GUTTER,
        // The links' own bottom padding is the corner inset; the pane's is not added under it.
        marginBottom: -DESKTOP_PANE_BOTTOM_PADDING_PX,
    },
    desktopWordmark: {
        top: DESKTOP_WORDMARK_TOP_PX,
        left: DESKTOP_WORDMARK_INSET_PX,
    },
}));
