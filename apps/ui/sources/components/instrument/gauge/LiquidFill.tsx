import * as React from 'react';
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia';
import {
    useDerivedValue,
    useFrameCallback,
    useSharedValue,
    type SharedValue,
} from 'react-native-reanimated';

import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { resolveUsageTone } from './gaugeMath';

/**
 * Tier-1 context gauge fill (Skia, native, `full` effects level only): a
 * circular vessel whose fill is a fluid surface — an SkSL shader with a gently
 * undulating meniscus (two summed sines, amplitude ≤ 8% of radius, ~0.4Hz) and
 * a soft specular highlight top-left. The clock is a Reanimated frame callback
 * that runs ONLY while `isStreaming` and the app is active — idle gauges
 * schedule zero frames (fill-level changes still redraw via uniforms).
 *
 * While streaming, meniscus amplitude ×1.5 and a slow shimmer band sweeps the
 * fill. No gyroscope parallax in v1 (perf/battery); noted as a future upgrade.
 */

const LIQUID_FILL_SKSL = `
uniform float2 u_center;
uniform float u_radius;
uniform float u_level;      // 0..1
uniform float u_time;       // seconds
uniform float u_amp;        // meniscus amplitude, px
uniform float u_streaming;  // 0 | 1
uniform float4 u_fill;
uniform float4 u_track;

half4 main(float2 pos) {
    float2 d = pos - u_center;
    float dist = length(d);
    if (dist > u_radius) {
        return half4(0.0);
    }

    // Meniscus: two summed sines, ~0.4Hz primary (2.5 rad/s).
    float wave = u_amp * (
        0.6 * sin(pos.x * 0.35 + u_time * 2.5) +
        0.4 * sin(pos.x * 0.80 - u_time * 1.7)
    );
    float surfaceY = u_center.y + u_radius - 2.0 * u_radius * u_level + wave;

    half4 color = pos.y > surfaceY ? half4(u_fill) : half4(u_track);

    // Slow shimmer band while streaming.
    float bandX = u_center.x + u_radius * sin(u_time * 0.9);
    float band = u_streaming * 0.08 * exp(-pow((pos.x - bandX) / (u_radius * 0.5), 2.0));
    color.rgb += half3(band) * half(pos.y > surfaceY ? 1.0 : 0.0);

    // Specular highlight, top-left.
    float2 hl = pos - (u_center + float2(-u_radius * 0.40, -u_radius * 0.45));
    float glow = max(0.0, 1.0 - length(hl) / (u_radius * 0.9));
    color.rgb += half3(glow * glow * 0.16);

    // Soft edge.
    float edge = smoothstep(u_radius, u_radius - 1.0, dist);
    return color * half(edge);
}
`;

// Null-safe: absent RuntimeEffect (e.g. node test env) simply reports
// unsupported and the owner falls back to the tier-2 ring.
const liquidFillEffect = (() => {
    try {
        return Skia?.RuntimeEffect?.Make?.(LIQUID_FILL_SKSL) ?? null;
    } catch {
        return null;
    }
})();

export function isLiquidFillSupported(): boolean {
    return liquidFillEffect !== null;
}

function colorToFloat4(color: string): [number, number, number, number] {
    const hex = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color.trim());
    if (hex) {
        const n = parseInt(hex[1]!, 16);
        const alpha = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
        return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, alpha];
    }
    const rgba = /^rgba?\(([^)]+)\)$/.exec(color.trim());
    if (rgba) {
        const parts = rgba[1]!.split(',').map((p) => parseFloat(p.trim()));
        return [
            (parts[0] ?? 0) / 255,
            (parts[1] ?? 0) / 255,
            (parts[2] ?? 0) / 255,
            parts.length > 3 ? (parts[3] ?? 1) : 1,
        ];
    }
    return [0.5, 0.5, 0.5, 1];
}

export type LiquidFillProps = Readonly<{
    /** Animated fill percentage 0–100 (already spring-smoothed by the owner). */
    fillPct: SharedValue<number>;
    size: number;
    isStreaming: boolean;
    /** Tone colors resolved from the theme by the owner. */
    okColor: string;
    warnColor: string;
    dangerColor: string;
    trackColor: string;
    testID?: string;
}>;

export const LiquidFill = React.memo(function LiquidFill(props: LiquidFillProps) {
    const { size, isStreaming } = props;
    const radius = size / 2;

    // One host watch for the whole app, not one subscription per gauge — and it
    // treats `inactive` as not viewed, which a private `!== 'background'` sample
    // did not: a gauge mounted behind Control Centre used to start a shader
    // nobody could see.
    const hostViewed = useHostActivelyViewed();

    const running = isStreaming && hostViewed;
    const timeSeconds = useSharedValue(0);
    const frame = useFrameCallback((info) => {
        timeSeconds.value += (info.timeSincePreviousFrame ?? 0) / 1000;
    }, false);
    const setFrameActive = frame.setActive;
    React.useEffect(() => {
        setFrameActive(running);
    }, [running, setFrameActive]);

    // 85% fill opacity over the track; amplitude ≤ 8% of radius (5% base, ×1.5 streaming).
    const toneFloat4 = React.useMemo(() => ({
        ok: colorToFloat4(props.okColor).map((v, i) => (i === 3 ? 0.85 : v)) as [number, number, number, number],
        warn: colorToFloat4(props.warnColor).map((v, i) => (i === 3 ? 0.85 : v)) as [number, number, number, number],
        danger: colorToFloat4(props.dangerColor).map((v, i) => (i === 3 ? 0.85 : v)) as [number, number, number, number],
        track: colorToFloat4(props.trackColor),
    }), [props.dangerColor, props.okColor, props.trackColor, props.warnColor]);

    const fillPct = props.fillPct;
    const uniforms = useDerivedValue(() => {
        const pct = fillPct.value;
        const tone = resolveUsageTone(pct);
        const fill = tone === 'danger' ? toneFloat4.danger : tone === 'warn' ? toneFloat4.warn : toneFloat4.ok;
        return {
            u_center: [radius, radius],
            u_radius: radius,
            u_level: Math.max(0, Math.min(1, pct / 100)),
            u_time: timeSeconds.value,
            u_amp: radius * (running ? 0.075 : 0.05),
            u_streaming: running ? 1 : 0,
            u_fill: fill,
            u_track: toneFloat4.track,
        };
    }, [radius, running, toneFloat4]);

    if (!liquidFillEffect) return null;

    return (
        <Canvas testID={props.testID} style={{ width: size, height: size }}>
            <Fill>
                <Shader source={liquidFillEffect} uniforms={uniforms} />
            </Fill>
        </Canvas>
    );
});
