import * as React from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { t } from '@/text';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';

import { BackChevron, UNAUTH_BACK_TEST_ID } from './BackChevron';
import { BrandWordmark } from './BrandWordmark';
import { PlanetBackground } from './PlanetBackground';
import { WelcomeFooterLinks } from './WelcomeFooterLinks';
import { useBrandPaneTokens } from './brandPaneTokens';
import type { RelayRetentionDisclosureState } from './RelayRetentionDisclosure';

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
const WORKFLOW_MOBILE_HORIZONTAL_PADDING = 24;
const WORKFLOW_MOBILE_BOTTOM_PADDING = 28;
/**
 * The phone Welcome copy scrim fades in across the heading's two 44px hero lines, so the heading keeps
 * the planet behind it and the body copy beneath always sits on the full scrim.
 */
const WELCOME_SCRIM_FADE_PX = 88;
const WELCOME_SCRIM_FADE_START = { x: 0, y: 0 } as const;
const WELCOME_SCRIM_FADE_END = { x: 0, y: 1 } as const;
const WELCOME_SCRIM_FADE_STYLE: ViewStyle = { height: WELCOME_SCRIM_FADE_PX };

/**
 * The desktop horizontal padding that sits inside the pane's `maxWidth`. The
 * visible pane width = content width + 2× this gutter. Kept in sync with the
 * `desktopPadding` style below.
 */
const WORKFLOW_DESKTOP_HORIZONTAL_GUTTER = 64;
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
    retentionDisclosure?: RelayRetentionDisclosureState | null;
    onBack?: () => void;
    transitionKey: string;
    presentation?: WorkflowPanelPresentation;
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
    const { theme } = useUnistyles();
    const safeAreaInsets = useSafeAreaInsets();
    const styles = stylesheet;
    const isMobile = props.variant === 'mobile';
    const isFullBleed = props.presentation === 'fullBleed';
    // Android Back does what the on-screen Back does; without one the app's own Back handling continues.
    useNativeBackLayerBackHandler(props.onBack != null, () => {
        props.onBack?.();
        return true;
    });
    useEscapeLayer({
        enabled: props.onBack != null,
        priority: ESCAPE_LAYER_PRIORITIES.pane,
        onEscape: () => { props.onBack?.(); },
    });
    // Match the legacy WizardCardLayout card-width derivation so the workflow
    // pane caps at ~500px on desktop and scales down gracefully on narrow
    // viewports. The maxWidth is applied to the pane root itself (not a child),
    // so the canvas-background card visibly sits at the wizard's card size and
    // the brand pane (flex: 1) expands to fill the remaining left-side space
    // on wider windows.
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
    const showMobileWordmark = isMobile && (props.isWelcomeStep || props.showMobileWordmark === true);
    const wordmarkInBackRow = showMobileWordmark && !props.isWelcomeStep;
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

    // On mobile, the welcome step gets a cosmic backdrop — a heavily oversized,
    // bottom-anchored planet behind the content. The brand hero on first
    // launch already shows the same planet imagery; carrying it into the
    // welcome step keeps the cosmic identity present rather than dropping
    // back to flat canvas. Scoped to mobile + welcome so other steps stay
    // clean and desktop uses StagePane for the planet.
    const showMobileWelcomeBackdrop = isMobile && props.isWelcomeStep;
    // When the planet backdrop renders, the underlying canvas color must
    // match the planet's top-edge color so any area not covered by the
    // oversized image blends seamlessly with it. Outside the welcome step
    // (or on desktop) we keep the regular canvas color.
    const brandPaneTokens = useBrandPaneTokens();
    const paneBackgroundColor = showMobileWelcomeBackdrop
        ? brandPaneTokens.background
        : theme.colors.background.canvas;
    // Same bottom fade the brand hero overlays on its planet (transparent →
    // canvas color over the bottom 60%). Without it the welcome step's planet
    // looked subtly different from the brand hero's. The fade also softens the
    // backdrop behind the bottom-aligned heading + buttons for legibility.
    const planetFadeColors = [brandPaneTokens.backgroundTransparent, brandPaneTokens.background] as const;

    return (
        <View
            testID={props.testID ?? 'unauth-shell-workflow-pane'}
            style={[
                styles.paneOuter,
                {
                    backgroundColor: paneBackgroundColor,
                    maxWidth: paneMaxWidth,
                },
            ]}
        >
            {showMobileWelcomeBackdrop ? <PlanetBackground variant="mobile" /> : null}
            {showMobileWelcomeBackdrop ? (
                <LinearGradient
                    pointerEvents="none"
                    colors={planetFadeColors}
                    locations={[0, 1]}
                    style={styles.planetBottomFade}
                />
            ) : null}
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
                            : {
                                top: MOBILE_WORDMARK_INSET_PX + safeAreaInsets.top,
                                left: MOBILE_WORDMARK_INSET_PX + safeAreaInsets.left,
                            },
                    ]}
                    pointerEvents="box-none"
                >
                    <BrandWordmark height={wordmarkInBackRow ? MOBILE_ROW_WORDMARK_HEIGHT_PX : MOBILE_WORDMARK_HEIGHT_PX} />
                </View>
            ) : null}
            {props.onBack && isFullBleed ? (
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
                        onPress={props.onBack}
                        accessibilityLabel={t('common.back')}
                    />
                </View>
            ) : null}
            {props.onBack && !isFullBleed ? (
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
                        onPress={props.onBack}
                        accessibilityLabel={t('common.back')}
                    />
                </View>
            ) : null}

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
                            <View style={styles.footerSpacer} />
                            <View>
                                {/*
                                  * The copy column dims the planet behind it, edge to edge and down to the
                                  * screen bottom, fading in across the heading: on a short phone the column
                                  * climbs over the orb, where secondary text would lose its contrast.
                                  */}
                                <View
                                    pointerEvents="none"
                                    style={[styles.welcomeScrim, {
                                        left: -(WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.left),
                                        right: -(WORKFLOW_MOBILE_HORIZONTAL_PADDING + safeAreaInsets.right),
                                        bottom: -(WORKFLOW_MOBILE_BOTTOM_PADDING + safeAreaInsets.bottom),
                                    }]}
                                >
                                    <LinearGradient
                                        colors={[brandPaneTokens.backgroundTransparent, brandPaneTokens.scrim]}
                                        start={WELCOME_SCRIM_FADE_START}
                                        end={WELCOME_SCRIM_FADE_END}
                                        style={WELCOME_SCRIM_FADE_STYLE}
                                    />
                                    <View style={[styles.welcomeScrimFill, { backgroundColor: brandPaneTokens.scrim }]} />
                                </View>
                                <StepMotionLayer
                                    layerKey="workflow"
                                    backTestID={UNAUTH_BACK_TEST_ID}
                                    testID="unauth-shell-step-transition"
                                    stepKey={props.transitionKey}
                                    compact={isMobile}
                                    style={STEP_TRANSITION_NATURAL_STYLE}
                                >
                                    {props.children}
                                </StepMotionLayer>
                                <WelcomeFooterLinks
                                    variant="mobile"
                                    retentionDisclosure={props.retentionDisclosure}
                                    trailing={props.footerAccessory}
                                />
                            </View>
                        </>
                    ) : (
                        <>
                            <StepMotionLayer
                                layerKey="workflow"
                                backTestID={UNAUTH_BACK_TEST_ID}
                                testID="unauth-shell-step-transition"
                                stepKey={props.transitionKey}
                                compact={isMobile}
                                style={STEP_TRANSITION_NATURAL_STYLE}
                            >
                                {props.children}
                            </StepMotionLayer>
                            <View style={styles.footerSpacer} />
                            <WelcomeFooterLinks
                                variant="desktop"
                                retentionDisclosure={props.retentionDisclosure}
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
                            layerKey="workflow"
                            backTestID={UNAUTH_BACK_TEST_ID}
                            testID="unauth-shell-step-transition"
                            stepKey={props.transitionKey}
                            compact={isMobile}
                            style={STEP_TRANSITION_FILL_STYLE}
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
    backRowDesktop: {
        top: 12,
        left: WORKFLOW_DESKTOP_HORIZONTAL_GUTTER - 17,
    },
    mobileWordmark: {
        position: 'absolute',
        // top + left are applied inline alongside the safe-area insets.
        zIndex: 1,
    },
    welcomeScrim: {
        position: 'absolute',
        top: 0,
    },
    welcomeScrimFill: {
        flex: 1,
    },
    // Mirrors BrandPanel's bottomFadeMobile so the welcome-step planet fades
    // to the canvas color over the bottom 60% exactly like the brand hero.
    planetBottomFade: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '60%',
    },
}));
