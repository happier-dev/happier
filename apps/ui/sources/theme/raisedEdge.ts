import Color, { type ColorInstance } from 'color';

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

/** How much of its ink a dark theme's raised control lifts its fill by (berthd's input/32 ≈ white 2.5%). */
const RAISED_CONTROL_FILL_ALPHA_DARK = 0.025;

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
    /** `border.surface` raised: grouped sheets, cards, themed popovers, the composer. */
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
    /** The rim's corner light at the top-left of a floating surface. */
    rimHi: string;
    /** The rim a fifth of the way out (22%); it is gone by 35%. */
    rimMid: string;
    /** The short soft sheen inside the lit corner. */
    sheen: string;
}>;

type RaisedEdgeThemeColors = Readonly<{
    text: Readonly<{ primary: string }>;
    surface: Readonly<{ base: string }>;
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

/**
 * Every border role's raised colour for a theme, from its borders and its edge ink. The gloss is the
 * theme's lightest ink (the text on dark, the page on light) at gloss strength.
 */
export function buildRaisedEdgeColors(colors: RaisedEdgeThemeColors, ink: string, dark: boolean): RaisedEdgeColors {
    const raise = (border: string) => compositeRaisedEdgeColor(border, ink);
    let gloss: string;
    let fill: string;
    let rimHi = 'transparent';
    let rimMid = 'transparent';
    let sheen = 'transparent';
    try {
        const rim = dark ? RAISED_RIM_ALPHA.dark : RAISED_RIM_ALPHA.light;
        rimHi = withAlpha(colors.text.primary, rim.hi);
        rimMid = withAlpha(colors.text.primary, rim.mid);
        sheen = withAlpha(colors.text.primary, rim.sheen);
        gloss = withAlpha(dark ? colors.text.primary : colors.surface.base, RAISED_EDGE_GLOSS_ALPHA);
        fill = dark
            ? compositeRaisedEdgeColor(colors.surface.base, withAlpha(colors.text.primary, RAISED_CONTROL_FILL_ALPHA_DARK))
            : colors.surface.base;
    } catch {
        gloss = 'transparent';
        fill = colors.surface.base;
    }
    return {
        default: raise(colors.border.default),
        surface: raise(colors.border.surface),
        strong: raise(colors.border.strong),
        subtle: raise(colors.border.subtle),
        modal: raise(colors.border.modal),
        danger: raise(colors.state.danger.border),
        gloss,
        fill,
        rimHi,
        rimMid,
        sheen,
    };
}

/**
 * A base theme with its edge ink and raised colours filled in. Theme profiles re-derive both from
 * their own overrides (`profiles/deriveThemeColors.ts`), keeping an ink the user set explicitly.
 */
export function withRaisedEdgeColors<TTheme extends Readonly<{ dark: boolean; colors: RaisedEdgeThemeColors }>>(theme: TTheme) {
    const ink = deriveRaisedEdgeInk(theme.colors.text.primary, theme.dark);
    return {
        ...theme,
        colors: {
            ...theme.colors,
            effect: { surfaceHighlight: ink },
            edge: buildRaisedEdgeColors(theme.colors, ink, theme.dark),
        },
    };
}
