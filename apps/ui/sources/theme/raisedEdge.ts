import Color, { type ColorInstance } from 'color';
import { deriveThemePaint, fixedThemePaint, tokenThemePaint, type ThemePaint } from './profiles/themePaint';

/**
 * The colours of the raised edge (`@happier-dev/plugin-ui/presentation` → `raisedEdge.ts` owns which
 * side carries it and which states drop it).
 *
 * The edge is one side of an element's own border drawn a little lighter (dark themes) or darker
 * (light themes) than the rest. So each border role gets its raised twin here: the role's border
 * with the theme's edge ink composited over it, once, when the theme is built. It is precomputed
 * rather than mixed at style time because on web every theme string reaches a stylesheet as a CSS
 * variable reference, which cannot be composited in JavaScript.
 */

/** How much of the theme's own ink the edge adds: a white/6% top light on dark, a black/4% bottom lip on light. */
const RAISED_EDGE_INK_ALPHA = { dark: 0.06, light: 0.04 } as const;

/** How much light the gloss line of a filled accent control carries. */
const RAISED_EDGE_GLOSS_ALPHA = 0.16;

/**
 * Material G: one translucent ink overlay, shared by solid and glass surfaces. This is the theme's finish
 * ink (`effect.surfaceFinish`) at full strength: floating surfaces, the composer and the button finishes
 * draw it as it is.
 */
const SOFT_SURFACE_ALPHA = { light: 0.024, dark: 0.025 } as const;

/**
 * W3 (calm surfaces R2·1, owner ruling R6-1): an in-flow card on light carries the faintest trace of each
 * cue — a page fill under 0.4% of the theme's ink, a 0.6% foot band and a 1.2% lip over its 8% hairline —
 * so grouped sheets, widgets and cards read as grounded rather than drawn. The band and the lip are a
 * share of the theme's own finish and edge inks, so a profile that sets either keeps its colour and its
 * relative strength. Dark cards keep their ladder (authored raised surface, full finish, full edge).
 */
const CARD_FILL_INK_ALPHA_LIGHT = 0.004;
const CARD_FINISH_SHARE = { light: 0.006 / SOFT_SURFACE_ALPHA.light, dark: 1 } as const;
const CARD_EDGE_SHARE = { light: 0.012 / RAISED_EDGE_INK_ALPHA.light, dark: 1 } as const;

export type SurfaceFinishGradient = Readonly<{
    colors: readonly [string, string];
    locations: readonly [number, number];
    start: Readonly<{ x: number; y: number }>;
    end: Readonly<{ x: number; y: number }>;
    band?: Readonly<{ edge: 'top' | 'bottom'; height: number }>;
}>;

/**
 * The surface finish is a quiet edge, like coss's inner line, never a wash: light shades a short band
 * at the bottom edge, dark lights one at the top, and the middle of a tall card stays flat.
 */
const SURFACE_FINISH_BAND_PX = 32;

/** How much of its ink a dark theme's raised control lifts its fill by (berthd's input/32 ≈ white 2.5%). */
const RAISED_CONTROL_FILL_ALPHA_DARK = 0.025;

/**
 * The dark surface ladder (DESIGN.md → "Dark themes are layered, not inverted"; lab `ui-refine` R1): from
 * the page, an in-flow card and a floating surface each lift by a small step of the theme's own ink, so
 * depth reads without heavier shadows. Light themes keep one paper for page, cards and floating surfaces
 * (their border, edge and elevation carry the depth).
 */
const SURFACE_LAYER_LIFT_ALPHA_DARK = { card: 0.035, floating: 0.075 } as const;

/**
 * The directional rim (`components/ui/surfaces/SurfaceRim.tsx`; DESIGN.md → "The rim is a whisper"): one
 * corner light anchored top-left on a floating surface's hairline, falling off by 22% and gone by 35% of
 * the way, and a breath of sheen inside that corner. Drawn in the theme's own ink: on dark it reads as a
 * lighter corner, on light as a breath darker — never white. Calibrated against the reference in the
 * design lab (`ui-refine` M5, `design-doctrine-proposal.md` → Calibration).
 */
const RAISED_RIM_ALPHA = {
    dark: { hi: 0.18, mid: 0.05, sheen: 0.03 },
    light: { hi: 0.08, mid: 0.025, sheen: 0.018 },
} as const;

export type RaisedEdgeColors = Readonly<{
    /** `border.default` raised: cards drawn with the default hairline (widgets, a read-only composer). */
    default: string;
    /** `border.surface` raised at the card's strength (W3 on light): grouped sheets, page sheets, widgets and cards. */
    surface: string;
    /** `border.strong` raised: bordered controls (field boxes, outline buttons, search fields). */
    strong: string;
    /** `border.subtle` raised: quiet toolbar buttons. */
    subtle: string;
    /** `border.modal` raised: floating menus, popovers and dialogs. */
    modal: string;
    /** `state.danger.border` raised: a destructive outline action. */
    danger: string;
    /** The light top line inside a filled accent control (primary). */
    gloss: string;
    /**
     * The fill of a bordered control (field box, outline button): on dark the page lifted by a breath
     * of the theme's ink, so the control reads as standing on it; on light the page itself.
     */
    fill: string;
    /**
     * An in-flow card's fill (grouped sheets, page sheets, widget cards): one step of light up on dark; on
     * light the page under a breath of its own ink (W3).
     */
    cardFill: string;
    /** A floating surface's fill (menus, popovers, dialogs, toasts): two steps of light up on dark. */
    floatingFill: string;
    /** The rim's corner light at the top-left of a floating surface. */
    rimHi: string;
    /** The rim a fifth of the way out (22%); it is gone by 35%. */
    rimMid: string;
    /** The short soft sheen inside the lit corner. */
    sheen: string;
    /** The finish of floating surfaces and the composer: the theme's finish ink as it is. */
    finishGradient: SurfaceFinishGradient | null;
    /** An in-flow card's finish: the same band at the card's share of that ink (W3 on light). */
    cardFinishGradient: SurfaceFinishGradient | null;
    primaryFinishGradient: SurfaceFinishGradient | null;
    secondaryFinishGradient: SurfaceFinishGradient | null;
}>;

type RaisedEdgeThemeColors = Readonly<{
    text: Readonly<{ primary: string }>;
    surface: Readonly<{ base: string; elevated?: string }>;
    border: Readonly<{ default: string; surface: string; strong: string; subtle: string; modal: string }>;
    state: Readonly<{ danger: Readonly<{ border: string }> }>;
}>;

function withAlpha(color: string, alpha: number): string {
    const [r, g, b] = Color(color).rgb().array();
    return `rgba(${Math.round(r!)}, ${Math.round(g!)}, ${Math.round(b!)}, ${alpha})`;
}

/**
 * `over` laid on `under` (source-over), as one colour: what the eye sees where the edge ink crosses
 * the border. A colour the parser cannot read leaves `under` unchanged, so a broken custom value
 * costs the edge, never the border.
 */
export function compositeRaisedEdgeColor(under: string, over: string): string {
    let base: ColorInstance;
    let top: ColorInstance;
    try {
        base = Color(under);
        top = Color(over);
    } catch {
        return under;
    }
    const topAlpha = top.alpha();
    const baseAlpha = base.alpha();
    const alpha = topAlpha + baseAlpha * (1 - topAlpha);
    if (alpha <= 0) return 'rgba(0, 0, 0, 0)';
    const [tr, tg, tb] = top.rgb().array();
    const [br, bg, bb] = base.rgb().array();
    const channel = (topChannel: number, baseChannel: number) =>
        Math.round((topChannel * topAlpha + baseChannel * baseAlpha * (1 - topAlpha)) / alpha);
    return `rgba(${channel(tr!, br!)}, ${channel(tg!, bg!)}, ${channel(tb!, bb!)}, ${Math.round(alpha * 1000) / 1000})`;
}

/**
 * A theme's default edge ink (`effect.surfaceHighlight`): its own text ink at the scheme's edge
 * strength, so every theme — built-in, community or imported — lights its edges in its own hue.
 */
export function deriveRaisedEdgeInk(textPrimary: string, dark: boolean): string {
    try {
        return withAlpha(textPrimary, dark ? RAISED_EDGE_INK_ALPHA.dark : RAISED_EDGE_INK_ALPHA.light);
    } catch {
        return 'transparent';
    }
}

function liftSurfacePaint(colors: RaisedEdgeThemeColors, alpha: number): ThemePaint {
    return deriveThemePaint([tokenThemePaint({ colors }, 'surface.base'), tokenThemePaint({ colors }, 'text.primary')],
        (base, ink) => compositeRaisedEdgeColor(base, withAlpha(ink, alpha)));
}

/** How far a dark floating surface stands above a card: one quiet step of lightness in the card's own hue. */
const FLOATING_STEP_LIGHTNESS_DARK = 2.5;

/**
 * A dark theme's card: its authored raised surface when that is a step of light above the page (0.2's
 * page #191717 → raised #221C1C keeps the theme's warmth); otherwise the page lifted by the theme's ink.
 */
export function resolveDarkCardPaint(colors: RaisedEdgeThemeColors): ThemePaint {
    const elevated = colors.surface.elevated;
    try {
        if (elevated && Color(elevated).alpha() === 1 && Color(elevated).lightness() > Color(colors.surface.base).lightness()) {
            return deriveThemePaint([tokenThemePaint({ colors }, 'surface.elevated')], color => Color(color).rgb().string());
        }
    } catch {
        // An unreadable authored surface falls back to the derived lift.
    }
    return liftSurfacePaint(colors, SURFACE_LAYER_LIFT_ALPHA_DARK.card);
}

/** A dark floating surface: the card one quiet step lighter, keeping its hue and saturation. */
export function resolveDarkFloatingPaint(colors: RaisedEdgeThemeColors): ThemePaint {
    try {
        return deriveThemePaint([resolveDarkCardPaint(colors)], color => {
            const card = Color(color);
            return card.lightness(card.lightness() + FLOATING_STEP_LIGHTNESS_DARK).rgb().round().string();
        });
    } catch {
        return liftSurfacePaint(colors, SURFACE_LAYER_LIFT_ALPHA_DARK.floating);
    }
}

export function deriveSurfaceFinishInk(colors: RaisedEdgeThemeColors, dark: boolean): string {
    return resolveSurfaceFinishPaint(colors, dark).color;
}

export function resolveSurfaceFinishPaint(colors: RaisedEdgeThemeColors, dark: boolean): ThemePaint {
    try {
        // Lift the card's own hue, not neutral text: 80% lightness keeps the default top within
        // about four sRGB levels of Flat. Profiles share this derivation unless they author the ink.
        const ink = dark
            ? deriveThemePaint([resolveDarkCardPaint(colors)], color => Color(color).hsl().lightness(80).rgb().string())
            : tokenThemePaint({ colors }, 'text.primary');
        return deriveThemePaint([ink], color => withAlpha(color, SOFT_SURFACE_ALPHA[dark ? 'dark' : 'light']));
    } catch {
        return fixedThemePaint('transparent');
    }
}

/** `color` with its own alpha scaled by `share` (a card's share of a theme ink). */
function scaleAlpha(color: string, share: number): string {
    if (share === 1) return color;
    try {
        return withAlpha(color, Color(color).alpha() * share);
    } catch {
        return color;
    }
}

function buildSurfaceFinishGradients(colors: RaisedEdgeThemeColors, ink: string, dark: boolean) {
    let finishGradient: SurfaceFinishGradient | null = null;
    let cardFinishGradient: SurfaceFinishGradient | null = null;
    let primaryFinishGradient: SurfaceFinishGradient | null = null;
    let secondaryFinishGradient: SurfaceFinishGradient | null = null;
    try {
        const strength = Color(ink).alpha();
        if (strength > 0) {
            const scale = strength / SOFT_SURFACE_ALPHA.light;
            // Alpha's physical range is 0..1; no legibility ceiling is imposed on user strength.
            const at = (color: string, alpha: number) => withAlpha(color, Math.min(1, alpha));
            const gradient = (top: string, bottom: string, locations: readonly [number, number]): SurfaceFinishGradient => ({
                colors: [top, bottom], locations, start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 },
            });
            finishGradient = dark
                ? { ...gradient(at(ink, strength), at(ink, 0), [0, 1]), band: { edge: 'top', height: SURFACE_FINISH_BAND_PX } }
                : { ...gradient(at(ink, 0), at(ink, strength), [0, 1]), band: { edge: 'bottom', height: SURFACE_FINISH_BAND_PX } };
            cardFinishGradient = dark
                ? finishGradient
                : { ...gradient(at(ink, 0), at(ink, strength * CARD_FINISH_SHARE.light), [0, 1]), band: { edge: 'bottom', height: SURFACE_FINISH_BAND_PX } };
            secondaryFinishGradient = dark
                ? gradient(at(ink, strength * (8 / 9)), at(ink, 0), [0, 1])
                : gradient(at(ink, 0), at(ink, 0.025 * scale), [0, 1]);
            // Primary actions carry the opposite light: the theme's paper ink over the accent.
            primaryFinishGradient = dark
                ? gradient(at(colors.surface.base, 0), at(colors.surface.base, strength * (8 / 3)), [0, 1])
                : gradient(at(colors.surface.base, 0.14 * scale), at(colors.surface.base, 0), [0, 1]);
        }
    } catch {
        // A malformed profile loses the finish, preserving its existing surface material.
    }
    return { finishGradient, cardFinishGradient, primaryFinishGradient, secondaryFinishGradient };
}

/**
 * Every border role's raised colour for a theme, from its borders and its edge ink. The gloss is the
 * theme's lightest ink (the text on dark, the page on light) at gloss strength.
 */
export function buildRaisedEdgeColors(colors: RaisedEdgeThemeColors, ink: string, dark: boolean, finishInk = deriveSurfaceFinishInk(colors, dark)): RaisedEdgeColors {
    return buildRaisedEdgeColorsWithPaint(colors, ink, dark, finishInk).colors;
}

export type RaisedSurfacePaints = Readonly<{ controlFill: ThemePaint; cardFill: ThemePaint; floatingFill: ThemePaint }>;

export function buildRaisedEdgeColorsWithPaint(colors: RaisedEdgeThemeColors, ink: string, dark: boolean,
    finishInk = deriveSurfaceFinishInk(colors, dark)): Readonly<{ colors: RaisedEdgeColors; paint: RaisedSurfacePaints }> {
    const raise = (border: string) => compositeRaisedEdgeColor(border, ink);
    let gloss: string;
    let fill: ThemePaint;
    let cardFill: ThemePaint;
    let floatingFill: ThemePaint;
    let rimHi = 'transparent';
    let rimMid = 'transparent';
    let sheen = 'transparent';
    try {
        const rim = dark ? RAISED_RIM_ALPHA.dark : RAISED_RIM_ALPHA.light;
        rimHi = withAlpha(colors.text.primary, rim.hi);
        rimMid = withAlpha(colors.text.primary, rim.mid);
        sheen = withAlpha(colors.text.primary, rim.sheen);
        gloss = withAlpha(dark ? colors.text.primary : colors.surface.base, RAISED_EDGE_GLOSS_ALPHA);
        fill = dark ? liftSurfacePaint(colors, RAISED_CONTROL_FILL_ALPHA_DARK) : tokenThemePaint({ colors }, 'surface.base');
        cardFill = dark ? resolveDarkCardPaint(colors) : liftSurfacePaint(colors, CARD_FILL_INK_ALPHA_LIGHT);
        floatingFill = dark ? resolveDarkFloatingPaint(colors) : tokenThemePaint({ colors }, 'surface.base');
    } catch {
        gloss = 'transparent';
        fill = tokenThemePaint({ colors }, 'surface.base');
        cardFill = tokenThemePaint({ colors }, 'surface.base');
        floatingFill = tokenThemePaint({ colors }, 'surface.base');
    }
    return { paint: { controlFill: fill, cardFill, floatingFill }, colors: {
        default: raise(colors.border.default),
        surface: compositeRaisedEdgeColor(colors.border.surface, scaleAlpha(ink, CARD_EDGE_SHARE[dark ? 'dark' : 'light'])),
        strong: raise(colors.border.strong),
        subtle: raise(colors.border.subtle),
        modal: raise(colors.border.modal),
        danger: raise(colors.state.danger.border),
        gloss,
        fill: fill.color,
        cardFill: cardFill.color,
        floatingFill: floatingFill.color,
        rimHi,
        rimMid,
        sheen,
        ...buildSurfaceFinishGradients(colors, finishInk, dark),
    } };
}

/**
 * A base theme with its edge ink and raised colours filled in. Theme profiles re-derive both from
 * their own overrides (`profiles/deriveThemeColors.ts`), keeping an ink the user set explicitly.
 */
export function withRaisedEdgeColors<TTheme extends Readonly<{ dark: boolean; colors: RaisedEdgeThemeColors }>>(theme: TTheme) {
    const ink = deriveRaisedEdgeInk(theme.colors.text.primary, theme.dark);
    const finishInk = deriveSurfaceFinishInk(theme.colors, theme.dark);
    return {
        ...theme,
        colors: {
            ...theme.colors,
            effect: { surfaceHighlight: ink, surfaceFinish: finishInk },
            edge: buildRaisedEdgeColors(theme.colors, ink, theme.dark, finishInk),
        },
    };
}
