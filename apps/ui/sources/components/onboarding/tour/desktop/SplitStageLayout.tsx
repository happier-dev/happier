import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SlideTransitionDirection } from '@/components/ui/motion';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { BrandWordmark } from '../../unauthShell/BrandWordmark';
import { StagePane } from '../../unauthShell/StagePane';
import { JourneyConfigSlot, type JourneyConfigControllerSurface } from '../config/JourneyConfigSlot';
import { withPersistentJourneySkip } from '../config/journeyConfigNavigation';
import { NarrationColumn } from '../narration/NarrationColumn';
import type { JourneyBeat } from '../state/journeyBeats';
import type { JourneyProgressController } from '../state/useJourneyProgress';
import { stageVisualTokens } from '../stage/stageVisualTokens';

export type JourneyStagePaneState = Readonly<{
    mode: 'stage';
    planetOpacity: number;
    planetScale: number;
    stageContentVisible: boolean;
}>;

export type SplitStageLayoutOrientation = 'narration-left' | 'narration-right';

export type SplitStageLayoutProps = Readonly<{
    progress: JourneyProgressController;
    controller: JourneyConfigControllerSurface;
    stage: React.ReactNode;
    orientation?: SplitStageLayoutOrientation;
    direction?: SlideTransitionDirection;
    reducedMotion?: boolean;
    testID?: string;
}>;

const DEFAULT_ACCENT_DARK = '#6D94FF';
const DEFAULT_ACCENT_LIGHT = '#FFB14A';

export function resolveJourneyStagePaneState(beat: JourneyBeat): JourneyStagePaneState {
    if (beat.stageTreatment === 'planet-hero') {
        return {
            mode: 'stage',
            planetOpacity: 1,
            planetScale: 1,
            stageContentVisible: false,
        };
    }

    // D16: ONE full-bleed background system. The planet never scales down (a
    // sub-1 scale reveals the section canvas at the edges — the "planet in a
    // block with margins" defect). On stage beats it recedes via opacity only,
    // staying full-bleed behind the demo stage.
    return {
        mode: 'stage',
        planetOpacity: beat.act === 'dream' ? 0.74 : 0.68,
        planetScale: 1,
        stageContentVisible: true,
    };
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
        backgroundColor: theme.colors.surface.base,
    },
    beatMarker: {
        width: 0,
        height: 0,
        opacity: 0,
    },
    narrationPane: {
        width: stageVisualTokens.narration.width,
        maxWidth: stageVisualTokens.narration.maxWidth,
        minWidth: stageVisualTokens.narration.minWidth,
        minHeight: 0,
        justifyContent: 'flex-start',
        position: 'relative',
        backgroundColor: theme.dark ? 'rgba(5,5,8,.94)' : 'rgba(250,249,247,.96)',
    },
    narrationPaneLeft: {
        borderRightWidth: 1,
        borderRightColor: theme.dark ? 'rgba(255,177,74,.08)' : 'rgba(255,177,74,.14)',
    },
    narrationPaneRight: {
        borderLeftWidth: 1,
        borderLeftColor: theme.dark ? 'rgba(255,177,74,.08)' : 'rgba(255,177,74,.14)',
    },
    // Single 2px accent hairline pinned to the very top of the narration column;
    // its width tracks beat progress (D17). No numbers, no acts, no dots.
    progressHairlineTrack: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        backgroundColor: theme.dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)',
        zIndex: 2,
    },
    progressHairlineFill: {
        height: 2,
    },
    scrollFill: {
        flex: 1,
        width: '100%',
        minHeight: 0,
    },
    // Vertical rhythm tightened (F-W13-2): config-heavy setup beats (S3/S4)
    // must fit their content — including the primary action — at 1440×900
    // without relying on scroll.
    scrollContent: {
        flexGrow: 1,
        flexDirection: 'column',
        paddingHorizontal: 44,
        // Keep the post-wrap S3 command card and its primary action fully
        // visible at the binding 1440x900 reference viewport.
        paddingTop: 48,
        paddingBottom: 28,
        gap: 18,
    },
    stageHost: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    brandLogo: {
        position: 'absolute',
        zIndex: 6,
    },
    skipPill: {
        position: 'absolute',
        zIndex: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.10)',
        backgroundColor: theme.dark ? 'rgba(18,18,24,.55)' : 'rgba(255,255,255,.62)',
        paddingHorizontal: 16,
        height: 34,
        transform: [{ scale: 1 }],
    },
    skipPillPressed: {
        transform: [{ scale: stageVisualTokens.motion.pressScale }],
    },
    skipPillLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 12.5,
        lineHeight: 16,
    },
}));

function ProgressHairline(props: Readonly<{
    progress: JourneyProgressController;
    accentHue: string;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const total = Math.max(1, props.progress.visibleBeats.length);
    const fraction = Math.min(1, Math.max(0, props.progress.currentNumber / total));
    return (
        <View testID={props.testID} pointerEvents="none" style={styles.progressHairlineTrack}>
            <View
                testID={`${props.testID}-fill`}
                style={[
                    styles.progressHairlineFill,
                    { width: `${fraction * 100}%`, backgroundColor: props.accentHue },
                ]}
            />
        </View>
    );
}

function SkipPill(props: Readonly<{
    label: React.ReactNode;
    onPress: () => void | Promise<void>;
    top: number;
    right: number;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const webGlass = Platform.OS === 'web'
        ? ({ backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' } as React.ComponentProps<typeof View>['style'])
        : null;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={typeof props.label === 'string' ? props.label : t('journey.actions.skipToSetup')}
            onPress={() => {
                void props.onPress();
            }}
            style={({ pressed }) => [
                styles.skipPill,
                { top: props.top, right: props.right },
                webGlass,
                pressed ? styles.skipPillPressed : null,
            ]}
        >
            <Text numberOfLines={1} style={styles.skipPillLabel}>
                {props.label}
            </Text>
        </Pressable>
    );
}

export function SplitStageLayout(props: SplitStageLayoutProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isDark = Boolean((theme as { dark?: boolean }).dark);
    const safeAreaInsets = useSafeAreaInsets();
    const testID = props.testID ?? 'journey-desktop';
    const beat = props.progress.currentBeat;
    const paneState = resolveJourneyStagePaneState(beat);
    const controller = withPersistentJourneySkip(props.controller, props.progress);
    const orientation = props.orientation ?? stageVisualTokens.orientation.default;
    const accentHue = beat.accentHue ?? (isDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT);

    // Skip is the absolute top-right glass pill (D17) — the journey "skip to
    // setup", never in the column flow. It shows on the dream tour; setup beats
    // are already past it.
    const journeySkipVisible = props.progress.showSkipToSetup && Boolean(controller.onSkip);
    // The column footer keeps the per-step optional skip (e.g. setup "I'll do
    // this later"), but never the journey skip (owned by the pill). The
    // pre-auth advance-duplicate skip is already stripped at the shared host
    // adaptation seam (adaptPreAuthController, F-W12-2).
    const columnController: JourneyConfigControllerSurface = journeySkipVisible
        ? { ...controller, onSkip: null, showSkip: false }
        : controller;

    const skipTop = safeAreaInsets.top + 20;
    const skipRight = safeAreaInsets.right + 28;

    const narrationPane = (
        <View
            key="narration"
            testID={`${testID}-narration-pane`}
            style={[
                styles.narrationPane,
                orientation === 'narration-left'
                    ? styles.narrationPaneLeft
                    : styles.narrationPaneRight,
            ]}
        >
            <ProgressHairline
                progress={props.progress}
                accentHue={accentHue}
                testID={`${testID}-progress-hairline`}
            />
            <ScrollView
                testID={`${testID}-narration-scroll`}
                style={styles.scrollFill}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <NarrationColumn
                    beat={beat}
                    direction={props.direction}
                    reducedMotion={props.reducedMotion}
                    testID={`${testID}-narration`}
                />
                <JourneyConfigSlot
                    controller={columnController}
                    layout="flow"
                    testID={`${testID}-config`}
                />
            </ScrollView>
        </View>
    );

    const stagePane = (
        <View key="stage" testID={`${testID}-stage-host`} style={styles.stageHost}>
            <StagePane
                mode={paneState.mode}
                accentHue={beat.accentHue}
                planetOpacity={paneState.planetOpacity}
                planetScale={paneState.planetScale}
                reducedMotion={props.reducedMotion}
                testID={`${testID}-stage-pane`}
            >
                {paneState.stageContentVisible ? props.stage : null}
            </StagePane>
        </View>
    );

    return (
        <View testID={testID} style={styles.root}>
            <View
                pointerEvents="none"
                testID={`${testID}-current-beat:${beat.id}`}
                style={styles.beatMarker}
            />
            {orientation === 'narration-left' ? narrationPane : stagePane}
            {orientation === 'narration-left' ? stagePane : narrationPane}
            <View
                testID={`${testID}-brand-logo`}
                pointerEvents="none"
                style={[
                    styles.brandLogo,
                    { top: safeAreaInsets.top + 28, left: safeAreaInsets.left + 40 },
                ]}
            >
                <BrandWordmark height={26} />
            </View>
            {journeySkipVisible && controller.onSkip ? (
                <SkipPill
                    testID={`${testID}-skip-pill`}
                    label={controller.skipLabel ?? t('journey.actions.skipToSetup')}
                    onPress={controller.onSkip}
                    top={skipTop}
                    right={skipRight}
                />
            ) : null}
        </View>
    );
}
