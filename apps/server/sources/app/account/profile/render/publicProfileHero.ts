import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS, resolveHappierPublicProfilePlanetBand } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { createPlanetScene } from '@happier-dev/brand/planet';
import { homePlanetGeometry, homePlanetSceneOptions } from '@happier-dev/brand/planet-placement';
import { loadSharp } from '@/storage/blob/sharpRuntime';
import { renderPublicProfilePlanetSceneSvg, type PublicProfileAssetPalette } from './publicProfileSvg';
import { renderPublicProfileBackdrop } from './publicProfileBackdrop';

export interface PublicProfileHeroImage {
    mimeType: 'image/png';
    bytes: Buffer;
    width: number;
    height: number;
}
export interface PublicProfileHeroData {
    credit?: string;
    editions: Readonly<Record<'light' | 'dark', Readonly<Record<'wide' | 'phone',
        Readonly<Record<'one' | 'two', Readonly<{ src: string; width: number; height: number }>>>>>>>;
}
export interface PublicProfileHeroOptions {
    picture?: Buffer;
    palette: Readonly<Record<'light' | 'dark', PublicProfileAssetPalette>>;
}

export interface PublicProfileHeroSelection {
    theme: 'light' | 'dark';
    viewport: 'wide' | 'phone';
    density: 1 | 2;
}

/** Cold HTML references the same admitted physical editions without embedding their pixels. */
export function createPublicProfileHero(view: PublicProfileViewV1): PublicProfileHeroData | undefined {
    const atmosphere = view.appearance.atmosphere;
    if (atmosphere.source === 'none') return undefined;
    const image = (theme: 'light' | 'dark', viewport: 'wide' | 'phone', density: 1 | 2) => {
        const url = new URL(`${view.urls.page}/background`);
        url.search = new URLSearchParams({ theme, viewport, density: String(density) }).toString();
        return { src: `${url.pathname}${url.search}`, width: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx[viewport] * density,
            height: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx[viewport] * density };
    };
    const edition = (theme: 'light' | 'dark', viewport: 'wide' | 'phone') => ({
        one: image(theme, viewport, 1), two: image(theme, viewport, 2),
    });
    const credit = atmosphere.source === 'picture' ? atmosphere.picture.descriptor.credit : null;
    return { ...(credit ? { credit: `${credit.author} · ${credit.source}` } : {}), editions: {
        light: { wide: edition('light', 'wide'), phone: edition('light', 'phone') },
        dark: { wide: edition('dark', 'wide'), phone: edition('dark', 'phone') },
    } };
}

/** Paint only the requested edition of the current already-filtered, applied atmosphere. */
export async function renderPublicProfileHeroImage(view: PublicProfileViewV1, options: PublicProfileHeroOptions,
    selection: PublicProfileHeroSelection): Promise<PublicProfileHeroImage | undefined> {
    const atmosphere = view.appearance.atmosphere;
    if (atmosphere.source === 'none') return undefined;
    if (atmosphere.source === 'picture' && !options.picture) throw new Error('public_profile_picture_unavailable');
    const { theme, viewport, density: ratio } = selection;
    const pane = { width: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx[viewport],
        height: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx[viewport] };
    const width = pane.width * ratio;
    const height = pane.height * ratio;
    let bytes: Buffer;
    if (atmosphere.source === 'picture') {
        // Match AtmospherePreview frame="band": the applied backdrop fills
        // the band; shell-only WallpaperHaze geometry is not invented here.
        bytes = (await renderPublicProfileBackdrop({ bytes: options.picture!, picture: atmosphere.picture.descriptor,
            layout: atmosphere.picture.layout, width, height, dpr: ratio, theme, page: options.palette[theme].backgroundRgb,
            horizonAt: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.horizonAt })).bytes;
    } else {
        // Match AtmospherePreview's band geometry and the real canvas' device-pixel scene input.
        const scene = createPlanetScene({ ...homePlanetSceneOptions(homePlanetGeometry(atmosphere.planet.placement, pane, resolveHappierPublicProfilePlanetBand(pane)), pane,
            { theme, style: atmosphere.planet.style, digits: atmosphere.planet.digits }), dpr: ratio });
        const paint = await renderPublicProfilePlanetSceneSvg(scene, pane, ratio);
        const sharp = await loadSharp();
        bytes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${pane.width} ${pane.height}">${paint}</svg>`))
            .flatten({ background: options.palette[theme].background }).ensureAlpha().png().toBuffer();
    }
    return { mimeType: 'image/png', bytes, width, height };
}
