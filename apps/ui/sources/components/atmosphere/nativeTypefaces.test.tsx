import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PlanetCanvas } from './PlanetCanvas.native';

// Skia's native host is the system boundary. In @shopify/react-native-skia 2.4.18,
// `SkFont.getTypeface()` wraps the font's borrowed SkTypeface in an owning sk_sp without
// taking a reference (cpp/api/JsiSkFont.h), so each wrapper the JS GC collects releases a
// reference it never held. The shared face is freed while recorded pictures still draw
// with it: SIGSEGV in FT_Activate_Size (Android) / SkTypeface::countGlyphs (iOS).
// The mock mirrors that boundary: it counts those borrowed-reference adoptions and
// records the glyphs each picture draws, beneath the real painters.
const native = vi.hoisted(() => {
    const state = { borrowedAdoptions: 0, glyphs: 0, typefaces: new Map<string, { face: string }>() };
    const typefaceFor = (source: unknown) => {
        const face = /SemiBold/.test(String(source)) ? 'strong' : 'regular';
        let typeface = state.typefaces.get(face);
        if (!typeface) { typeface = { face }; state.typefaces.set(face, typeface); }
        return typeface;
    };
    const font = (typeface: { face: string } | undefined, size: number) => ({
        typeface, size, dispose() {}, setEmbolden() {},
        getTypeface: () => { state.borrowedAdoptions++; return typeface; },
        getMetrics: () => ({ ascent: -size * 0.8, descent: size * 0.2 }),
        getGlyphIDs: (text: string) => [...text].map(c => c.charCodeAt(0)),
        getGlyphWidths: (ids: number[]) => ids.map(() => size * 0.6),
    });
    const canvas = () => ({
        scale() {}, save() {}, saveLayer() {}, restore() {}, drawCircle() {}, drawRect() {},
        drawText(_text: string, _x: number, _y: number, _paint: unknown, drawn: { typeface?: unknown }) {
            if (!drawn.typeface) throw new Error('text drawn without a typeface');
            state.glyphs++;
        },
    });
    const paint = () => ({ dispose() {}, setAntiAlias() {}, setColor() {}, setAlphaf() {}, setBlendMode() {}, setShader() {} });
    return { state, typefaceFor, font, canvas, paint };
});

vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    BlendMode: { SrcOver: 'src-over', SrcATop: 'src-atop', DstIn: 'dst-in' },
    useTypeface: (source: unknown) => native.typefaceFor(source),
    useFont: (source: unknown, size = 14) => native.font(native.typefaceFor(source), size),
    createPicture: (draw: (canvas: ReturnType<typeof native.canvas>) => void) => { draw(native.canvas()); return { dispose() {} }; },
    Skia: { Paint: native.paint, Font: native.font, Color: (value: string) => value },
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

const pane = { width: 390, height: 844 };
const options = { R: 110, cx: 193, cy: 197, theme: 'dark', view: { w: pane.width, h: pane.height }, field: 1 } as const;

describe('native planet typefaces', () => {
    afterEach(() => { native.state.borrowedAdoptions = 0; native.state.glyphs = 0; });

    it('draws a static planet mark’s digits without adopting the font’s borrowed typeface', async () => {
        await act(async () => { renderScreen(<PlanetCanvas width={pane.width} height={pane.height} options={options} />); });
        expect(native.state.glyphs).toBeGreaterThan(0);
        expect(native.state.borrowedAdoptions).toBe(0);
    });
});
