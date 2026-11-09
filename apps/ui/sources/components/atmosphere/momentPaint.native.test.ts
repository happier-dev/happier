import { expect, it, vi } from 'vitest';
import { pairingMomentFrame, qrMomentFrame, qrMomentModel, themeSwitchFrame, type MomentPaintCommand } from '@happier-dev/brand/planet-moments';
import { createPlanetScene } from '@happier-dev/brand/planet';
import { paintMomentCommands } from './momentPaint.web';
import { paintNativeMomentCommands } from './momentPaint.native';
import { paintNativePlanetScene } from './planetCanvasPaint.native';
import { paintNativeThemeHorizon } from '../settings/appearance/themeHorizonPaint.native';

// Canvas/Skia drawing and font metrics are system boundaries. Both real interpreters, the real
// planet painter and the brand frame builders run beneath these recording surfaces.
const boundary = vi.hoisted(() => {
    const colour = (s: string | Float32Array): number[] => {
        if (typeof s !== 'string') return Array.from(s);
        if (s.startsWith('#')) {
            const hex = s.slice(1); const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
            return [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255, 1];
        }
        const values = s.match(/[\d.]+/g)!.map(Number);
        return [values[0] / 255, values[1] / 255, values[2] / 255, values[3] ?? 1];
    };
    const font = (face: string, size: number) => ({ face, size, embolden: false, dispose() {},
        getTypeface: () => face, getMetrics: () => ({ ascent: -size * 0.8, descent: size * 0.2 }),
        getGlyphIDs: (text: string) => [...text].map(c => c.charCodeAt(0)),
        getGlyphWidths: (ids: number[]) => ids.map(() => size * 0.6),
        // Skia 2.4.18's native JsiSkFont.h uses Value::asNumber here, unlike its
        // boolean TS/web API. Mirror that host boundary, including its refusal.
        setEmbolden(value: unknown) {
            if (typeof value !== 'number') throw new TypeError('Native setEmbolden expects a number');
            this.embolden = value !== 0;
        } });
    const paint = () => ({ color: [0, 0, 0, 1], shader: null as unknown, dash: [] as number[], style: 'fill', width: 1, blend: 'source-over',
        dispose() {}, setAntiAlias() {}, setColor(value: string | Float32Array) { this.color = colour(value); },
        setAlphaf(value: number) { this.color[3] = value; }, setShader(value: unknown) { this.shader = value; },
        setPathEffect(value: { dash: number[] } | null) { this.dash = value?.dash ?? []; },
        setStyle(value: string) { this.style = value; }, setStrokeWidth(value: number) { this.width = value; }, setBlendMode(value: string) { this.blend = value; } });
    const path = () => ({ parts: [] as unknown[], fill: 'nonzero', dispose() {},
        addCircle(x: number, y: number, r: number) { this.parts.push(['circle', x, y, r]); },
        addRRect(r: { rect: { x: number; y: number; width: number; height: number }; r: number }) { this.parts.push(['roundRect', r.rect.x, r.rect.y, r.rect.width, r.rect.height, r.r]); },
        addOval(r: { x: number; y: number; width: number; height: number }) { this.parts.push(['arc', r.x + r.width / 2, r.y + r.height / 2, r.width / 2, 0, Math.PI * 2]); },
        addArc(r: { x: number; y: number; width: number; height: number }, a: number, sweep: number) { this.parts.push(['arc', r.x + r.width / 2, r.y + r.height / 2, r.width / 2, a * Math.PI / 180, (a + sweep) * Math.PI / 180]); },
        setFillType(fill: string) { this.fill = fill; } });
    return { colour, font, paint, path };
});

vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    BlendMode: { SrcOver: 'source-over', SrcATop: 'source-atop' }, PaintStyle: { Fill: 'fill', Stroke: 'stroke' },
    FillType: { Winding: 'nonzero', EvenOdd: 'evenodd' }, TileMode: { Clamp: 0 },
    ClipOp: { Difference: 'difference' },
    Skia: { Color: boundary.colour, Paint: boundary.paint, Font: boundary.font, Path: { Make: boundary.path },
        XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
        RRectXY: (rect: unknown, r: number) => ({ rect, r }),
        PathEffect: { MakeDash: (dash: number[]) => ({ dash, dispose() {} }) },
        Shader: {
            MakeLinearGradient: (a: unknown, b: unknown, colors: unknown, positions: unknown) => ({ kind: 'linear', a, b, colors, positions, dispose() {} }),
            MakeTwoPointConicalGradient: (a: unknown, r0: number, b: unknown, r1: number, colors: unknown, positions: unknown) => ({ kind: 'radial', a, b, r0, r1, colors, positions, dispose() {} }),
        },
    },
}));

function recordWeb() {
    const draws: unknown[] = [];
    let path: unknown[] = [];
    const stack: object[] = [];
    const ctx = {
        draws, fillStyle: '#000' as unknown, strokeStyle: '#000' as unknown, globalAlpha: 1, lineWidth: 1,
        font: '400 10px InterLab', textAlign: 'left', textBaseline: 'alphabetic', globalCompositeOperation: 'source-over', dash: [] as number[], transforms: [] as unknown[],
        save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, globalCompositeOperation: this.globalCompositeOperation, dash: this.dash, transforms: [...this.transforms] }); },
        restore() { Object.assign(this, stack.pop()); },
        beginPath() { path = []; }, roundRect(...p: number[]) { path.push(['roundRect', ...p]); },
        arc(x: number, y: number, r: number, a: number, b: number) { path.push(['arc', x, y, r, a, b - a >= Math.PI * 2 ? a + Math.PI * 2 : b]); },
        translate(x: number, y: number) { this.transforms.push(['translate', x, y]); }, scale(x: number, y: number) { this.transforms.push(['scale', x, y]); },
        setTransform() {}, setLineDash(dash: number[]) { this.dash = dash; },
        fill(rule = 'nonzero') { draws.push({ kind: 'path', path: [...path], rule, ...this.brush(false) }); },
        stroke() { draws.push({ kind: 'path', path: [...path], rule: 'nonzero', ...this.brush(true) }); },
        fillRect(x: number, y: number, w: number, h: number) { draws.push({ kind: 'rect', rect: [x, y, w, h], ...this.brush(false) }); },
        fillText(text: string, x: number, y: number) { const match = /^(\d+) ([\d.]+)px (.*)$/.exec(this.font)!;
            const size = Number(match[2]);
            const mono = /mono/i.test(match[3]);
            draws.push({ kind: 'text', text, x: x - (this.textAlign === 'center' ? text.length * size * 0.3 : 0), y: y + (this.textBaseline === 'middle' ? size * 0.3 : this.textBaseline === 'top' ? size * 0.8 : 0), face: `${mono ? 'mono' : 'sans'}${Number(match[1]) >= 600 ? 600 : !mono && Number(match[1]) >= 500 ? 500 : 400}`, size, ...this.brush(false) }); },
        drawImage(image: { draws?: unknown[] }, x: number, y: number, w: number, h: number) { draws.push(image.draws ? { kind: 'layer', alpha: this.globalAlpha, draws: image.draws } : { kind: 'mark', rect: [x, y, w, h], ...this.brush(false), color: [1, 1, 1, this.globalAlpha], shader: null }); },
        brush(stroke: boolean) {
            const value = stroke ? this.strokeStyle : this.fillStyle;
            const color = typeof value === 'string' ? boundary.colour(value) : [1, 1, 1, 1]; color[3] *= this.globalAlpha;
            return { color, shader: typeof value === 'string' ? null : value, stroke, width: stroke ? this.lineWidth : 1, dash: stroke ? this.dash : [], blend: this.globalCompositeOperation, transforms: [...this.transforms] };
        },
        createLinearGradient(x0: number, y0: number, x1: number, y1: number) { return gradient({ kind: 'linear', a: { x: x0, y: y0 }, b: { x: x1, y: y1 } }); },
        createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) { return gradient({ kind: 'radial', a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, r0, r1 }); },
    };
    return ctx;
}
function gradient(base: object) { return { ...base, colors: [] as number[][], positions: [] as number[],
    addColorStop(position: number, value: string) { this.positions.push(position); this.colors.push(boundary.colour(value)); } }; }

function recordNative() {
    let draws: unknown[] = [], transforms: unknown[] = [];
    const root = draws;
    const textWeights: boolean[] = [];
    const stack: { transforms: unknown[]; parent?: unknown[]; alpha?: number }[] = [];
    const brush = (paint: ReturnType<typeof boundary.paint>) => ({ color: [...paint.color], shader: paint.shader, stroke: paint.style === 'stroke', width: paint.style === 'stroke' ? paint.width : 1, dash: paint.style === 'stroke' ? paint.dash : [], blend: paint.blend, transforms: [...transforms] });
    return { root, textWeights, canvas: {
        save() { stack.push({ transforms: [...transforms] }); },
        saveLayer(paint?: ReturnType<typeof boundary.paint>) { stack.push({ transforms: [...transforms], ...(paint ? { parent: draws, alpha: paint.color[3] } : {}) }); if (paint) draws = []; },
        restore() { const held = stack.pop()!; transforms = held.transforms; if (held.parent) { const layer = { kind: 'layer', alpha: held.alpha, draws }; draws = held.parent; draws.push(layer); } },
        translate(x: number, y: number) { transforms.push(['translate', x, y]); }, scale(x: number, y: number) { transforms.push(['scale', x, y]); },
        clipPath(p: ReturnType<typeof boundary.path>, op: string) { draws.push({ kind: 'clip', path: [...p.parts], op }); },
        drawPath(p: ReturnType<typeof boundary.path>, paint: ReturnType<typeof boundary.paint>) { draws.push({ kind: 'path', path: [...p.parts], rule: paint.style === 'stroke' ? 'nonzero' : p.fill, ...brush(paint) }); },
        drawRect(r: { x: number; y: number; width: number; height: number }, paint: ReturnType<typeof boundary.paint>) { draws.push({ kind: 'rect', rect: [r.x, r.y, r.width, r.height], ...brush(paint) }); },
        drawCircle(x: number, y: number, r: number, paint: ReturnType<typeof boundary.paint>) { draws.push({ kind: 'path', path: [['arc', x, y, r, 0, Math.PI * 2]], rule: 'nonzero', ...brush(paint) }); },
        drawText(text: string, x: number, y: number, paint: ReturnType<typeof boundary.paint>, font: ReturnType<typeof boundary.font>) { textWeights.push(font.embolden); draws.push({ kind: 'text', text, x, y, face: font.face, size: font.size, ...brush(paint) }); },
        drawImageRect(_image: unknown, _src: unknown, r: { x: number; y: number; width: number; height: number }, paint?: ReturnType<typeof boundary.paint>) {
            const held = paint ?? boundary.paint();
            if (!paint) held.setColor('#fff');
            draws.push({ kind: 'mark', rect: [r.x, r.y, r.width, r.height], ...brush(held) });
        },
    } };
}

// Opaque host interfaces are represented only at this genuine native/DOM boundary.
function paintBoth(commands: readonly MomentPaintCommand[]) {
    const env = { w: 120, h: 120, dpr: 2 };
    vi.stubGlobal('document', { documentElement: {}, createElement: () => { const context = recordWeb(); return { getContext: () => context, draws: context.draws }; } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const web = recordWeb();
    const native = recordNative();
    const fonts = { mono: boundary.font('mono400', 12), monoStrong: boundary.font('mono600', 12), sans: boundary.font('sans400', 12), sansMedium: boundary.font('sans500', 12), sansStrong: boundary.font('sans600', 12) };
    paintMomentCommands(web as unknown as CanvasRenderingContext2D, commands, { ...env, mark: { complete: true, naturalWidth: 32 } as HTMLImageElement });
    paintNativeMomentCommands(native.canvas as unknown as Parameters<typeof paintNativeMomentCommands>[0], commands,
        { ...env, ...fonts, mark: { width: () => 32, height: () => 32 } } as unknown as Parameters<typeof paintNativeMomentCommands>[2]);
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry: unknown) => typeof entry === 'function' ? undefined : key === 'addColorStop' ? undefined : typeof entry === 'number' ? Math.round(entry * 1e5) / 1e5 : entry));
    expect(normalize(native.root)).toEqual(normalize(web.draws));
    vi.unstubAllGlobals();
    return native.root;
}

it('paints cut and regular planet glyphs through the numeric native embolden boundary', () => {
    for (const overStyle of ['ink', 'emboss'] as const) {
        const scene = createPlanetScene({ R: 120, cx: 160, cy: 90, view: { w: 390, h: 260 },
            theme: 'light', dpr: 2, field: { around: 1, over: 0.62, overStyle } });
        const native = recordNative();
        // Only opaque Skia canvas/font host objects are substituted here.
        paintNativePlanetScene(native.canvas as unknown as Parameters<typeof paintNativePlanetScene>[0], scene,
            boundary.font('mono400', 12) as unknown as Parameters<typeof paintNativePlanetScene>[2],
            boundary.font('mono600', 12) as unknown as Parameters<typeof paintNativePlanetScene>[3]);
        expect(native.textWeights).toContain(false);
        if (overStyle === 'ink') expect(native.textWeights).toContain(true);
        else expect(native.textWeights).not.toContain(true);
    }
});

it('preserves command order, saved paint state, transforms, gradients, holes, dash and mark alpha', () => {
    paintBoth([['save'], ['translate', 2, 4], ['scale', 0.5, 0.5], ['set', 'globalAlpha', 0.4],
        ['createLinearGradient', 1, 0, 0, 8, 8], ['addColorStop', 1, 0, '#fff'], ['addColorStop', 1, 1, '#000'], ['set', 'fillStyle', { gradient: 1 }], ['fillRect', 0, 0, 8, 8],
        ['beginPath'], ['roundRect', 1, 1, 6, 6, 2], ['roundRect', 2, 2, 4, 4, 1], ['fill', 'evenodd'],
        ['set', 'strokeStyle', 'rgba(20,40,60,0.5)'], ['set', 'lineWidth', 2], ['setLineDash', [2, 3]], ['stroke'],
        ['drawImage', 'happier-mark', 1, 2, 3, 4], ['restore'], ['set', 'fillStyle', '#fff'], ['fillRect', 9, 9, 1, 1]]);
});

it('matches web paint output for actual QR/reform/scan, pairing and both Horizon directions', () => {
    const matrix = { size: 21, data: Uint8Array.from({ length: 441 }, (_, i) => i % 3 ? 1 : 0), text: 'invite' };
    const model = qrMomentModel(matrix, 120, 2);
    for (const theme of ['light', 'dark'] as const) {
        for (const t of [0, 0.3, 0.7, 1]) {
            paintBoth(qrMomentFrame(model, t, { size: 120, theme }).commands);
            paintBoth(qrMomentFrame(model, t, { size: 120, theme, phase: 'reform', next: model, wait: 0.2 }).commands);
            paintBoth(qrMomentFrame(model, t, { size: 120, theme, phase: 'scan' }).commands);
            const pairingPaint = paintBoth(pairingMomentFrame(t, { w: 120, h: 120, theme, layout: 'square', phase: 'joined', devices: [{ n: 'Dev box' }, { n: 'Phone', isNew: true }] }));
            // An enabled flag or two empty adapters cannot establish native support.
            expect(pairingPaint.length).toBeGreaterThan(0);
        }
    }
    for (const dir of ['sunrise', 'night'] as const) for (const t of [0, 0.3, 0.6, 0.9, 1.2]) paintBoth(themeSwitchFrame(t, { w: 120, h: 120, dir }).commands);
});

it('reveals the live new theme through the complement of the exact brand Horizon clip', () => {
    const fonts = { mono: boundary.font('mono400', 12), monoStrong: boundary.font('mono600', 12), sans: boundary.font('sans400', 12), sansMedium: boundary.font('sans500', 12), sansStrong: boundary.font('sans600', 12) };
    const env = { w: 120, h: 120, dpr: 2, ...fonts };
    const image = { width: () => 120, height: () => 120 };
    for (const dir of ['sunrise', 'night'] as const) for (const t of [0, 0.3, 0.6, 0.9, 1.2]) {
        const frame = themeSwitchFrame(t, { w: env.w, h: env.h, dir, kind: 'horizon' });
        const native = recordNative();
        // Screenshot and native font interfaces are genuine boundary fixtures, not domain doubles.
        paintNativeThemeHorizon(native.canvas as unknown as Parameters<typeof paintNativeThemeHorizon>[0], image as unknown as Parameters<typeof paintNativeThemeHorizon>[1], t, dir, env as unknown as Parameters<typeof paintNativeThemeHorizon>[4]);
        const draws = native.root as { kind: string; path?: unknown[]; op?: string; rect?: number[] }[];
        if (frame.clipPath === 'none') expect(draws.some(draw => draw.kind === 'mark')).toBe(false);
        else {
            const screenshot = draws.findIndex(draw => draw.kind === 'mark');
            expect(draws[screenshot].rect).toEqual([0, 0, env.w, env.h]);
            if (frame.visibility === 'hidden') expect(draws[0].kind).toBe('mark');
            else {
                const values = frame.clipPath.match(/[-\d.e+]+(?=px)/g)!.map(Number);
                expect(draws[0]).toEqual({ kind: 'clip', path: [['circle', values[1], values[2], values[0]]], op: 'difference' });
                expect(screenshot).toBe(1);
            }
        }
    }
});
