import type { PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { createPlanetStatusCell } from '@happier-dev/brand/planet';
import { glyphFrame, planetGlyphLayer, type GlyphFrame, glyphLatticeRadius, glyphLatticeTile, glyphRampChars, glyphRampFirstTile, glyphSmallDigitHeight } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import * as privacyKit from 'privacy-kit';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { readPublicProfileFont, readPublicProfilePlanetFont } from './publicProfileFonts';
import { renderPublicProfileBackdrop } from './publicProfileBackdrop';
import { PUBLIC_PROFILE_FONT_COVERAGE, PUBLIC_PROFILE_FONT_FAMILIES } from './publicProfileFontCoverage.generated';

export type PublicProfileBadgeMetric = 'tokens' | 'agent-time' | 'merged-prs' | 'streak' | 'peak-parallel';
export type PublicProfileAssetMetric = PublicProfileBadgeMetric | 'active-days';
export interface PublicProfileAssetLabels {
    brand: string;
    paused: string;
    unavailable: string;
    empty: string;
    period(period: Extract<PublicProfileReadResultV1, { kind: 'published' }>['view']['snapshot']['period']): string;
    synced(computedAtMs: number): string;
    metricLabel(metric: PublicProfileAssetMetric): string;
    formatMetric(metric: PublicProfileAssetMetric, value: number): string;
}
export interface PublicProfileAssetPalette {
    background: string;
    foreground: string;
    secondary: string;
    border: string;
    backgroundRgb: readonly [number, number, number];
}
export interface PublicProfileSvgOptions {
    kind: 'badge' | 'card' | 'og';
    metric?: string;
    theme: 'auto' | 'light' | 'dark';
    labels: PublicProfileAssetLabels;
    palette: Readonly<Record<'light' | 'dark', PublicProfileAssetPalette>>;
    /** Only current admitted local pixels; appearance and effects come from the safe view. */
    picture?: Buffer;
}

const metricFields = [
    ['tokens', 'tokens'], ['active-days', 'activeDays'], ['streak', 'currentStreakDays'],
    ['agent-time', 'agentTimeMs'], ['merged-prs', 'mergedPrs'], ['peak-parallel', 'peakParallel'],
] as const;

/** Fixed physical adapters consume only the current, already-projected visitor union. */
export async function renderPublicProfileSvg(result: PublicProfileReadResultV1, options: PublicProfileSvgOptions): Promise<string> {
    if (options.kind === 'badge') return renderBadge(result, options);
    const width = options.kind === 'card' ? 495 : 1200;
    const height = options.kind === 'card' ? 195 : 630;
    const title = describe(result, options.labels);
    const themes: readonly ('light' | 'dark')[] = options.kind === 'og' ? ['dark'] : options.theme === 'auto' ? ['light', 'dark'] : [options.theme];
    const layers = await Promise.all(themes.map(async theme => {
        const palette = options.palette[theme];
        const background = result.kind === 'published' ? await renderAtmosphere(result.view, options, theme, width, height) : '';
        const content = await renderSummary(result, options, palette, width, height);
        const frame = options.kind === 'card' ? `<rect x=".5" y=".5" width="494" height="194" rx="13.5" fill="none" stroke="${xml(palette.border)}"/>` : '';
        return `<g class="edition-${theme}"><rect width="${width}" height="${height}" fill="${xml(palette.background)}"/>${background}${content}${frame}</g>`;
    }));
    return root(width, height, title, `${autoThemeStyle(themes.length > 1)}<defs><clipPath id="frame"><rect width="${width}" height="${height}" rx="${options.kind === 'card' ? 14 : 0}"/></clipPath></defs><g clip-path="url(#frame)">${layers.join('')}</g>`);
}

function metrics(result: PublicProfileReadResultV1): ReadonlyArray<Readonly<{ metric: PublicProfileAssetMetric; value: number; tokensFromParts: boolean }>> {
    if (result.kind !== 'published') return [];
    const facts = result.view.snapshot.facts;
    return metricFields.flatMap(([metric, field]) => facts[field] === undefined ? [] : [{ metric, value: facts[field], tokensFromParts: metric === 'tokens' && facts.tokensFromParts === true }]);
}

function formatMetric(item: Readonly<{ metric: PublicProfileAssetMetric; value: number; tokensFromParts: boolean }>, labels: PublicProfileAssetLabels): string {
    return `${item.tokensFromParts ? '≥ ' : ''}${labels.formatMetric(item.metric, item.value)}`;
}

function describe(result: PublicProfileReadResultV1, labels: PublicProfileAssetLabels): string {
    if (result.kind === 'unavailable') return `${labels.brand} · ${labels.unavailable}`;
    if (result.kind === 'paused') return `${result.identity.name ?? `@${result.handle}`} · ${labels.paused}`;
    const view = result.view;
    const figures = metrics(result).slice(0, 3).map(item => `${formatMetric(item, labels)} ${labels.metricLabel(item.metric)}`);
    return [view.identity.name ?? `@${view.handle}`, `@${view.handle} · ${view.service.displayName}`,
        ...figures, labels.period(view.snapshot.period), labels.synced(view.snapshot.computedAtMs)].join(' · ');
}

async function renderSummary(result: PublicProfileReadResultV1, options: PublicProfileSvgOptions, palette: PublicProfileAssetPalette, width: number, height: number): Promise<string> {
    const { labels } = options;
    const card = options.kind === 'card';
    // The paused branch and published view have deliberately different DTOs.
    const heading = result.kind === 'published' ? result.view.identity.name ?? `@${result.view.handle}`
        : result.kind === 'paused' ? result.identity.name ?? `@${result.handle}` : labels.brand;
    const identity = result.kind === 'published' ? `@${result.view.handle} · ${result.view.service.displayName}`
        : result.kind === 'paused' ? `@${result.handle}` : '';
    const parts = [await glyph(heading, { x: card ? 24 : width / 2, y: card ? 25 : 145, size: card ? 15 : 64,
        maxWidth: width - (card ? 48 : 96), color: palette.foreground, face: 'semiBold', center: !card })];
    if (identity) parts.push(await glyph(identity, { x: card ? 24 : width / 2, y: card ? 46 : 218,
        size: card ? 12 : 26, maxWidth: width - (card ? 48 : 96), color: palette.secondary, center: !card }));
    if (result.kind !== 'published') {
        parts.push(await glyph(result.kind === 'paused' ? labels.paused : labels.unavailable,
            { x: card ? 24 : width / 2, y: card ? 94 : 295, size: card ? 20 : 30,
                maxWidth: width - 48, color: palette.secondary, center: !card }));
        return parts.join('');
    }
    const figures = metrics(result).slice(0, 3);
    if (card) {
        const column = (width - 48) / 3;
        for (const [index, item] of figures.entries()) {
            parts.push(await glyph(formatMetric(item, labels), { x: 24 + index * column, y: 94,
                size: 20, maxWidth: column - 16, color: palette.foreground, face: 'semiBold' }));
            parts.push(await glyph(labels.metricLabel(item.metric), { x: 24 + index * column, y: 119,
                size: 11, maxWidth: column - 16, color: palette.secondary }));
        }
        parts.push(await glyph([labels.period(result.view.snapshot.period), labels.synced(result.view.snapshot.computedAtMs)].join(' · '),
            { x: 24, y: height - 30, size: 10, maxWidth: width - 48, color: palette.secondary }));
    } else {
        const line = figures.length ? figures.map(item => `${formatMetric(item, labels)} ${labels.metricLabel(item.metric)}`).join(' · ') : labels.empty;
        parts.push(await glyph(line, { x: width / 2, y: 292, size: 30, maxWidth: width - 96, color: palette.foreground, face: 'semiBold', center: true }));
        parts.push(await glyph(labels.period(result.view.snapshot.period), { x: width / 2, y: 342, size: 20, maxWidth: width - 96, color: palette.secondary, center: true }));
        parts.push(await glyph(labels.brand, { x: 48, y: height - 50, size: 20, maxWidth: width - 96, color: palette.foreground, face: 'semiBold' }));
    }
    return parts.join('');
}

async function renderAtmosphere(view: Extract<PublicProfileReadResultV1, { kind: 'published' }>['view'], options: PublicProfileSvgOptions,
    theme: 'light' | 'dark', width: number, height: number): Promise<string> {
    const atmosphere = view.appearance.atmosphere;
    if (atmosphere.source === 'none') return '';
    const limb = options.kind === 'card' ? 150 : 440;
    if (atmosphere.source === 'picture') {
        if (!options.picture) throw new Error('public_profile_picture_unavailable');
        const backdrop = await renderPublicProfileBackdrop({ bytes: options.picture, picture: atmosphere.picture.descriptor,
            layout: atmosphere.picture.layout, width, height, theme, page: options.palette[theme].backgroundRgb, horizonAt: limb / height });
        return image(backdrop.bytes, 0, 0, width, height);
    }
    const pane = { width, height };
    const geometry = horizonPlanetGeometry(pane, { limb });
    const frame = glyphFrame({ view: { w: width, h: height }, dpr: 1, theme, layers: [planetGlyphLayer({ geometry, ...atmosphere.planet })] });
    return renderPublicProfilePlanetSceneSvg(frame, pane);
}

/** Rasterizes one sampled Brand frame for fixed assets and the cold hero. */
export async function renderPublicProfilePlanetSceneSvg(frame: GlyphFrame,
    pane: Readonly<{ width: number; height: number }>, pixelRatio: 1 | 2 = 1): Promise<string> {
    const { width, height } = pane;
    const sharp = await loadSharp();
    const { body, grid, sprites } = frame;
    let disc = '';
    if (body) {
        const texture = await sharp(Buffer.from(body.rgba), { raw: { width: body.cols, height: body.rows, channels: 4 } }).png().toBuffer();
        const { cx, cy, R } = body.disc;
        // A fixed asset can include both theme editions, with a different clip for each edition.
        const clip = `planet-${width}-${height}-${cx}-${cy}-${R}`;
        disc = `<defs><clipPath id="${clip}"><circle cx="${cx / pixelRatio}" cy="${cy / pixelRatio}" r="${R / pixelRatio}"/></clipPath></defs><g clip-path="url(#${clip})">`
            + image(texture, 0, 0, body.cols * grid.cell[0] / pixelRatio, body.rows * grid.cell[1] / pixelRatio) + '</g>';
    }
    if (!sprites.glyph.length) return disc;
    const font = await readPublicProfilePlanetFont();
    const fontSize = Math.round(grid.cell[1] * 0.94);
    const digits = '0123456789';
    const planetFontSize = Math.round(grid.cell[1] * 0.72);
    const rasterize = (characters: string, size: number) => Promise.all(Array.from(characters, text => sharp({ text: {
        text, font: `IBM Plex Mono ${size}`, fontfile: font.path, rgba: true,
    } }).raw().toBuffer({ resolveWithObject: true })));
    const [regular, ramp] = await Promise.all([
        rasterize(digits, fontSize),
        rasterize(glyphRampChars + digits, planetFontSize),
    ]);
    let small: Awaited<ReturnType<typeof rasterize>> | undefined;
    const smallFontSize = Math.round(grid.cell[1] * 0.94 * glyphSmallDigitHeight);
    // The planet's lattice dot, drawn as coverage at its radius.
    const radius = glyphLatticeRadius * frame.width / pane.width, side = Math.ceil(radius * 2 + 2);
    const dot = { data: Buffer.alloc(side * side), info: { width: side, height: side, channels: 1 } };
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        dot.data[y * side + x] = Math.round(255 * Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2))));
    }
    const rgba = Buffer.alloc(frame.width * frame.height * 4);
    for (let index = 0; index < sprites.glyph.length; index++) {
        const tile = sprites.glyph[index];
        const { data, info } = tile === glyphLatticeTile ? dot
            : tile >= glyphRampFirstTile ? ramp[tile - glyphRampFirstTile]
            : tile >= 10 && tile < 20 ? (small ??= await rasterize(digits, smallFontSize))[tile - 10]
            : regular[tile % 10];
        const left = sprites.at[index * 2] - Math.round(info.width / 2);
        const top = sprites.at[index * 2 + 1] - Math.round(info.height / 2);
        const ink = index * 4;
        for (let y = Math.max(0, -top); y < Math.min(info.height, frame.height - top); y++) {
            for (let x = Math.max(0, -left); x < Math.min(info.width, frame.width - left); x++) {
                const at = ((top + y) * frame.width + left + x) * 4;
                // Source-over: a glyph's empty box never erases the lattice dots under it.
                const alpha = data[(y * info.width + x) * info.channels + info.channels - 1] * sprites.rgba[ink + 3] / 65025;
                if (alpha <= 0) continue;
                const under = rgba[at + 3] / 255 * (1 - alpha), total = alpha + under;
                for (let channel = 0; channel < 3; channel++) {
                    rgba[at + channel] = Math.round((sprites.rgba[ink + channel] * alpha + rgba[at + channel] * under) / total);
                }
                rgba[at + 3] = Math.round(total * 255);
            }
        }
    }
    const raster = await sharp(rgba, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer();
    return disc + image(raster, 0, 0, width, height);
}

/** SVG and shields JSON describe the identical currently admitted metric. */
export function publicProfileBadgeMessage(result: PublicProfileReadResultV1, metric: string | undefined, labels: PublicProfileAssetLabels): { message: string; isError: boolean } {
    if (!metricFields.some(([kind]) => kind !== 'active-days' && kind === metric)) return { message: labels.unavailable, isError: true };
    const item = metrics(result).find(item => item.metric !== 'active-days' && item.metric === metric);
    if (result.kind === 'paused') return { message: labels.paused, isError: false };
    return item ? { message: `${formatMetric(item, labels)} ${labels.metricLabel(item.metric)}`, isError: false }
        : { message: labels.unavailable, isError: true };
}

async function renderBadge(result: PublicProfileReadResultV1, options: PublicProfileSvgOptions): Promise<string> {
    const { labels } = options;
    const { message } = publicProfileBadgeMessage(result, options.metric, labels);
    const title = `${labels.brand}: ${message}`;
    const brandSize = await glyphSize(labels.brand, 11, 'semiBold');
    const sizes = await Promise.all([message, labels.paused, labels.unavailable].map(text => glyphSize(text, 11, 'regular')));
    const labelWidth = 24 + brandSize.width + 8;
    const valueWidth = Math.max(...sizes.map(size => size.width)) + 16;
    const width = labelWidth + valueWidth;
    const themes: readonly ('light' | 'dark')[] = options.theme === 'auto' ? ['light', 'dark'] : [options.theme];
    const layers = await Promise.all(themes.map(async theme => {
        const palette = options.palette[theme];
        const cell = createPlanetStatusCell({ kind: 'done', size: 14, theme: theme === 'light' ? 'dark' : 'light' })
            .map(dot => `<circle cx="${dot.x + 6}" cy="${dot.y + 3}" r="${dot.radius}" fill="rgb(${dot.rgb.join(',')})" fill-opacity="${dot.opacity}"/>`).join('');
        return `<g class="edition-${theme}"><rect width="${labelWidth}" height="20" fill="${xml(palette.foreground)}"/><rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${xml(palette.background)}"/>${cell}${await glyph(labels.brand, { x: 24, y: 4, size: 11, maxWidth: brandSize.width, color: palette.background, face: 'semiBold' })}${await glyph(message, { x: labelWidth + 8, y: 4, size: 11, maxWidth: valueWidth - 16, color: palette.foreground })}<rect x=".5" y=".5" width="${width - 1}" height="19" rx="2.5" fill="none" stroke="${xml(palette.border)}"/></g>`;
    }));
    return root(width, 20, title, `${autoThemeStyle(themes.length > 1)}<defs><clipPath id="badge"><rect width="${width}" height="20" rx="3"/></clipPath></defs><g clip-path="url(#badge)">${layers.join('')}</g>`);
}

type FontFace = 'regular' | 'medium' | 'semiBold';
type ShippedFace = keyof typeof PUBLIC_PROFILE_FONT_FAMILIES;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
let registeredFallbacks: Promise<unknown> | undefined;

async function shapeText(text: string, primary: FontFace): Promise<{ markup: string; path: string; family: string }> {
    const sharp = await loadSharp();
    // Native registration is immutable package-asset preparation, not a host
    // font search. The explicit spans below disable system glyph fallback.
    registeredFallbacks ??= Promise.all(([['cjk', '日'], ['arabic', 'م'], ['emoji', '😀']] as const).map(async ([face, sample]) => {
        const font = await readPublicProfileFont(face);
        await sharp({ text: { text: `<span fallback="false">${sample}</span>`, font: `${PUBLIC_PROFILE_FONT_FAMILIES[face]} 1`,
            fontfile: font.path, rgba: true } }).png().toBuffer();
    }));
    await registeredFallbacks;
    const font = await readPublicProfileFont(primary);
    const order: readonly ShippedFace[] = [primary, 'cjk', 'arabic', 'emoji'];
    const runs: { face: ShippedFace; text: string }[] = [];
    for (const { segment } of graphemes.segment(text)) {
        const points = [...segment].filter(char => !/\p{Default_Ignorable_Code_Point}/u.test(char)).map(char => char.codePointAt(0)!);
        const selected = order.find(face => points.every(point => PUBLIC_PROFILE_FONT_COVERAGE[face]
            .some(([first, last]) => point >= first && point <= last))) ?? primary;
        const last = runs.at(-1);
        if (last?.face === selected) last.text += segment;
        else runs.push({ face: selected, text: segment });
    }
    return { path: font.path, family: PUBLIC_PROFILE_FONT_FAMILIES[primary], markup: runs
        .map(run => `<span font_family="${xml(PUBLIC_PROFILE_FONT_FAMILIES[run.face])}" fallback="false">${xml(run.text)}</span>`).join('') };
}

async function glyphSize(text: string, size: number, face: FontFace) {
    const sharp = await loadSharp();
    if (!text.trim()) return { width: 0, height: 0 };
    const shaped = await shapeText(text, face);
    const { info } = await sharp({ text: { text: shaped.markup, font: `${shaped.family} ${size}`, fontfile: shaped.path, dpi: 72, rgba: true } }).png().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height };
}

async function glyph(text: string, box: Readonly<{ x: number; y: number; size: number; maxWidth: number; color: string; face?: FontFace; center?: boolean }>): Promise<string> {
    if (!text.trim()) return '';
    const sharp = await loadSharp();
    const face = box.face ?? 'regular';
    const shaped = await shapeText(text.replace(/\s+/gu, ' '), face);
    // Sharp/Pango fits the entire shaped string directly into this physical
    // canvas; long names do not require an unbounded intermediate or truncation.
    const rendered = await sharp({ text: { text: `<span foreground="${xml(box.color)}">${shaped.markup}</span>`,
        font: `${shaped.family} ${box.size}`, fontfile: shaped.path, rgba: true, wrap: 'none',
        width: Math.max(1, Math.ceil(box.maxWidth)), height: box.size } }).png().toBuffer({ resolveWithObject: true });
    return image(rendered.data, box.center ? box.x - rendered.info.width / 2 : box.x, box.y, rendered.info.width, rendered.info.height);
}

function image(bytes: Buffer, x: number, y: number, width: number, height: number): string {
    return `<image x="${x}" y="${y}" width="${width}" height="${height}" href="data:image/png;base64,${privacyKit.encodeBase64(Uint8Array.from(bytes))}"/>`;
}
function root(width: number, height: number, title: string, body: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${xml(title)}</title><desc id="desc">${xml(title)}</desc>${body}</svg>`;
}
function autoThemeStyle(auto: boolean): string {
    return auto ? '<style>.edition-dark{display:none}@media(prefers-color-scheme:dark){.edition-light{display:none}.edition-dark{display:inline}}</style>' : '';
}
function xml(value: string): string {
    return [...value].filter(char => { const code = char.codePointAt(0)!;
        return code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff;
    }).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
