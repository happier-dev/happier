import { type ViewStyle } from 'react-native';
import type { CSSProperties } from 'react';
import type { NewSessionBackdropStrengthV1 } from '@happier-dev/protocol/account/settings/accountSettings';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';

import { SCRIM_RAMP_UNDERLAP, scrimBandRamp, scrimBlurLayers, scrimHeldRamp, scrimRamp, type ScrimRamp } from './progressiveScrimFalloff';

export function createBackdropWebStyle(params: Readonly<{
    backgroundColor: string;
    blurPx?: number;
    enableBlur?: boolean;
    fallbackBackgroundColorWhenBlurDisabled?: string;
    surfaceGroup?: GlassSurfaceGroup;
    /** Static tone resolved by the material owner; scrims do not acquire it implicitly. */
    backdropTone?: string;
}>): CSSProperties {
    if (params.enableBlur === false) {
        return {
            backgroundColor: params.fallbackBackgroundColorWhenBlurDisabled ?? params.backgroundColor,
        };
    }

    const blurPx = typeof params.blurPx === 'number' ? params.blurPx : 12;
    // A material surface takes its group's live blur. A scrim (no group) keeps its own radius and only
    // follows floating glass being switched off: the strong floating blur belongs to the popover, and
    // a scrim inheriting it would blur the whole page behind every menu and dialog.
    const radius = params.surfaceGroup
        ? `var(--happier-glass-${params.surfaceGroup}-blur, ${blurPx}px)`
        : `min(var(--happier-glass-floating-blur, ${blurPx}px), ${blurPx}px)`;
    const filter = [`blur(${radius})`, params.backdropTone].filter(Boolean).join(' ');
    return {
        WebkitBackdropFilter: filter,
        backdropFilter: filter,
        backgroundColor: params.backgroundColor,
    };
}

/**
 * The floating New Session backdrop's strengths (owner, 2026-10-29: the frost was too low; show the
 * picture softly in it as well). One token selects the whole set:
 * - `veilShare`: the share of the wizard veil the frost keeps;
 * - `blurPx`: the page's blur (a scrim radius: capped by the floating glass blur and off with it);
 * - `picture`: the soft picture laid over the frost (opacity, its own blur, how far it is scaled so the
 *   blurred edge stays off screen);
 * - `glow`: the opacity of the planet-colour glow that stands in for the picture when Planet is the source.
 */
export const FLOATING_BACKDROP_STRENGTHS = {
    subtle: { veilShare: 0.7, blurPx: 6, picture: { opacity: 0.2, blurPx: 24, scale: 1.08 }, glow: 0.55 },
    soft: { veilShare: 0.75, blurPx: 9, picture: { opacity: 0.25, blurPx: 28, scale: 1.09 }, glow: 0.65 },
    medium: { veilShare: 0.8, blurPx: 12, picture: { opacity: 0.3, blurPx: 32, scale: 1.1 }, glow: 0.75 },
    rich: { veilShare: 0.88, blurPx: 20, picture: { opacity: 0.42, blurPx: 40, scale: 1.12 }, glow: 1 },
} as const satisfies Record<NewSessionBackdropStrengthV1, unknown>;
export type FloatingBackdropStrength = NewSessionBackdropStrengthV1;
/** The default strength (owner, 2026-10-31). */
export const FLOATING_BACKDROP_STRENGTH: FloatingBackdropStrength = 'soft';

type BackdropOverlayColors = Readonly<{ scrim: string; scrimWizard?: string; scrimStrong?: string }>;

/** The floating frost's veil at a strength: most of the wizard veil, or all of it once there is no blur to carry it. */
function floatingVeil(overlay: BackdropOverlayColors, strength: FloatingBackdropStrength, blurred: boolean): string {
    const veil = overlay.scrimWizard ?? overlay.scrim;
    return blurred ? `color-mix(in srgb, ${veil} ${FLOATING_BACKDROP_STRENGTHS[strength].veilShare * 100}%, transparent)` : veil;
}

/**
 * The modal scrim behind a dialog or a floating route (BaseModal, the floating New Session
 * composer): the wizard scrim under a light frost, or the strong scrim when blur is off.
 */
export function createModalScrimWebStyle(params: Readonly<{
    overlay: BackdropOverlayColors;
    enableBlur: boolean;
    /** False while the scrim is leaving: it clears to transparent. */
    visible?: boolean;
    /**
     * `scrim` (default): a light frost behind a card. `floating`: content sits directly on the scrim
     * (no card, the New Session composer): the page behind takes the floating glass blur at the selected
     * strength under most of the wizard veil, and `createFloatingBackdropPictureWebStyle` lays the picture
     * softly over it.
     */
    frost?: 'scrim' | 'floating';
    strength?: FloatingBackdropStrength;
}>): CSSProperties {
    const visible = params.visible !== false;
    const veil = params.overlay.scrimWizard ?? params.overlay.scrim;
    const floating = params.frost === 'floating';
    const strength = params.strength ?? FLOATING_BACKDROP_STRENGTH;
    const backdrop = FLOATING_BACKDROP_STRENGTHS[strength];
    return createBackdropWebStyle({
        backgroundColor: !visible ? 'transparent' : floating ? floatingVeil(params.overlay, strength, true) : veil,
        blurPx: !visible ? 0 : floating ? backdrop.blurPx : 2,
        enableBlur: params.enableBlur && visible,
        // Without blur the floating composer keeps the plain wizard veil, never the strong one.
        fallbackBackgroundColorWhenBlurDisabled: !visible ? 'transparent' : floating ? veil
            : (params.overlay.scrimStrong ?? params.overlay.scrim),
    });
}

/**
 * `top`: the band clears upward, across the window (a phone). `centre`: upward and to both sides, so it pools
 * under a surface centred on the page.
 */
export type ScrimBandAxes = 'top' | 'centre';

/** One axis of a band's mask: clear at the far edge, at full strength `rampPx` in. */
function scrimBandMaskAxis(direction: string, rampPx: number, ramp: ScrimRamp): string {
    const stops = ramp.locations.map((location, index) => `rgba(0,0,0,${ramp.alphas[index]!.toFixed(3)}) ${((1 - location) * rampPx).toFixed(1)}px`);
    return `linear-gradient(${direction}, ${stops.reverse().join(', ')})`;
}

/** Both side edges of a band clear, mirrored: the leading ramp of `scrimBandMaskAxis` and its reflection. */
function scrimBandMaskSides(rampPx: number, ramp: ScrimRamp): string {
    const stop = (index: number, offset: string) => `rgba(0,0,0,${ramp.alphas[index]!.toFixed(3)}) ${offset}`;
    const leading = ramp.locations.map((location, index) => stop(index, `${((1 - location) * rampPx).toFixed(1)}px`)).reverse();
    const trailing = ramp.locations.map((location, index) => stop(index, `calc(100% - ${((1 - location) * rampPx).toFixed(1)}px)`));
    return `linear-gradient(to right, ${[...leading, ...trailing].join(', ')})`;
}

function scrimBandMask(rampPx: number, axes: ScrimBandAxes, ramp: ScrimRamp, sidePx: number = rampPx): CSSProperties {
    const vertical = scrimBandMaskAxis('to bottom', rampPx, ramp);
    if (axes === 'top') return { WebkitMaskImage: vertical, maskImage: vertical };
    // Sideways the band only dissolves, across the room beside the surface: it is whole at the surface's edges,
    // where the rows it holds behind end.
    const both = `${vertical}, ${scrimBandMaskSides(sidePx, scrimRamp())}`;
    return { WebkitMaskImage: both, maskImage: both, WebkitMaskComposite: 'source-in', maskComposite: 'intersect' };
}

/**
 * The web band: `OverlayScrim`'s recipe (one falloff, a blur stack of constant radii, each masked to its
 * own band) in CSS, at a floating backdrop strength. Solid glass and Reduce Transparency keep the falloff
 * on the plain veil, so what sits on the band still has a ground. `picture` masks the clip that holds
 * `createFloatingBackdropPictureWebStyle`, and each layer carries its own opacity: an ancestor below 1
 * would become the blur's backdrop root and the frost would have nothing to blur.
 */
export function createScrimBandWebLayers(params: Readonly<{
    /** The page colour (`surface.base`): the band's ground under the rows seated on it. */
    ground: string;
    enableBlur: boolean;
    strength: FloatingBackdropStrength;
    rampPx: number;
    axes: ScrimBandAxes;
    /** A `centre` band's room beside the surface, which its sideways dissolve spans. Default `rampPx`. */
    sidePx?: number;
}>): Readonly<{ blur: readonly CSSProperties[]; veil: CSSProperties; picture: CSSProperties }> {
    const { blurPx } = FLOATING_BACKDROP_STRENGTHS[params.strength];
    const fill: CSSProperties = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 };
    const sidePx = params.sidePx ?? params.rampPx;
    const falloff = scrimBandMask(params.rampPx, params.axes, scrimRamp(), sidePx);
    return {
        blur: params.enableBlur ? scrimBlurLayers().map(({ scale, band }) => ({
            ...fill,
            ...createBackdropWebStyle({ backgroundColor: 'transparent', blurPx: blurPx * scale }),
            ...scrimBandMask(params.rampPx, params.axes, band, sidePx),
        })) : [],
        // One band recipe on every width and tier (OverlayScrim's): the page colour, held under the status line
        // and header so nothing behind them reads through, then dissolving, with the frost and picture showing
        // only in the dissolve. A phone band holds over the rows seated on it; a centred desktop band seats its
        // header inside the surface, so it holds exactly from the surface's top edge down (the ramp's underlap)
        // and dissolves over the rest of the ramp above it, and sideways.
        veil: {
            ...fill,
            ...scrimBandMask(params.rampPx, params.axes, params.axes === 'centre'
                ? scrimHeldRamp(SCRIM_RAMP_UNDERLAP / params.rampPx)
                : scrimBandRamp(), sidePx),
            backgroundColor: params.ground,
        },
        picture: { ...fill, ...falloff, overflow: 'hidden' },
    };
}

/** What the floating backdrop shows softly over its frost: the current picture, or the planet's colours. */
export type FloatingBackdropPicture =
    | Readonly<{ kind: 'picture'; uri: string }>
    | Readonly<{ kind: 'glow'; colors: readonly [string, string, string] }>;

/**
 * The soft picture layer inside the floating backdrop: the picture, blurred and faint, covering the window
 * (scaled so its blurred edge never shows), or a low planet-colour glow. Decorative and static.
 *
 * `window` fills a window-sized parent. `bottom` sits in a band centred along the window's bottom edge: the
 * picture keeps a window-sized crop, and the glow pools under the band's middle, since one centred on the
 * window would miss the band.
 */
export function createFloatingBackdropPictureWebStyle(
    picture: FloatingBackdropPicture,
    strength: FloatingBackdropStrength = FLOATING_BACKDROP_STRENGTH,
    anchor: 'window' | 'bottom' = 'window',
): CSSProperties {
    const { picture: soft, glow } = FLOATING_BACKDROP_STRENGTHS[strength];
    const bottom = anchor === 'bottom';
    const base: CSSProperties = bottom
        ? { position: 'absolute', left: '50%', bottom: 0, width: '100vw', height: '100vh', marginLeft: '-50vw', pointerEvents: 'none' }
        : { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none' };
    if (picture.kind === 'picture') {
        return {
            ...base,
            backgroundImage: `url("${picture.uri}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: `blur(${soft.blurPx}px)`,
            opacity: soft.opacity,
            transform: `scale(${soft.scale})`,
        };
    }
    const [warm, rose, cool] = picture.colors;
    return {
        ...base,
        backgroundImage: (bottom ? [
            `radial-gradient(36% 46% at 40% 74%, ${warm}, transparent)`,
            `radial-gradient(30% 40% at 60% 62%, ${rose}, transparent)`,
            `radial-gradient(52% 64% at 50% 84%, ${cool}, transparent)`,
        ] : [
            `radial-gradient(42% 38% at 62% 58%, ${warm}, transparent)`,
            `radial-gradient(36% 34% at 40% 66%, ${rose}, transparent)`,
            `radial-gradient(60% 52% at 50% 50%, ${cool}, transparent)`,
        ]).join(', '),
        opacity: glow,
    };
}

export function createBackdropNativeStyle(params: Readonly<{
    backgroundColor: string;
}>): ViewStyle {
    return {
        backgroundColor: params.backgroundColor,
    };
}
