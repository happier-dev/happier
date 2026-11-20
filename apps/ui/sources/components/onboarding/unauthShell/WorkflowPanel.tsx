import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { FIRST_RUN_WORKFLOW_LAYER, StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { t } from '@/text';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';

import { BackChevron, UNAUTH_BACK_TEST_ID } from './BackChevron';
import { BrandWordmark } from './BrandWordmark';
import { WelcomeFooterLinks } from './WelcomeFooterLinks';
import { StepBackContext, useStepBackSlot } from './stepBack';
import { ShellCornerContext, type ShellCornerDoor } from './shellCorner';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';

// Mobile welcome wordmark sits at the same coordinates as the brand hero's
// wordmark (24px top + 24px left, plus the safe-area insets) so users see
// the logo in the identical spot across both mobile screens.
const MOBILE_WORDMARK_INSET_PX = 24;
const MOBILE_WORDMARK_HEIGHT_PX = 30;
/**
 * A later step that keeps the wordmark (a Team entry) centres it in the back
 * row instead of the welcome corner, where it would sit under the back chevron
 * and over the step's own heading; the column starts below that row.
 */
const MOBILE_ROW_WORDMARK_HEIGHT_PX = 24;
const MOBILE_ROW_WORDMARK_TOP_PX = 4;
const MOBILE_ROW_WORDMARK_CLEARANCE_PX = 24;

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
/** The desktop wordmark's corner inset, on the page's outer gutter (lab direction A). */
const DESKTOP_WORDMARK_INSET_PX = 40;
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
 * renders a slim BackChevron when the wizard/route
 * supports back navigation; renders the welcome footer links only when the
 * current step is the welcome decision screen.
 *
 * All colors come from theme tokens; the workflow pane respects light/dark.
 */
export const WorkflowPanel = React.memo(function WorkflowPanel(props: WorkflowPanelProps) {
    useUnistyles();
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
    const cornerBack = isMobile || !inRow;
    // The welcome's "Run your own Home" door, in the page's top-right corner on a computer (lab direction A).
    const [cornerDoor, setCornerDoor] = React.useState<ShellCornerDoor | null>(null);
    const cornerSlot = isMobile ? null : setCornerDoor;
    const cardDimensions = useModalCardDimensions({ size: 'md', width: WORKFLOW_CARD_WIDTH_HINT });
    const layoutMaxWidth = useLayoutMaxWidth();
    // The pane is capped at exactly the wizard card width (~500px) including
    // its own horizontal padding — i.e. the visible right block is at most
    // 500px wide, with the padding absorbed inside that cap. On mobile the
    // cap is undefined so the pane fills the screen.
    const paneMaxWidth = isMobile
        ? undefined
        : Math.min(cardDimensions.width, layoutMaxWidth);
    // Padding lives on the inner scroll content (not the outer pane) so the
    // back-chevron stays anchored to the viewport while the welcome content +
    // footer flow through a single vertically-scrollable column. On tall
    // screens the flex spacer inside the column pushes the footer to the
    // bottom (visual parity with the prior fixed-position layout); on short
    // screens the spacer collapses and the column scrolls — content and
    // footer always remain reachable instead of overlapping.
    // The wordmark stands top-left on every welcome step and wherever a step asks for it (direction A).
    const showMobileWordmark = !isMobile || props.isWelcomeStep || props.showMobileWordmark === true;
    const wordmarkInBackRow = isMobile && showMobileWordmark && !props.isWelcomeStep;
    const contentPaddingStyle: ViewStyle = isMobile
        ? isFullBleed
            ? styles.contentMobileFullBleedPadding
            : {
                // A welcome column taller than a short phone scrolls from below the corner wordmark,
                // never under it.
                paddingTop: (showMobileWordmark && !wordmarkInBackRow
                    ? MOBILE_WORDMARK_INSET_PX + MOBILE_WORDMARK_HEIGHT_PX + MOBILE_ROW_WORDMARK_CLEARANCE_PX
                    : WORKFLOW_MOBILE_TOP_PADDING + (wordmarkInBackRow ? MOBILE_ROW_WORDMARK_CLEARANCE_PX : 0))
                    + safeAreaInsets.top,
                paddingRight: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.right,
                paddingBottom: WORKFLOW_MOBILE_BOTTOM_PADDING + safeAreaInsets.bottom,
                paddingLeft: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left,
            }
        : styles.contentDesktopPadding;

    return (
        <View
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
                                top: MOBILE_ROW_WORDMARK_TOP_PX + safeAreaInsets.top,
                                left: safeAreaInsets.left,
                                right: safeAreaInsets.right,
                                alignItems: 'center',
                            }
                            : isMobile ? {
                                top: MOBILE_WORDMARK_INSET_PX + safeAreaInsets.top,
                                left: MOBILE_WORDMARK_INSET_PX + safeAreaInsets.left,
                            } : styles.desktopWordmark,
                    ]}
                    pointerEvents="box-none"
                >
                    <BrandWordmark height={wordmarkInBackRow ? MOBILE_ROW_WORDMARK_HEIGHT_PX : MOBILE_WORDMARK_HEIGHT_PX} />
                </View>
            ) : null}
            {backSlot && isFullBleed ? (
                <View
                    style={[
                        styles.backChevronContainer,
                        isMobile ? {
                            top: 12 + safeAreaInsets.top,
                            left: 12 + safeAreaInsets.left,
                        } : null,
                    ]}
                >
                    <BackChevron
                        onPress={backSlot.onBack}
                        accessibilityLabel={t('common.back')}
                    />
                </View>
            ) : null}
            {backSlot && !isFullBleed && cornerBack ? (
                <View
                    testID="unauth-shell-back-row"
                    style={[
                        styles.backRowFloating,
                        isMobile
                            ? {
                                top: -4 + safeAreaInsets.top,
                                left: WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left - 17,
                            }
                            : styles.backRowDesktop,
                    ]}
                >
                    <BackChevron
                        onPress={backSlot.onBack}
                        accessibilityLabel={t('common.back')}
                    />
                </View>
            ) : null}

            {cornerDoor ? (
                <View testID="unauth-shell-corner" style={styles.cornerDoor} pointerEvents="box-none">
                    <WelcomeActionCard testID={cornerDoor.testID} title={cornerDoor.label} presentation="pill"
                        iconName="hard-drives" disabled={!cornerDoor.onPress} onPress={() => cornerDoor.onPress?.()} />
                </View>
            ) : null}
            <ShellCornerContext.Provider value={cornerSlot}>
            <StepBackContext.Provider value={backSlot}>
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
                            <View onLayout={props.onColumnLayout}>
                                <StepMotionLayer
                                    layerKey={FIRST_RUN_WORKFLOW_LAYER}
                                    active={focused}
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
                            <View>
                                <WelcomeFooterLinks
                                    variant="mobile"
                                    trailing={props.footerAccessory}
                                />
                            </View>
                        </>
                    ) : (
                        <>
                            {/* The welcome's doors stand above the planet: two parts of the free height above, three below. */}
                            <View style={styles.welcomeLead} />
                            <StepMotionLayer
                                layerKey={FIRST_RUN_WORKFLOW_LAYER}
                                active={focused}
                                backTestID={UNAUTH_BACK_TEST_ID}
                                testID="unauth-shell-step-transition"
                                stepKey={props.transitionKey}
                                compact={isMobile}
                                onLayout={props.onColumnLayout}
                                style={[STEP_TRANSITION_NATURAL_STYLE, { maxWidth: paneMaxWidth }, styles.desktopColumn]}
                            >
                                {props.children}
                            </StepMotionLayer>
                            <View style={styles.welcomeTrail} />
                            <WelcomeFooterLinks
                                variant="desktop"
                                trailing={props.footerAccessory}
                            />
                        </>
                    )
                ) : (
                    // Non-welcome steps keep the legacy fill behaviour so step
                    // bodies that center themselves vertically (restore, scan…)
                    // continue to look right.
                    <>
                        <StepMotionLayer
                            layerKey={FIRST_RUN_WORKFLOW_LAYER}
                            active={focused}
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
            </StepBackContext.Provider>
            </ShellCornerContext.Provider>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
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
        paddingTop: 56,
        paddingHorizontal: WORKFLOW_DESKTOP_HORIZONTAL_GUTTER,
        paddingBottom: 28,
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
        top: 84,
        left: DESKTOP_WORDMARK_INSET_PX - 8,
    },
    cornerDoor: {
        position: 'absolute',
        zIndex: 1,
        top: DESKTOP_WORDMARK_INSET_PX - 2,
        right: 32,
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
    desktopWordmark: {
        top: DESKTOP_WORDMARK_INSET_PX,
        left: DESKTOP_WORDMARK_INSET_PX,
    },
}));
