import { describe, expect, it } from 'vitest';
import { HAPPIER_DEFAULT_SURFACE_COLORS } from '@happier-dev/plugin-ui/environment';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import * as privacyKit from 'privacy-kit';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { createPublicProfileHero, renderPublicProfileHeroImage, type PublicProfileHeroOptions } from './publicProfileHero';
import { renderPublicProfileBackdrop } from './publicProfileBackdrop';
import { renderPublicProfilePlanetSceneSvg } from './publicProfileSvg';
import { glyphFrame, planetGlyphLayer, travellerGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { resolveHappierPublicProfilePlanetBand } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { readStoredPublicProfileAppearance } from '../publicProfileStorage';
import { renderPublicProfileHtml } from './publicProfileHtml';

const paletteOf = (theme: 'light' | 'dark'): PublicProfileHeroOptions['palette']['light'] => {
    const colors = HAPPIER_DEFAULT_SURFACE_COLORS[theme];
    return { ...colors, backgroundRgb: [1, 3, 5].map(offset => parseInt(colors.background.slice(offset, offset + 2), 16)) as [number, number, number] };
};
const palette: PublicProfileHeroOptions['palette'] = { light: paletteOf('light'), dark: paletteOf('dark') };
// These assertions name the approved cold-render contract, independently of its producer.
const expectedMetrics = { rasterWidthPx: { wide: 1440, phone: 390 }, bandHeightPx: { wide: 420, phone: 300 }, horizonAt: 0.6 };
function profile() {
    const view = projectPublicProfile({ context: { handle: 'nadia', identity: { name: 'Nadia' },
        service: { displayName: 'Home', publicBaseUrl: 'https://home.example' },
        urls: { page: 'https://home.example/@nadia', json: 'https://home.example/v1/public/profiles/nadia',
            badgeBase: 'https://home.example/@nadia/badge', card: 'https://home.example/@nadia/card.svg',
            og: 'https://home.example/@nadia/og.png', report: 'mailto:operator@example.test' } },
        policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, layout: { v: 1, items: [] },
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        snapshot: PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 2,
            period: { startMs: 1, endMs: 2, timeZoneOffsetMinutes: 0 }, coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} }) });
    if (!view) throw new Error('Expected admitted profile');
    return view;
}
async function paintHero(view: ReturnType<typeof profile>, options: PublicProfileHeroOptions) {
    const sources = createPublicProfileHero(view);
    if (!sources) return undefined;
    const edition = async (theme: 'light' | 'dark', viewport: 'wide' | 'phone') => {
        const image = async (density: 1 | 2) => {
            const painted = await renderPublicProfileHeroImage(view, options, { theme, viewport, density });
            if (!painted) throw new Error('Expected painted edition');
            return { mimeType: painted.mimeType, width: painted.width, height: painted.height, base64: privacyKit.encodeBase64(Uint8Array.from(painted.bytes)) };
        };
        return { one: await image(1), two: await image(2) };
    };
    return { credit: sources.credit, editions: {
        light: { wide: await edition('light', 'wide'), phone: await edition('light', 'phone') },
        dark: { wide: await edition('dark', 'wide'), phone: await edition('dark', 'phone') },
    } };
}
function reportCost(source: 'planet' | 'horizon', started: number, rss: number,
    hero: Awaited<ReturnType<typeof paintHero>>) {
    if (!hero) throw new Error('Expected painted hero');
    const pngBytes = Object.values(hero.editions).flatMap(theme => Object.values(theme))
        .flatMap(viewport => Object.values(viewport)).reduce((sum, image) => sum + privacyKit.decodeBase64(image.base64).length, 0);
    console.info('public-profile-hero-cost', { source, elapsedMs: Math.round(performance.now() - started), pngBytes,
        rssDeltaBytesNotPeak: process.memoryUsage().rss - rss });
}

describe('cold public-profile hero pixels', () => {
    it('keeps every band edition on the visitor origin, including a prefixed Home served over LAN', () => {
        const view = profile();
        view.urls.page = 'https://home.example/prefix/@nadia';
        const hero = createPublicProfileHero(view);
        expect(hero).toBeDefined();
        for (const [theme, viewports] of Object.entries(hero!.editions)) {
            for (const [viewport, densities] of Object.entries(viewports)) {
                for (const [edition, image] of Object.entries(densities)) {
                    const density = edition === 'one' ? 1 : 2;
                    expect(image.src).toBe(`/prefix/@nadia/background?theme=${theme}&viewport=${viewport}&density=${density}`);
                    expect(new URL(image.src, 'http://192.168.1.10:3011').origin).toBe('http://192.168.1.10:3011');
                }
            }
        }
        const html = renderPublicProfileHtml({ kind: 'published', view }, hero);
        expect(html).toContain('src="/prefix/@nadia/background?theme=');
        expect(html).toContain('srcSet="/prefix/@nadia/background?theme=');
        expect(html).not.toContain('src="https://home.example');
        expect(html).not.toContain('srcSet="https://home.example');
    });
    it('keeps a 90-day cold page proportional to its markup while painting the selected halftone picture', async () => {
        const sharp = await loadSharp();
        const view = profile();
        const startMs = Date.UTC(2026, 6, 26);
        view.snapshot.period = { startMs, endMs: startMs + 90 * 86400000, timeZoneOffsetMinutes: 0 };
        view.snapshot.facts = { calendar: Array.from({ length: 90 }, (_, day) => ({
            date: new Date(startMs + day * 86400000).toISOString().slice(0, 10), level: day === 89 ? 4 : null,
        })), activeDays: 1, agentMix: [{ agentId: 'codex', share: 1, coverage: { status: 'partial', method: 'runtime' } }] };
        view.layout = { v: 1, items: [
            { kind: 'widget', id: 'days', size: 'full', frameStyle: 'plain', title: 'Sky of days',
                presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } },
            { kind: 'widget', id: 'crew', size: 'medium', frameStyle: 'plain', title: 'Crew',
                presentation: { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'crew' } } },
            { kind: 'widget', id: 'planet', size: 'medium', frameStyle: 'plain', title: 'Your planet',
                presentation: { kind: 'usage', widgetId: 'usage_planet', inputs: {} } },
        ] };
        const descriptor = { kind: 'photo' as const, title: 'Reviewed daybreak', credit: null,
            focus: { x: 0.5, zoom: 1.15 }, horizon: { src: 0.47, at: 0.62 }, hour: 6.8,
            grades: { light: 7, dusk: 18.9, night: 22 }, dark: 'dusk' as const, adaptiveHaze: false,
            look: { effect: 'halftone' as const, params: { cell: 4.5, angle: 45, gain: 1.05, wash: 0.22, strength: 1 },
                strength: 1, dissolve: { style: 'ordered' as const, from: 0.58, to: 1 } } };
        view.appearance = { theme: 'auto', atmosphere: { source: 'picture', picture: {
            ref: { kind: 'publication', id: 'reviewed-daybreak' }, layout: 'horizon', descriptor,
        } } };
        const picture = await sharp({ create: { width: 96, height: 48, channels: 4, background: '#e5a38d' } })
            .composite([{ input: { create: { width: 48, height: 48, channels: 4, background: '#749bb6' } }, left: 48, top: 0 }])
            .png().toBuffer();
        const result = { kind: 'published', view } as const;
        const hero = createPublicProfileHero(view);
        const html = renderPublicProfileHtml(result, hero);
        // Same content/theme without a hero has one viewport tree. Two viewport
        // trees may at most double that entire document (including shell/CSS).
        // Add the actual background URL bytes for src plus both srcset entries.
        // This is a content-derived regression budget, never a production cap.
        const selectors = ['light', 'dark'].flatMap(theme => ['wide', 'phone'].flatMap(viewport => [1, 2].map(density =>
            `${view.urls.page}/background?theme=${theme}&viewport=${viewport}&density=${density}`)));
        const budget = 2 * Buffer.byteLength(renderPublicProfileHtml(result)) + 3 * Buffer.byteLength(selectors.join(''));
        expect(Buffer.byteLength(html)).toBeLessThanOrEqual(budget);
        expect(html).not.toMatch(/<script\b|data:image\/png;base64/);
        expect(html).toContain('public-profile-hero-band');
        expect(html).toContain(`${new URL(view.urls.page).pathname}/background?theme=`);
        const painted = await renderPublicProfileHeroImage(view, { palette, picture }, { theme: 'light', viewport: 'phone', density: 2 });
        const expected = await renderPublicProfileBackdrop({ bytes: picture, picture: descriptor, layout: 'horizon', theme: 'light',
            width: 780, height: 600, dpr: 2, page: palette.light.backgroundRgb, horizonAt: expectedMetrics.horizonAt });
        expect(painted?.bytes).toEqual(expected.bytes);
        console.info('public-profile-cold-html-size', { htmlBytes: Buffer.byteLength(html), budget });
    });
    it('paints the shared wide/phone band in both themes and densities, and preserves None', async () => {
        const sharp = await loadSharp();
        const view = profile();
        view.appearance = readStoredPublicProfileAppearance(JSON.stringify({ theme: 'auto',
            atmosphere: { source: 'planet', planet: { placement: 'side', style: 'airy', digits: true } },
        }))!;
        expect(view.appearance.atmosphere).toEqual({ source: 'planet', planet: { intensity: 'quiet', digits: true } });
        const started = performance.now();
        const rss = process.memoryUsage().rss;
        const hero = await paintHero(view, { palette });
        reportCost('planet', started, rss, hero);
        expect(hero).toBeDefined();
        for (const theme of ['light', 'dark'] as const) for (const viewport of ['wide', 'phone'] as const) {
            for (const [density, ratio] of [['one', 1], ['two', 2]] as const) {
                const image = hero!.editions[theme][viewport][density];
                const width = expectedMetrics.rasterWidthPx[viewport] * ratio;
                const height = expectedMetrics.bandHeightPx[viewport] * ratio;
                expect(image).toMatchObject({ mimeType: 'image/png', width, height });
                expect(await sharp(Buffer.from(privacyKit.decodeBase64(image.base64))).metadata()).toMatchObject({ width, height });
            }
        }
        const pane = { width: expectedMetrics.rasterWidthPx.phone, height: expectedMetrics.bandHeightPx.phone };
        const geometry = horizonPlanetGeometry(pane, resolveHappierPublicProfilePlanetBand(pane));
        const frame = glyphFrame({ view: { w: pane.width, h: pane.height }, dpr: 2, theme: 'dark',
            layers: [planetGlyphLayer({ geometry, intensity: 'quiet', digits: true })] });
        const paint = await renderPublicProfilePlanetSceneSvg(frame, pane, 2);
        const expected = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="780" height="600" viewBox="0 0 390 300">${paint}</svg>`))
            .flatten({ background: palette.dark.background }).ensureAlpha().png().toBuffer();
        expect(Buffer.from(privacyKit.decodeBase64(hero!.editions.dark.phone.two.base64))).toEqual(expected);
        view.appearance.atmosphere = { source: 'none' };
        expect(createPublicProfileHero(view)).toBeUndefined();
        expect(await renderPublicProfileHeroImage(view, { palette }, { theme: 'light', viewport: 'wide', density: 1 })).toBeUndefined();
    });

    it('keeps small floating digits at their own size in a static frame', async () => {
        const sharp = await loadSharp();
        const pane = { width: 64, height: 64 };
        const particles = new Float32Array([32, 32, 32, 32, 0, 0, 0, 0]);
        const inkRows = async (small: boolean) => {
            const layer = travellerGlyphLayer({ particles, small, ink: 'sunrise' });
            const frame = glyphFrame({ view: { w: pane.width, h: pane.height }, dpr: 1, theme: 'dark', layers: [layer] });
            const paint = await renderPublicProfilePlanetSceneSvg(frame, pane);
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${paint}</svg>`;
            const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            let rows = 0;
            for (let y = 0; y < info.height; y++) {
                const row = data.subarray(y * info.width * 4, (y + 1) * info.width * 4);
                if (row.some((value, at) => at % 4 === 3 && value > 0)) rows++;
            }
            return rows;
        };
        const [regular, small] = await Promise.all([inkRows(false), inkRows(true)]);
        expect(small).toBeGreaterThan(0);
        expect(small).toBeLessThan(regular);
    });

    it('uses the selected Horizon Look at the shared horizon and retains only frozen credit', async () => {
        const sharp = await loadSharp();
        const bytes = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#a94a26' } }).png().toBuffer();
        const view = profile();
        const descriptor = { kind: 'photo' as const, title: 'Reviewed coast', credit: { author: 'Nadia', source: 'Own collection', licence: 'CC0' },
            adaptiveHaze: false, focus: { x: 0.63, y: 0.4 }, horizon: {}, hour: 0.4,
            grades: { light: 0.4, dusk: 0.6, night: 0.8 }, dark: 'night' as const,
            look: { effect: 'halftone' as const, params: {}, strength: 1, dissolve: { style: 'gradient' as const, from: 0.58, to: 1 } } };
        view.appearance.atmosphere = { source: 'picture', picture: { ref: { kind: 'publication', id: 'admitted-image' }, layout: 'horizon', descriptor } };
        await expect(paintHero(view, { palette })).rejects.toThrow('public_profile_picture_unavailable');
        const started = performance.now();
        const rss = process.memoryUsage().rss;
        const hero = await paintHero(view, { palette, picture: bytes });
        reportCost('horizon', started, rss, hero);
        expect(hero?.credit).toBe('Nadia · Own collection');
        for (const [density, dpr] of [['one', 1], ['two', 2]] as const) {
            const expected = await renderPublicProfileBackdrop({ bytes, picture: descriptor, layout: 'horizon', theme: 'light',
                width: expectedMetrics.rasterWidthPx.phone * dpr, height: expectedMetrics.bandHeightPx.phone * dpr, dpr,
                horizonAt: expectedMetrics.horizonAt, page: palette.light.backgroundRgb });
            expect(Buffer.from(privacyKit.decodeBase64(hero!.editions.light.phone[density].base64))).toEqual(expected.bytes);
        }
    });

    it('paints Wallpaper through the existing full-band Look without inventing a haze overlay', async () => {
        const sharp = await loadSharp();
        const bytes = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#a94a26' } })
            .composite([{ input: { create: { width: 40, height: 60, channels: 4, background: '#4074a3' } }, left: 40, top: 0 }])
            .png().toBuffer();
        const view = profile();
        const descriptor = { kind: 'photo' as const, title: 'Reviewed Wallpaper', credit: null,
            adaptiveHaze: true, focus: { x: 0.63, y: 0.4, zoom: 1.3 }, horizon: { src: 0.62 }, hour: 0.4,
            grades: { light: 0.8, dusk: 0.6, night: 0.8 }, dark: 'night' as const,
            look: { effect: 'mosaic' as const, params: {}, strength: 1,
                dissolve: { style: 'ordered' as const, from: 0.58, to: 1 } } };
        view.appearance.atmosphere = { source: 'picture', picture: { ref: { kind: 'publication', id: 'admitted-image' }, layout: 'wallpaper', descriptor } };
        const hero = await paintHero(view, { palette, picture: bytes });
        expect(hero?.credit).toBeUndefined();
        for (const theme of ['light', 'dark'] as const) for (const [density, dpr] of [['one', 1], ['two', 2]] as const) {
            const expected = await renderPublicProfileBackdrop({ bytes, picture: descriptor, layout: 'wallpaper', theme,
                width: expectedMetrics.rasterWidthPx.phone * dpr, height: expectedMetrics.bandHeightPx.phone * dpr, dpr,
                horizonAt: expectedMetrics.horizonAt, page: palette[theme].backgroundRgb });
            expect(Buffer.from(privacyKit.decodeBase64(hero!.editions[theme].phone[density].base64)).equals(expected.bytes)).toBe(true);
        }
    });
});
