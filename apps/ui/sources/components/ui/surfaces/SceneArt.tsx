import * as React from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { createPlanetDots, planetLightForProgress } from '@happier-dev/brand/planet';
import {
    HAPPIER_SCENE_ART_METRICS,
    HAPPIER_SCENE_VIEWBOX,
    type HappierResolvedSceneLayer,
    type HappierResolvedSceneMark,
    type HappierResolvedScenePlanet,
    type HappierSceneRenderRequest,
} from '@happier-dev/plugin-ui/presentation';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * The line ink per theme (Daybreak library tokens): the primary text colour at a fixed strength, and a
 * quieter second line. The planet is the scene's colour; the one accent is the attention amber.
 */
const SCENE_INK = Object.freeze({
    light: Object.freeze({ ink: 0.64, faint: 0.24 }),
    dark: Object.freeze({ ink: 0.62, faint: 0.22 }),
});
/** A ground line fades out over this share of its length at each end. */
const FADE = 0.2;
/** The Brand planet's sphere is 0.4 of its dot box. */
const PLANET_BOX_PER_RADIUS = 2.5;
/** Scene planets draw their dots a little fuller than a mark's (library `planetDots`). */
const SCENE_DOT_SCALE = 1.38;
const SCENE_HALO = 0.55;
const GOLDEN_WARMTH = 0.25;
/** An out-of-reach planet is a faint ink disc inside its dashed outline. */
const INK_PLANET_STRENGTH = 0.42;
/** A rising planet comes up by this share of its radius, once (Daybreak's dawn: the Voice mark's pose event). */
const RISE_SHARE = 0.35;
const RISE_MS = 900;
const RISE_EASING = Easing.out(Easing.cubic);

type ScenePaint = Readonly<{ line: string; accent: string; ink: number; faint: number; stroke: number; scale: number }>;

/**
 * Happier's scene renderer: draws one resolved Daybreak scene (`resolveHappierScene`) for core states
 * (`EmptyState` / `SurfaceStateCard`) and, through the presentation host's `renderScene`, for plugin
 * states. Parts, composition and rules are the plugin-ui scene registry's; this renderer owns how a
 * scene looks: line ink and widths from theme tokens, the Brand dot planet, and the one-shot rise.
 *
 * Decorative: the state's title and copy carry the meaning, so the art is hidden from assistive tech.
 */
export const SceneArt = React.memo(function SceneArt(props: HappierSceneRenderRequest): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { scene } = props;
    const metrics = HAPPIER_SCENE_ART_METRICS[props.size];
    const width = metrics.widthPx;
    const scale = width / HAPPIER_SCENE_VIEWBOX.width;
    const height = HAPPIER_SCENE_VIEWBOX.height * scale;
    const mode = theme.dark ? 'dark' : 'light';
    const paint = React.useMemo<ScenePaint>(() => ({
        line: theme.colors.text.primary,
        accent: theme.colors.state.attention.foreground,
        ink: SCENE_INK[mode].ink,
        faint: SCENE_INK[mode].faint,
        // Lines keep the host's on-screen width at every size and prop scale.
        stroke: metrics.strokePx / scale,
        scale,
    }), [metrics.strokePx, mode, scale, theme.colors.state.attention.foreground, theme.colors.text.primary]);
    const idPrefix = `scene-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const still = props.still || reducedMotion;
    const back = scene.layers.filter((layer) => !layer.front);
    const front = scene.layers.filter((layer) => layer.front);
    const viewBox = `0 0 ${HAPPIER_SCENE_VIEWBOX.width} ${HAPPIER_SCENE_VIEWBOX.height}`;

    return (
        <View
            testID={props.testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            pointerEvents="none"
            style={{ width, height }}
        >
            <Svg width={width} height={height} viewBox={viewBox} fill="none">
                <SceneLayers layers={back} paint={paint} idPrefix={`${idPrefix}-b`} />
            </Svg>
            {scene.planets.map((planet, index) => (
                <ScenePlanet key={index} planet={planet} mode={mode} width={width} scale={scale} paint={paint} rises={planet.rises && !still} />
            ))}
            {front.length > 0 ? (
                <Svg width={width} height={height} viewBox={viewBox} fill="none" style={{ position: 'absolute', left: 0, top: 0 }}>
                    <SceneLayers layers={front} paint={paint} idPrefix={`${idPrefix}-f`} />
                </Svg>
            ) : null}
        </View>
    );
});

const TONES = ['ink', 'faint', 'accent'] as const;
const toneColor = (tone: HappierResolvedSceneMark['tone'], paint: ScenePaint) => (tone === 'accent' ? paint.accent : paint.line);
const toneOpacity = (tone: HappierResolvedSceneMark['tone'], paint: ScenePaint) => (tone === 'accent' ? 1 : tone === 'faint' ? paint.faint : paint.ink);

function SceneLayers(props: Readonly<{ layers: readonly HappierResolvedSceneLayer[]; paint: ScenePaint; idPrefix: string }>): React.ReactElement {
    const { paint } = props;
    return (
        <>
            {props.layers.map((layer, index) => {
                const fade = layer.fade;
                const fadeId = fade ? `${props.idPrefix}-${index}` : null;
                return (
                    <G
                        key={`${layer.name}-${index}`}
                        transform={`translate(${layer.x} ${layer.y}) scale(${layer.flip ? -layer.scale : layer.scale} ${layer.scale})`}
                    >
                        {fade && fadeId ? (
                            <Defs>
                                {TONES.map((tone) => (
                                    <LinearGradient key={tone} id={`${fadeId}-${tone}`} gradientUnits="userSpaceOnUse" x1={fade[0]} x2={fade[1]} y1={0} y2={0}>
                                        <Stop offset={0} stopColor={toneColor(tone, paint)} stopOpacity={0} />
                                        <Stop offset={FADE} stopColor={toneColor(tone, paint)} stopOpacity={toneOpacity(tone, paint)} />
                                        <Stop offset={1 - FADE} stopColor={toneColor(tone, paint)} stopOpacity={toneOpacity(tone, paint)} />
                                        <Stop offset={1} stopColor={toneColor(tone, paint)} stopOpacity={0} />
                                    </LinearGradient>
                                ))}
                            </Defs>
                        ) : null}
                        {layer.marks.map((mark, markIndex) => (
                            <SceneMark key={markIndex} mark={mark} paint={paint} layerScale={layer.scale} fadeId={fadeId} />
                        ))}
                    </G>
                );
            })}
        </>
    );
}

/** The library's dash patterns are on-screen lengths; the scene draws in its 160 × 64 box. */
function scaleDash(dash: string | undefined, factor: number): string | undefined {
    return dash?.split(/[\s,]+/).map((value) => String(Number(value) / factor)).join(' ');
}

function SceneMark(props: Readonly<{ mark: HappierResolvedSceneMark; paint: ScenePaint; layerScale: number; fadeId: string | null }>): React.ReactElement {
    const { mark, paint, layerScale, fadeId } = props;
    const color = toneColor(mark.tone, paint);
    const opacity = toneOpacity(mark.tone, paint);
    if (mark.shape === 'circle' && mark.filled) {
        return <Circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={color} fillOpacity={opacity * (mark.opacity ?? 1)} />;
    }
    const stroke = {
        stroke: fadeId ? `url(#${fadeId}-${mark.tone})` : color,
        strokeOpacity: fadeId ? 1 : opacity,
        strokeWidth: (paint.stroke / layerScale) * (mark.shape === 'path' ? mark.strokeScale ?? 1 : 1),
        strokeDasharray: scaleDash(mark.dash, paint.scale * layerScale),
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
    };
    switch (mark.shape) {
        case 'path': return <Path d={mark.d} {...stroke} opacity={mark.opacity} />;
        case 'rect': return <Rect x={mark.x} y={mark.y} width={mark.width} height={mark.height} rx={mark.radius} {...stroke} />;
        case 'ellipse': return <Ellipse cx={mark.cx} cy={mark.cy} rx={mark.rx} ry={mark.ry} transform={mark.rotate ? `rotate(${mark.rotate} ${mark.cx} ${mark.cy})` : undefined} {...stroke} />;
        case 'circle': return <Circle cx={mark.cx} cy={mark.cy} r={mark.r} {...stroke} opacity={mark.opacity} />;
    }
}

/**
 * One Daybreak dot planet (Brand `createPlanetDots`, the one planet source) on the scene's finer
 * lattice, hidden below its horizon. A rising planet comes up once when the scene appears, then rests;
 * an out-of-reach planet is drawn in the line ink.
 */
function ScenePlanet(props: Readonly<{
    planet: HappierResolvedScenePlanet;
    mode: 'light' | 'dark';
    width: number;
    scale: number;
    paint: ScenePaint;
    rises: boolean;
}>): React.ReactElement {
    const { planet, paint } = props;
    const box = planet.r * PLANET_BOX_PER_RADIUS;
    const dots = React.useMemo(() => createPlanetDots({
        size: box,
        rows: planet.rows,
        theme: props.mode,
        pose: planet.pose,
        energy: planet.energy,
        halo: SCENE_HALO,
        warmth: planet.warm ? GOLDEN_WARMTH : 0,
        ...(planet.progress !== undefined ? { light: planetLightForProgress(planet.progress) } : {}),
    }).filter((dot) => dot.opacity > 0), [box, planet.energy, planet.pose, planet.progress, planet.rows, planet.warm, props.mode]);
    const boxPx = box * props.scale;
    const riseBy = planet.r * props.scale * RISE_SHARE;
    const progress = useSharedValue(props.rises ? 0 : 1);
    React.useEffect(() => {
        if (!props.rises) return;
        progress.value = withTiming(1, { duration: RISE_MS, easing: RISE_EASING });
        // The rise plays once per mount; a later change of motion settles where it is.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const riseStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: (1 - progress.value) * riseBy }],
    }));
    return (
        <View
            testID="scene-planet"
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: props.width,
                // A planet standing on the ground is hidden below it; one in the sky is drawn whole.
                ...(planet.clipY !== undefined
                    ? { height: planet.clipY * props.scale, overflow: 'hidden' as const }
                    : { height: HAPPIER_SCENE_VIEWBOX.height * props.scale }),
            }}
        >
            <Animated.View
                testID="scene-planet-body"
                style={[{ position: 'absolute', left: (planet.cx - box / 2) * props.scale, top: (planet.cy - box / 2) * props.scale, width: boxPx, height: boxPx }, riseStyle]}
            >
                <Svg width={boxPx} height={boxPx} viewBox={`0 0 ${box} ${box}`}>
                    {dots.map((dot) => (
                        <Circle
                            key={dot.id}
                            cx={dot.x}
                            cy={dot.y}
                            r={dot.radius * SCENE_DOT_SCALE}
                            fill={planet.ink ? paint.line : `rgb(${dot.rgb[0]},${dot.rgb[1]},${dot.rgb[2]})`}
                            fillOpacity={planet.ink ? paint.ink * INK_PLANET_STRENGTH * dot.opacity : dot.opacity}
                        />
                    ))}
                </Svg>
            </Animated.View>
        </View>
    );
}
