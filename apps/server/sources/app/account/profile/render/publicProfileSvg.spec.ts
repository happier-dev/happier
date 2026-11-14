import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { publicProfileBadgeMessage, renderPublicProfileSvg, type PublicProfileSvgOptions } from './publicProfileSvg';
import { renderPublicProfileOg } from './publicProfileOg';
import { readPublicProfileFont } from './publicProfileFonts';
import * as privacyKit from 'privacy-kit';

const options: Omit<PublicProfileSvgOptions, 'kind'> = {
    theme: 'light',
    labels: { brand: 'Happier', paused: 'Paused', unavailable: 'Unavailable', empty: 'Public profile',
        period: () => '1–30 September 2026 · UTC+02:00', synced: () => 'Synced 30 September 2026',
        metricLabel: metric => ({ tokens: 'tokens', 'active-days': 'active days', streak: 'streak',
            'agent-time': 'agent time', 'merged-prs': 'merged PRs', 'peak-parallel': 'peak parallel' })[metric],
        formatMetric: (_metric, value) => String(value) },
    palette: {
        light: { background: '#ffffff', foreground: '#222222', secondary: '#6c6c70', border: '#dddddd', backgroundRgb: [255, 255, 255] },
        dark: { background: '#141212', foreground: '#efefef', secondary: '#9a918c', border: '#333333', backgroundRgb: [20, 18, 18] },
    },
};
function published(tokens = true, name = 'Nadia Müller', tokensFromParts = false): PublicProfileReadResultV1 {
    const context = { handle: 'nadia', identity: { name }, service: { displayName: 'My Home', publicBaseUrl: 'https://profiles.example/prefix' },
        urls: { page: 'https://profiles.example/prefix/@nadia', json: 'https://profiles.example/prefix/v1/public/profiles/nadia',
            badgeBase: 'https://profiles.example/prefix/@nadia/badge', card: 'https://profiles.example/prefix/@nadia/card.svg',
            og: 'https://profiles.example/prefix/@nadia/og.png', report: 'mailto:operator@example.test' } };
    const view = projectPublicProfile({ context, policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
        fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens } }, metadata: {}, layout: { v: 1, items: [] },
        appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        snapshot: PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 2000,
            period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 120 }, coverage: { status: 'partial', method: 'runtime' },
            fieldCoverage: {}, facts: { tokens: 987654321, ...(tokensFromParts ? { tokensFromParts: true } : {}), activeDays: 17, currentStreakDays: 6 } }) });
    if (!view) throw new Error('Expected admitted fixture');
    return { kind: 'published', view };
}

describe('fixed public profile assets', () => {
    it('marks disclosed token floors in badge messages and accessible card figures', async () => {
        const floor = published(true, 'Nadia Müller', true);
        expect(publicProfileBadgeMessage(floor, 'tokens', options.labels))
            .toEqual({ message: '≥ 987654321 tokens', isError: false });
        expect(await renderPublicProfileSvg(floor, { ...options, kind: 'card' })).toContain('≥ 987654321 tokens');
        expect(publicProfileBadgeMessage(published(false, 'Nadia Müller', true), 'tokens', options.labels))
            .toEqual({ message: 'Unavailable', isError: true });
    });

    it('renders a self-contained K1 from the actual projector with measured shipped-face glyph pixels', async () => {
        const sharp = await loadSharp();
        const svg = await renderPublicProfileSvg(published(), { ...options, kind: 'card' });
        expect(svg).toContain('width="495" height="195"');
        expect(svg).toContain('role="img"');
        expect(svg).toContain('Nadia Müller');
        expect(svg).toContain('987654321');
        expect(svg).toContain('data:image/png;base64,');
        expect(svg).not.toMatch(/<text\b|<foreignObject\b|https?:\/\/[^"<]*\.ttf/);
        expect((await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true })).info).toMatchObject({ width: 495, height: 195 });
    });

    it('drops hidden numbers from SVG accessibility and makes hidden/unknown badges indistinguishable', async () => {
        const safe = published(false);
        const hidden = await renderPublicProfileSvg(safe, { ...options, kind: 'badge', metric: 'tokens' });
        const unavailable = await renderPublicProfileSvg({ kind: 'unavailable' }, { ...options, kind: 'badge', metric: 'tokens' });
        expect(hidden).toBe(unavailable);
        expect(hidden).toContain('Unavailable');
        expect(await renderPublicProfileSvg(safe, { ...options, kind: 'card' })).not.toContain('987654321');
    });

    it('keeps an unknown badge kind generic even for a paused profile and does not add card-only metrics', () => {
        const paused = { kind: 'paused', handle: 'nadia', identity: { name: 'Nadia Müller' } } as const;
        for (const metric of ['private-machine', 'active-days']) {
            expect(publicProfileBadgeMessage(paused, metric, options.labels)).toEqual({ message: 'Unavailable', isError: true });
            expect(publicProfileBadgeMessage(published(), metric, options.labels)).toEqual({ message: 'Unavailable', isError: true });
        }
        expect(publicProfileBadgeMessage(paused, 'tokens', options.labels)).toEqual({ message: 'Paused', isError: false });
    });

    it('keeps complete long Unicode and markup-bearing names without executable SVG or character truncation', async () => {
        const name = 'Élodie Müller — ' + 'Wim '.repeat(40) + '<script>alert("private")</script> & friends';
        const svg = await renderPublicProfileSvg(published(false, name), { ...options, kind: 'card' });
        expect(svg).toContain('&lt;script&gt;alert(&quot;private&quot;)&lt;/script&gt; &amp; friends');
        expect(svg).not.toContain('<script>');
        expect(svg).not.toContain('…');
        const sharp = await loadSharp();
        expect((await sharp(Buffer.from(svg)).metadata()).width).toBe(495);
    });

    it('paints Japanese, shaped Arabic and composed emoji with the explicitly shipped fallback face, not host fonts', async () => {
        const sharp = await loadSharp();
        for (const [name, face, family] of [
            ['日本語', 'cjk', 'Noto Sans CJK SC'], ['مرحبا', 'arabic', 'Noto Sans Arabic'], ['👩🏽‍💻', 'emoji', 'Noto Emoji'],
        ] as const) {
            const svg = await renderPublicProfileSvg(published(false, name), { ...options, kind: 'card' });
            const firstImage = svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
            expect(firstImage, name).not.toBeNull();
            const actual = Buffer.from(privacyKit.decodeBase64(firstImage![1]!));
            const font = await readPublicProfileFont(face);
            const expected = await sharp({ text: {
                text: `<span foreground="${options.palette.light.foreground}" font_family="${family}" fallback="false">${name}</span>`,
                font: 'Inter SemiBold 15', fontfile: font.path, rgba: true, wrap: 'none', width: 447, height: 15,
            } }).png().toBuffer();
            expect(actual, name).toEqual(expected);
        }
    });

    it('renders identity-only paused and generic unavailable canvases without aggregates', async () => {
        const sharp = await loadSharp();
        for (const result of [{ kind: 'paused', handle: 'nadia', identity: { name: 'Nadia Müller' } }, { kind: 'unavailable' }] as const) {
            for (const kind of ['badge', 'card', 'og'] as const) {
                const svg = await renderPublicProfileSvg(result, { ...options, kind, metric: 'tokens' });
                expect(svg).not.toContain('987654321');
                expect(svg).not.toContain('September');
                expect((await sharp(Buffer.from(svg)).metadata()).height).toBe(kind === 'badge' ? 20 : kind === 'card' ? 195 : 630);
            }
        }
    });

    it('measures proportional badge labels and exposes automatic light/dark editions without changing their canvas', async () => {
        const narrow = await renderPublicProfileSvg(published(), { ...options, kind: 'badge', metric: 'tokens',
            labels: { ...options.labels, brand: 'iiii' } });
        const wide = await renderPublicProfileSvg(published(), { ...options, kind: 'badge', metric: 'tokens',
            labels: { ...options.labels, brand: 'MMMM' } });
        const width = (svg: string) => Number(svg.match(/width="([\d.]+)"/)?.[1]);
        expect(width(wide)).toBeGreaterThan(width(narrow));
        const automatic = await renderPublicProfileSvg(published(false), { ...options, kind: 'card', theme: 'auto' });
        expect(automatic).toContain('@media(prefers-color-scheme:dark)');
        expect(automatic).toContain('edition-light');
        expect(automatic).toContain('edition-dark');
        expect((await (await loadSharp())(Buffer.from(automatic)).metadata())).toMatchObject({ width: 495, height: 195 });
    });

    it('respects none and the exact current picture instead of silently substituting a planet', async () => {
        const result = published(false);
        if (result.kind !== 'published') throw new Error('Expected admitted fixture');
        result.view.appearance.atmosphere = { source: 'none' };
        const none = await renderPublicProfileSvg(result, { ...options, kind: 'card' });
        expect(none).not.toContain('<circle');
        const sharp = await loadSharp();
        const picture = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#aa4411' } }).png().toBuffer();
        result.view.appearance.atmosphere = { source: 'picture', picture: { layout: 'horizon', ref: { kind: 'publication', id: 'current-only' },
            descriptor: { kind: 'photo', title: 'Selected sunset', credit: null, adaptiveHaze: false,
                focus: { x: 0.5, y: 0.5 }, horizon: {}, hour: 0.42, grades: { light: 0.42, dusk: 0.65, night: 0.81 }, dark: 'night',
                look: { effect: 'original', params: {}, strength: 1, dissolve: { style: 'gradient', from: 0.58, to: 1 } } } } };
        await expect(renderPublicProfileSvg(result, { ...options, kind: 'card' })).rejects.toThrow('public_profile_picture_unavailable');
        const selected = await renderPublicProfileSvg(result, { ...options, kind: 'card', picture });
        expect(selected).not.toContain('<circle');
        expect(await sharp(Buffer.from(selected)).raw().toBuffer()).not.toEqual(await sharp(Buffer.from(none)).raw().toBuffer());
    });

    it('rasterizes the same fixed-dark G1 into real PNG pixels, independent of SVG theme selection', async () => {
        const sharp = await loadSharp();
        const result = published(false);
        const expected = await sharp(Buffer.from(await renderPublicProfileSvg(result, { ...options, kind: 'og', theme: 'dark' }))).png().toBuffer();
        const bytes = await renderPublicProfileOg(result, options);
        expect(bytes).toEqual(expected);
        const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(decoded.info).toMatchObject({ width: 1200, height: 630, channels: 4 });
        expect(new Set(decoded.data).size).toBeGreaterThan(30);
        expect(Array.from(decoded.data.subarray(0, 4))).toEqual([20, 18, 18, 255]);
    });
});
