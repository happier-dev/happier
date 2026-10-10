import * as React from 'react';
import { Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { StorySheetFrame } from '@/components/ui/storyDeck';
import { WizardStepDots } from '@/components/onboarding/ui/WizardStepDots';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    AnimatedNumber,
    INSTRUMENT_DURATIONS,
    INSTRUMENT_SPRINGS,
    useMotionPreferences,
} from '@/components/instrument';
import type {
    UsageAnalyticsViewModel,
    UsageCacheSavingsViewModel,
    UsageFilterState,
} from '@/sync/api/account/usageAnalytics';

import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Heatmap, RankedRows } from '@happier-dev/plugin-ui/presentation';
import { ChartTooltip } from '@/components/ui/charts';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageActivityGridPresentation, useUsageActivityGridTooltip } from '../../usageGridPresentation';
import { usageSignatureAccent, withUsageAccentAlpha } from '../../usageAccent';
import { formatIdentifierLabel } from '@/utils/format/usageNumbers';
import { buildRecapStorySlides, type RecapStorySlide, type RecapStorySlideId } from '@/sync/domains/usage/recap/buildRecapStorySlides';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * Opt-in recap story mode (L6 T4) — the ONLY place the theatrical layer lives.
 * A full-screen pager of recap slides on tinted kit-style gradient backdrops:
 * tap right/left to advance/rewind, swipe down to dismiss (StorySheetFrame),
 * progress dots, and sharing through the one selected-field composer.
 * The odometer value plays per slide entry; at
 * `minimal` everything renders statically.
 */

export type RecapStorySurfaceProps = Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    query?: import('@happier-dev/protocol/inputs/usageQuery').UsageQuery;
    cacheSavings: UsageCacheSavingsViewModel | null;
    sessionId?: string;
    onDismiss?: () => void;
    onShare?: () => void;
    testID?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 480,
        minWidth: 0,
    },
    slide: {
        flex: 1,
        overflow: 'hidden',
    },
    // Explicit literals, NOT `StyleSheet.absoluteFillObject`: the unistyles
    // spread silently resolves to nothing at web runtime (verified live —
    // gradients rendered position:relative/height:0), which is why the
    // original backdrop never showed. Mirrors the kit's InstrumentCard
    // specular pattern.
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    slideBody: {
        flex: 1,
        paddingHorizontal: 28,
        paddingTop: 48,
        paddingBottom: 24,
        justifyContent: 'center',
        gap: 14,
    },
    label: {
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
    },
    value: {
        ...Typography.default('semiBold'),
        fontSize: 68,
        lineHeight: 74,
        letterSpacing: -2,
        color: theme.colors.text.primary,
    },
    subtitle: {
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text.secondary,
        maxWidth: 420,
    },
    visualWrap: {
        marginTop: 16,
        maxWidth: 340,
    },
    controls: {
        position: 'absolute',
        top: 12,
        right: 12,
        flexDirection: 'row',
        gap: 10,
        zIndex: 2,
    },
    controlButton: {
        width: 40,
        height: 40,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
    },
    tapZones: {
        // Same explicit-literals rule as `backdrop` (web-runtime spread bug):
        // with the broken spread these zones were 0-height, so story taps
        // only worked by accident in automation.
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        zIndex: 1,
    },
    tapZoneBack: {
        flex: 1,
    },
    tapZoneForward: {
        flex: 2,
    },
    dotsRow: {
        alignItems: 'center',
        paddingVertical: 14,
    },
}));

/**
 * Plain (non-unistyles) absolute fill for the gradient layers: passing a
 * unistyles style object to `expo-linear-gradient` silently applies NOTHING on
 * web (verified live twice — the gradient div rendered position:relative,
 * height:0 while its own backgroundImage applied). A plain object survives the
 * third-party component's style path on every platform.
 */
const GRADIENT_FILL = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
} as const;

/**
 * Per-slide backdrop signatures (R-DESIGN D-5): one signature accent, each
 * slide getting its OWN gradient geometry (direction + counter-glow position)
 * so every card has a distinct, quarantined depth without introducing a
 * second hue. Values are gradient start/end points in [0,1] space.
 */
const SLIDE_BACKDROPS: Record<RecapStorySlideId, Readonly<{
    wash: Readonly<{ start: { x: number; y: number }; end: { x: number; y: number } }>;
    glow: Readonly<{ start: { x: number; y: number }; end: { x: number; y: number } }>;
}>> = {
    usage: {
        wash: { start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 0.85 } },
        glow: { start: { x: 1, y: 1 }, end: { x: 0.2, y: 0.2 } },
    },
    streak: {
        wash: { start: { x: 1, y: 0 }, end: { x: 0.1, y: 0.9 } },
        glow: { start: { x: 0, y: 1 }, end: { x: 0.8, y: 0.1 } },
    },
    model: {
        wash: { start: { x: 0, y: 0.2 }, end: { x: 1, y: 0.8 } },
        glow: { start: { x: 1, y: 0 }, end: { x: 0.1, y: 0.9 } },
    },
    cache: {
        wash: { start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0.1 } },
        glow: { start: { x: 0, y: 0 }, end: { x: 0.9, y: 0.8 } },
    },
    rhythm: {
        wash: { start: { x: 0, y: 1 }, end: { x: 0.9, y: 0.1 } },
        glow: { start: { x: 1, y: 0.2 }, end: { x: 0.2, y: 0.9 } },
    },
};

/**
 * Slide entrance choreography (opt-in theatre): fade + travel on each card
 * change via the kit motion tokens; static at `minimal`.
 */
const SlideEnter: React.FC<Readonly<{ animate: boolean; children: React.ReactNode }>> = ({ animate, children }) => {
    const progress = useSharedValue(animate ? 0 : 1);

    React.useEffect(() => {
        if (!animate) return;
        progress.value = 0;
        progress.value = withSpring(1, INSTRUMENT_SPRINGS.standard);
        // Plays once per slide mount (component is keyed by slide id).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const style = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * 22 }],
    }));

    if (!animate) {
        return <View style={styles.slideBody}>{children}</View>;
    }
    return <Animated.View style={[styles.slideBody, style]}>{children}</Animated.View>;
};

/** Backdrop crossfade so slide changes swap depth softly, not with a pop. */
const BackdropFade: React.FC<Readonly<{ animate: boolean; children: React.ReactNode }>> = ({ animate, children }) => {
    const opacity = useSharedValue(animate ? 0 : 1);
    React.useEffect(() => {
        if (!animate) return;
        opacity.value = withTiming(1, { duration: INSTRUMENT_DURATIONS.entrance });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    if (!animate) {
        return <View pointerEvents="none" style={styles.backdrop}>{children}</View>;
    }
    return <Animated.View pointerEvents="none" style={[styles.backdrop, style]}>{children}</Animated.View>;
};

export function RecapStorySurface(props: RecapStorySurfaceProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const [index, setIndex] = React.useState(0);
    const slideRef = React.useRef<View | null>(null);

    const slides = React.useMemo(
        () => buildRecapStorySlides({
            viewModel: props.viewModel,
            filters: props.filters,
            query: props.query,
            cacheSavings: props.cacheSavings,
        }),
        [props.cacheSavings, props.filters, props.viewModel, props.query],
    );

    const slide = slides[Math.min(index, Math.max(0, slides.length - 1))];
    // ONE signature accent (D-1); per-slide identity comes from gradient
    // geometry + choreography, never from a different hue.
    const accentColor = usageSignatureAccent(theme);
    const activityCell = useUsageActivityGridTooltip(accentColor, slide?.visual?.kind === 'activityMatrix' ? slide.visual.rowSize : 7);

    const goForward = React.useCallback(() => {
        setIndex((current) => {
            if (current >= slides.length - 1) {
                props.onDismiss?.();
                return current;
            }
            return current + 1;
        });
    }, [props, slides.length]);

    const goBack = React.useCallback(() => {
        setIndex((current) => Math.max(0, current - 1));
    }, []);

    const share = React.useCallback(() => {
        props.onShare?.();
    }, [props.onShare]);

    if (!slide) {
        return null;
    }

    // Theatrical accent-derived depth (D-5): a rich directional wash plus a
    // softer counter-glow, both alpha steps of the ONE accent; geometry varies
    // per slide (SLIDE_BACKDROPS). Minimal level renders a flat static sheet.
    const theatrical = motion.effectsEnabled || motion.level === 'subtle';
    const backdrop = SLIDE_BACKDROPS[slide.id];
    const washColors: [string, string, string] = [
        withUsageAccentAlpha(accentColor, theme.dark ? 0.52 : 0.3),
        withUsageAccentAlpha(accentColor, theme.dark ? 0.16 : 0.09),
        withUsageAccentAlpha(accentColor, 0),
    ];
    const glowColors: [string, string] = [
        withUsageAccentAlpha(accentColor, theme.dark ? 0.24 : 0.12),
        withUsageAccentAlpha(accentColor, 0),
    ];
    const animateSlide = motion.level !== 'minimal';

    let visual: React.ReactNode = null;
    if (slide.visual?.kind === 'activityMatrix') {
        visual = (
            <Heatmap
                theme={projectPluginUiTheme(theme)}
                {...usageActivityGridPresentation(slide.visual.activity, accentColor, theme.colors.background.canvas, slide.visual.squareCount, slide.visual.rowSize,
                    props.query?.timeZoneOffsetMinutes ?? props.viewModel.timeZoneOffsetMinutes ?? 0)}
                unknownLabel={t('usage.noData.title')}
                renderCell={activityCell}
                showReadout={false}
            />
        );
    } else if (slide.visual?.kind === 'progress') {
        visual = <MeterBar tone="neutral" fillFraction={slide.visual.ratio}
            minimumVisibleFraction={0.08} fillOpacity={0.92} height={8}
            trackColor={theme.colors.background.canvas} fillColor={accentColor}
            progressAccessibilityLabel={slide.label} />;
    } else if (slide.visual?.kind === 'rankBars') {
        visual = <RankedRows theme={projectPluginUiTheme(theme)} label={slide.label} size="tile"
            barAppearance={{ minimumVisibleFraction: 0.1, fillOpacity: 0.92, zeroFillOpacity: 0.25, trackColor: theme.colors.background.canvas }}
            rows={slide.visual.rows.map(row => ({ ...row, id: row.label, color: accentColor }))}
            renderRow={(row, rowVisual) => <ChartTooltip triggerTestID={`usage-rank-bar-${row.label}`} title={row.label}
                value={row.value?.toLocaleString() ?? '—'} accentColor={accentColor}>{rowVisual}</ChartTooltip>} />;
    }

    return (
        <StorySheetFrame testID={props.testID ?? 'usage-recap-story'} onDismiss={props.onDismiss}>
            <View style={styles.root}>
                <View style={styles.controls}>
                    <Pressable
                        testID="usage-recap-story-share"
                        accessibilityRole="button"
                        accessibilityLabel={t('usage.recap.shareImage')}
                        style={styles.controlButton}
                        onPress={share}
                    >
                        <Icon name="share" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                    <Pressable
                        testID="usage-recap-story-close"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                        style={styles.controlButton}
                        onPress={() => props.onDismiss?.()}
                    >
                        <Icon name="x" size={16} color={theme.colors.text.secondary} />
                    </Pressable>
                </View>

                <View
                    key={slide.id}
                    ref={slideRef}
                    collapsable={false}
                    style={styles.slide}
                    testID={`usage-recap-story-slide-${slide.id}`}
                >
                    {theatrical ? (
                        <BackdropFade animate={animateSlide}>
                            <LinearGradient
                                pointerEvents="none"
                                colors={washColors}
                                start={backdrop.wash.start}
                                end={backdrop.wash.end}
                                style={GRADIENT_FILL}
                            />
                            <LinearGradient
                                pointerEvents="none"
                                colors={glowColors}
                                start={backdrop.glow.start}
                                end={backdrop.glow.end}
                                style={GRADIENT_FILL}
                            />
                        </BackdropFade>
                    ) : (
                        <View pointerEvents="none" style={[styles.backdrop, { backgroundColor: theme.colors.surface.inset }]} />
                    )}
                    <SlideEnter animate={animateSlide}>
                        <Text style={[styles.label, { color: accentColor }]}>{slide.label}</Text>
                        {slide.numericValue !== null ? (
                            <AnimatedNumber
                                testID="usage-recap-story-value"
                                value={slide.numericValue}
                                format={() => slide.value}
                                emphasisPulse
                                emphasisColor={accentColor}
                                textStyle={styles.value}
                            />
                        ) : (
                            <Text style={styles.value} numberOfLines={2} adjustsFontSizeToFit>
                                {formatIdentifierLabel(slide.value)}
                            </Text>
                        )}
                        <Text style={styles.subtitle}>{slide.subtitle}</Text>
                        {visual ? <View style={styles.visualWrap}>{visual}</View> : null}
                    </SlideEnter>

                    {/* Story tap zones: left third rewinds, right two-thirds advance. */}
                    <View style={styles.tapZones}>
                        <Pressable
                            testID="usage-recap-story-back"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.back')}
                            style={styles.tapZoneBack}
                            onPress={goBack}
                        />
                        <Pressable
                            testID="usage-recap-story-forward"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.continue')}
                            style={styles.tapZoneForward}
                            onPress={goForward}
                        />
                    </View>
                </View>

                <View style={styles.dotsRow}>
                    <WizardStepDots currentStepIndex={index} stepCount={slides.length} />
                </View>
            </View>
        </StorySheetFrame>
    );
}
