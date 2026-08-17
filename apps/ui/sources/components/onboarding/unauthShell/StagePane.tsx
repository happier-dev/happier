import * as React from 'react';
import { Platform, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { stageVisualTokens } from '../tour/stage/stageVisualTokens';
import { BrandPanel } from './BrandPanel';
import { PlanetBackground } from './PlanetBackground';
import { useBrandPaneTokens } from './brandPaneTokens';

export type StagePanePlanetRecedeProps = Readonly<{
    accentHue?: string;
    planetOpacity?: number;
    planetScale?: number;
    reducedMotion?: boolean;
}>;

export type StagePaneProps = StagePanePlanetRecedeProps & Readonly<{
    testID?: string;
}> & (
        | Readonly<{ mode: 'brand' }>
        | Readonly<{ mode: 'stage'; children: React.ReactNode }>
    );

/**
 * Desktop right-pane host for unauthenticated onboarding.
 *
 * `brand` keeps today's planet/brand composition as the flag-off idle state.
 * `stage` is the future DemoStage slot. The planet recede props are intentionally
 * just opacity + scale so the journey can drive them later without changing the
 * shell contract.
 */
export const StagePane = React.memo(function StagePane(props: StagePaneProps) {
    const styles = stylesheet;
    const tokens = useBrandPaneTokens();
    const { theme } = useUnistyles();
    const isDark = Boolean((theme as { dark?: boolean }).dark);
    const horizon = isDark ? stageVisualTokens.horizon.dark : stageVisualTokens.horizon.light;
    const accentHue = props.accentHue ?? (isDark ? '#6D94FF' : '#FFB14A');
    const planetOpacity = props.planetOpacity ?? 1;
    const planetScale = props.planetScale ?? 1;
    const isWeb = Platform.OS === 'web';
    const stageFadeColors = [horizon.backgroundColorTransparent, horizon.backgroundColor] as const;

    if (props.mode === 'stage') {
        return (
            <View
                testID={props.testID ?? 'unauth-shell-stage-pane'}
                style={[styles.root, { backgroundColor: horizon.backgroundColor }]}
            >
                <View
                    testID="unauth-shell-stage-sky"
                    pointerEvents="none"
                    style={[
                        styles.stageSky,
                        {
                            backgroundColor: horizon.backgroundColor,
                            backgroundImage: horizon.skyGradient,
                        } as React.ComponentProps<typeof View>['style'],
                    ]}
                />
                <Animated.View
                    testID="unauth-shell-stage-wallpaper-host"
                    pointerEvents="none"
                    style={[
                        styles.stageWallpaperHost,
                        {
                            opacity: planetOpacity,
                            transform: [{ scale: planetScale }],
                        },
                    ]}
                >
                    <View
                        testID="unauth-shell-stage-atmosphere"
                        pointerEvents="none"
                        style={[
                            styles.stageAtmosphere,
                            {
                                backgroundColor: isWeb ? 'transparent' : horizon.atmosphereColor,
                                backgroundImage: `radial-gradient(circle at 50% 82%, ${horizon.atmosphereColor} 0%, rgba(255,255,255,0) 58%)`,
                            } as React.ComponentProps<typeof View>['style'],
                        ]}
                    />
                    {/* ONE planet framing recipe: the same call the brand pane
                        makes, so the journey and the welcome screen crop the
                        disc identically (full-bleed cover, low-right anchor). */}
                    <PlanetBackground variant="desktop" />
                    <View
                        testID="unauth-shell-stage-bloom"
                        pointerEvents="none"
                        style={[
                            styles.stageBloom,
                            {
                                backgroundColor: isWeb ? 'transparent' : horizon.bloomColor,
                                backgroundImage: `radial-gradient(circle at 50% 74%, ${accentHue}33 0%, ${accentHue}14 34%, rgba(255,255,255,0) 70%)`,
                            } as React.ComponentProps<typeof View>['style'],
                        ]}
                    />
                    <View
                        testID="unauth-shell-stage-noise"
                        pointerEvents="none"
                        style={[
                            styles.stageNoise,
                            isWeb ? {
                                backgroundImage: `url("${stageVisualTokens.horizon.noiseTileDataUri}")`,
                                backgroundRepeat: 'repeat',
                                backgroundSize: `${stageVisualTokens.horizon.noiseTileSize}px ${stageVisualTokens.horizon.noiseTileSize}px`,
                            } as React.ComponentProps<typeof View>['style'] : null,
                        ]}
                    />
                </Animated.View>
                {/* Bottom fade, matching the brand pane's: transparent -> the
                    pane canvas over the lower 55%. It sits OUTSIDE the wallpaper
                    host so it grounds the pane at full strength even while the
                    planet recedes behind a demo stage. */}
                <LinearGradient
                    testID="unauth-shell-stage-bottom-fade"
                    pointerEvents="none"
                    colors={stageFadeColors}
                    locations={[0, 1]}
                    style={styles.stageBottomFade}
                />
                <Animated.View
                    testID="unauth-shell-stage-content-host"
                    style={styles.stageContentHost}
                >
                    {props.children}
                </Animated.View>
            </View>
        );
    }

    return (
        <View
            testID={props.testID ?? 'unauth-shell-stage-pane'}
            style={[styles.root, { backgroundColor: tokens.background }]}
        >
            <Animated.View
                testID="unauth-shell-stage-brand-host"
                style={[
                    styles.brandHost,
                    {
                        opacity: planetOpacity,
                        transform: [{ scale: planetScale }],
                    },
                ]}
            >
                <BrandPanel variant="desktop" />
            </Animated.View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
    },
    brandHost: {
        flex: 1,
        minHeight: 0,
    },
    stageWallpaperHost: {
        bottom: 0,
        left: 0,
        position: 'absolute',
        right: 0,
        top: 0,
    },
    stageSky: {
        bottom: 0,
        left: 0,
        position: 'absolute',
        right: 0,
        top: 0,
    },
    stageAtmosphere: {
        bottom: '-12%',
        left: '-8%',
        opacity: 0.78,
        position: 'absolute',
        right: '-8%',
        top: '-12%',
    },
    stageBloom: {
        bottom: '-12%',
        left: '-10%',
        opacity: 0.72,
        position: 'absolute',
        right: '-10%',
        top: '-12%',
    },
    stageNoise: {
        bottom: 0,
        left: 0,
        opacity: stageVisualTokens.horizon.noiseOpacity,
        position: 'absolute',
        right: 0,
        top: 0,
    },
    stageBottomFade: {
        bottom: 0,
        height: stageVisualTokens.horizon.bottomFadeHeight,
        left: 0,
        position: 'absolute',
        right: 0,
    },
    stageContentHost: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
}));
