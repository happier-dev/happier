import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { FIRST_RUN_WORKFLOW_LAYER, StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';

import { BrandWordmark } from './BrandWordmark';
import { WelcomeFooterLinks } from './WelcomeFooterLinks';
import { STEP_ROW_BUTTON_PX, StepBackContext, StepRowBackButton, UNAUTH_BACK_TEST_ID, useStepBackSlot, WIDE_STEP_COLUMN_PX, WideStepColumnContext } from './stepBack';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { RelayRetentionDisclosure } from './RelayRetentionDisclosure';
import { ShellCornerContext, ShellCornerNoteContext, ShellHeaderClearanceContext, type ShellCornerDoor, type ShellCornerNote } from './shellCorner';
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
const MOBILE_BACK_ROW_HEIGHT_PX = MOBILE_BACK_ROW_TOP_PX + STEP_ROW_BUTTON_PX + MOBILE_BACK_ROW_CLEARANCE_PX;

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
    /** Shows the compact mobile product mark on focused public entry flows. */
    showMobileWordmark?: boolean;
    onBack?: () => void;
    transitionKey: string;
    warmStepMotion?: boolean;
    presentation?: WorkflowPanelPresentation;
    onColumnLayout?: (event: LayoutChangeEvent) => void;
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
    // The welcome's retention line, in the page's bottom-right corner on a computer (owner 2026-11-20).
    const [cornerNote, setCornerNote] = React.useState<ShellCornerNote | null>(null);
    const cornerNoteSlot = isMobile ? null : setCornerNote;
    const pane = React.useRef<View>(null);
    const readWebChrome = React.useCallback(() => {
        const root = pane.current;
        if (typeof HTMLElement === 'undefined' || !(root instanceof HTMLElement)) return [];
        const welcomeWordmark = isMobile ? ', [data-testid="welcome-mobile-wordmark"]' : '';
        return Array.from(root.querySelectorAll<HTMLElement>(
            `[data-testid="unauth-shell-corner"], [data-testid="unauth-shell-welcome-footer"]${welcomeWordmark}`,
        ));
    }, [isMobile]);
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
    // A later step that keeps the wordmark (a Team entry) centres it in the Back row, clear of Back and the heading.
    const wordmarkInBackRow = isMobile && showMobileWordmark && !props.isWelcomeStep && cornerBack;
    const mobileBackRow = isMobile && props.onBack != null && !isFullBleed && cornerBack;
    const contentPaddingStyle: ViewStyle = isMobile
        ? isFullBleed
            ? styles.contentMobileFullBleedPadding
            : {
                // A welcome column taller than a short phone scrolls from below the corner wordmark,
                // never under it.
                paddingTop: (showMobileWordmark && !wordmarkInBackRow
                    ? MOBILE_WORDMARK_TOP_PX + WORDMARK_HEIGHT_PX + MOBILE_ROW_WORDMARK_CLEARANCE_PX
                    : mobileBackRow || wordmarkInBackRow ? MOBILE_BACK_ROW_HEIGHT_PX : WORKFLOW_MOBILE_TOP_PADDING)
                    + safeAreaInsets.top,
                paddingRight: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.right,
                paddingBottom: WORKFLOW_MOBILE_BOTTOM_PADDING + safeAreaInsets.bottom,
                paddingLeft: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left,
            }
        : props.isWelcomeStep ? styles.contentDesktopPadding : styles.contentDesktopStepPadding;
    const headerBottom = isMobile
        ? MOBILE_WORDMARK_TOP_PX + WORDMARK_HEIGHT_PX + MOBILE_ROW_WORDMARK_CLEARANCE_PX + safeAreaInsets.top
        : DESKTOP_WORDMARK_TOP_PX + DESKTOP_WORDMARK_HEIGHT_PX;
    const [headerClearance, setHeaderClearance] = React.useState(0);
    const { onColumnLayout } = props;
    const onWelcomeColumnLayout = React.useCallback((event: LayoutChangeEvent) => {
        setHeaderClearance(Math.max(0, Math.floor(event.nativeEvent.layout.y - headerBottom)));
        onColumnLayout?.(event);
    }, [headerBottom, onColumnLayout]);

    return (
        <View
            ref={pane}
            testID={props.testID ?? 'unauth-shell-workflow-pane'}
            // The pane is transparent: the shell's welcome atmosphere draws the page behind it.
            style={styles.paneOuter}
        >
            {showMobileWordmark ? (
                <View
                    testID="welcome-mobile-wordmark"
                    style={[
                        styles.mobileWordmark,
                        wordmarkInBackRow
                            ? {
                                top: MOBILE_BACK_ROW_TOP_PX + (STEP_ROW_BUTTON_PX - WORDMARK_HEIGHT_PX) / 2
                                    + safeAreaInsets.top,
                                left: safeAreaInsets.left,
                                right: safeAreaInsets.right,
                                alignItems: 'center',
                            }
                            : isMobile ? {
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
                                top: MOBILE_BACK_ROW_TOP_PX + safeAreaInsets.top,
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
            <ShellCornerNoteContext.Provider value={cornerNoteSlot}>
            <ShellHeaderClearanceContext.Provider value={props.isWelcomeStep ? headerClearance : 0}>
            <StepBackContext.Provider value={backSlot}>
            <WideStepColumnContext.Provider value={isMobile ? null : claimWideColumn}>
            <ScrollView
                testID="unauth-shell-workflow-scroll"
                style={styles.scrollFill}
                contentContainerStyle={[styles.scrollContent, contentPaddingStyle]}
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
                            <View style={styles.welcomeTrail} />
                            <View testID="unauth-shell-welcome-footer">
                                <WelcomeFooterLinks
                                    variant="mobile"
                                    trailing={props.footerAccessory}
                                />
                            </View>
                        </>
                    ) : (
                        <>
                            {/* The welcome's doors stand above the planet: two parts of the free height above, three below. */}
                            <View style={[styles.welcomeLead, styles.welcomeLeadDesktop]} />
                            <StepMotionLayer
                                layerKey={FIRST_RUN_WORKFLOW_LAYER}
                                webChrome={readWebChrome}
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
                            <View style={styles.welcomeTrail} />
                            {/* The links stand on the wordmark's corner grid (40 px from the window's edges), not the pane's
                                gutter (lab direction A). */}
                            <View testID="unauth-shell-welcome-footer" style={styles.desktopFooterCorner}>
                                <WelcomeFooterLinks
                                    variant="desktop"
                                    trailing={cornerNote || props.footerAccessory ? (
                                        <View style={styles.cornerNote}>
                                            {cornerNote ? (
                                                // It stands over the planet's limb, so it reads on the corner pill's surface.
                                                <View style={[styles.cornerNoteSurface, { borderColor: theme.colors.border.default }]}>
                                                    {/* An Element over the planet: glass, its exact solid paint under Reduce Transparency. */}
                                                    <GlassSurface surfaceGroup="card" nested finishRole={null} children={null}
                                                        solidColor={theme.colors.surface.base} style={styles.cornerNoteGround} />
                                                    <RelayRetentionDisclosure testID="welcome-retention"
                                                        disclosure={{ ...cornerNote.disclosure, retry: cornerNote.onRetry }} />
                                                </View>
                                            ) : null}
                                            {props.footerAccessory}
                                        </View>
                                    ) : undefined}
                                />
                            </View>
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
                            active={focused}
                            warmOnMount={props.warmStepMotion}
                            backTestID={UNAUTH_BACK_TEST_ID}
                            testID="unauth-shell-step-transition"
                            stepKey={props.transitionKey}
                            compact={isMobile}
                            onLayout={props.onColumnLayout}
                            style={isMobile ? STEP_TRANSITION_FILL_STYLE : [STEP_TRANSITION_FILL_STYLE, { maxWidth: paneMaxWidth }, styles.desktopColumn]}
                        >
                            {props.children}
                        </StepMotionLayer>
                        {props.footerAccessory ? (
                            <View
                                testID="unauth-shell-footer-accessory"
                                style={[
                                    styles.footerAccessoryRow,
                                    isMobile
                                        ? isFullBleed
                                            ? {
                                                paddingRight: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.right,
                                                paddingBottom: WORKFLOW_MOBILE_BOTTOM_PADDING + safeAreaInsets.bottom,
                                            }
                                            : null
                                        : styles.footerAccessoryRowDesktop,
                                ]}
                            >
                                {props.footerAccessory}
                            </View>
                        ) : null}
                    </>
                )}
            </ScrollView>
            </WideStepColumnContext.Provider>
            </StepBackContext.Provider>
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
    },
    footerAccessoryRowDesktop: {
        paddingBottom: 28,
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
    // The retention line on the bottom-right corner grid, right-aligned beside the footer's own control.
    cornerNote: {
        maxWidth: 400,
        alignItems: 'flex-end',
        gap: theme.space.s8,
    },
    cornerNoteSurface: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: theme.borderRadius.lg,
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s12,
    },
    cornerNoteGround: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        borderRadius: theme.borderRadius.lg,
        pointerEvents: 'none',
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
