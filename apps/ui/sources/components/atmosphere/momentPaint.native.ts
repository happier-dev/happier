import { BlendMode, FillType, PaintStyle, Skia, TileMode, type SkCanvas, type SkFont, type SkImage, type SkShader, type SkTypeface } from '@shopify/react-native-skia';
import { createPlanetScene } from '@happier-dev/brand/planet';
import type { MomentPaintCommand, MomentPlanetOptions } from '@happier-dev/brand/planet-moments';
import { paintNativePlanetScene } from './planetCanvasPaint.native';

export type NativeMomentEnvironment = Readonly<{
    w: number; h: number; dpr: number;
    /** Typefaces, not fonts: see paintNativePlanetScene on Skia's borrowed `getTypeface()`. */
    mono: SkTypeface; monoStrong: SkTypeface; sans: SkTypeface; sansMedium: SkTypeface; sansStrong: SkTypeface;
    mark?: SkImage | null;
}>;
type Colour = string | Readonly<{ gradient: number }>;
type Gradient = Readonly<{ kind: 'linear' | 'radial'; points: readonly number[]; stops: [number, string][] }>;
type State = { fill: Colour; stroke: Colour; alpha: number; width: number; font: string; align: 'left' | 'center'; baseline: 'alphabetic' | 'middle' | 'top'; dash: readonly number[] };

/** Canvas/Skia interpretation only. Brand owns every frame, path coordinate and scene. Runs on JS, never the UI runtime. */
export function paintNativeMomentCommands(canvas: SkCanvas, commands: readonly MomentPaintCommand[], env: NativeMomentEnvironment): void {
    let state: State = { fill: '#000', stroke: '#000', alpha: 1, width: 1, font: '400 10px InterLab', align: 'left', baseline: 'alphabetic', dash: [] };
    const stack: State[] = [];
    const gradients = new Map<number, Gradient>();
    const shaders = new Map<number, SkShader>();
    const fonts = new Map<string, SkFont>();
    const paint = Skia.Paint(); paint.setAntiAlias(true);
    let path = Skia.Path.Make();
    const apply = (colour: Colour, stroke = false) => {
        paint.setShader(null); paint.setPathEffect(null);
        paint.setStyle(stroke ? PaintStyle.Stroke : PaintStyle.Fill);
        paint.setStrokeWidth(state.width);
        paint.setBlendMode(BlendMode.SrcOver);
        if (typeof colour === 'string') {
            const rgba = Skia.Color(colour);
            paint.setColor(rgba); paint.setAlphaf(rgba[3] * state.alpha);
        } else {
            let shader = shaders.get(colour.gradient);
            if (!shader) {
                const gradient = gradients.get(colour.gradient);
                if (!gradient) throw new Error('Atmosphere gradient is unavailable');
                const colors = gradient.stops.map(([, value]) => Skia.Color(value));
                const positions = gradient.stops.map(([position]) => position);
                const p = gradient.points;
                shader = gradient.kind === 'linear'
                    ? Skia.Shader.MakeLinearGradient({ x: p[0], y: p[1] }, { x: p[2], y: p[3] }, colors, positions, TileMode.Clamp)
                    : Skia.Shader.MakeTwoPointConicalGradient({ x: p[0], y: p[1] }, p[2], { x: p[3], y: p[4] }, p[5], colors, positions, TileMode.Clamp);
                shaders.set(colour.gradient, shader);
            }
            paint.setColor(Skia.Color('#fff')); paint.setAlphaf(state.alpha); paint.setShader(shader);
        }
        if (stroke && state.dash.length) {
            const dash = Skia.PathEffect.MakeDash([...state.dash], 0);
            paint.setPathEffect(dash); dash?.dispose();
        }
    };
    const textFont = () => {
        let font = fonts.get(state.font);
        if (font) return font;
        const match = /^(\d+)\s+([\d.]+)px\s+(.*)$/.exec(state.font);
        if (!match) throw new Error('Atmosphere moment font is invalid');
        const weight = Number(match[1]), size = Number(match[2]);
        const mono = /plex\s*mono|monospace/i.test(match[3]);
        const face = mono ? (weight >= 600 ? env.monoStrong : env.mono) : weight >= 600 ? env.sansStrong : weight >= 500 ? env.sansMedium : env.sans;
        font = Skia.Font(face, size); fonts.set(state.font, font);
        return font;
    };
    try {
        for (const command of commands) {
            switch (command[0]) {
                case 'set': {
                    const [, key, value] = command;
                    switch (key) {
                        case 'fillStyle': state.fill = value; break;
                        case 'strokeStyle': state.stroke = value; break;
                        case 'font': state.font = value; break;
                        case 'textAlign': state.align = value; break;
                        case 'textBaseline': state.baseline = value; break;
                        case 'globalAlpha': state.alpha = value; break;
                        case 'lineWidth': state.width = value; break;
                    }
                    break;
                }
                case 'createLinearGradient': gradients.set(command[1], { kind: 'linear', points: command.slice(2) as number[], stops: [] }); break;
                case 'createRadialGradient': gradients.set(command[1], { kind: 'radial', points: command.slice(2) as number[], stops: [] }); break;
                case 'addColorStop': gradients.get(command[1])?.stops.push([command[2], command[3]]); break;
                case 'save': stack.push({ ...state }); canvas.save(); break;
                case 'restore': state = stack.pop() ?? state; canvas.restore(); break;
                case 'translate': canvas.translate(command[1], command[2]); break;
                case 'scale': canvas.scale(command[1], command[2]); break;
                case 'beginPath': path.dispose(); path = Skia.Path.Make(); break;
                case 'roundRect': path.addRRect(Skia.RRectXY(Skia.XYWHRect(command[1], command[2], command[3], command[4]), command[5], command[5])); break;
                case 'arc': {
                    const [, x, y, r, a0, a1] = command;
                    const rect = Skia.XYWHRect(x - r, y - r, r * 2, r * 2);
                    if (a1 - a0 >= Math.PI * 2) path.addOval(rect);
                    else path.addArc(rect, a0 * 180 / Math.PI, (a1 - a0) * 180 / Math.PI);
                    break;
                }
                case 'fill': apply(state.fill); path.setFillType(command[1] === 'evenodd' ? FillType.EvenOdd : FillType.Winding); canvas.drawPath(path, paint); break;
                case 'stroke': apply(state.stroke, true); canvas.drawPath(path, paint); break;
                case 'fillRect': apply(state.fill); canvas.drawRect(Skia.XYWHRect(command[1], command[2], command[3], command[4]), paint); break;
                case 'setLineDash': state.dash = command[1]; break;
                case 'fillText': {
                    apply(state.fill); const font = textFont(); const metrics = font.getMetrics();
                    const width = font.getGlyphWidths(font.getGlyphIDs(command[1])).reduce((sum, n) => sum + n, 0);
                    const x = command[2] - (state.align === 'center' ? width / 2 : 0);
                    const y = command[3] - (state.baseline === 'middle' ? (metrics.ascent + metrics.descent) / 2 : state.baseline === 'top' ? metrics.ascent : 0);
                    canvas.drawText(command[1], x, y, paint, font); break;
                }
                case 'drawImage':
                    if (env.mark) { apply('#fff'); canvas.drawImageRect(env.mark, Skia.XYWHRect(0, 0, env.mark.width(), env.mark.height()), Skia.XYWHRect(command[2], command[3], command[4], command[5]), paint); }
                    break;
                case 'planet': {
                    const layer: MomentPlanetOptions & Readonly<{ alpha?: number }> = command[1];
                    const { alpha = 1, ...options } = layer;
                    if (alpha <= 0) break;
                    apply('#fff'); paint.setAlphaf(state.alpha * alpha); canvas.saveLayer(paint);
                    paintNativePlanetScene(canvas, createPlanetScene({ ...options, view: options.view ?? { w: env.w, h: env.h }, dpr: env.dpr }), env.mono, env.monoStrong);
                    canvas.restore(); break;
                }
            }
        }
    } finally {
        path.dispose(); paint.dispose(); fonts.forEach(font => font.dispose()); shaders.forEach(shader => shader.dispose());
    }
}
