import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '.';

/**
 * Computed WCAG contrast for the pairings the browser and local-services
 * surfaces actually paint (RU2 surfaces finalization, R-9).
 *
 * **Why this exists.** U-1 shipped a dark-mode primary CTA at 2.07:1 — text in
 * `button.primary.tint` on an `accent.indigo` fill, a pairing the tokens were
 * never designed for. Nothing in the repository computed a ratio over the real
 * token values, so no check could have caught it. `themeColorTokenDefinitions.ts`
 * declares `contrastPairs`, but those are advisory warnings shown to a user
 * *editing a theme profile*; the built-in themes were never asserted against a
 * measured floor.
 *
 * **What is asserted.** Every pairing below is one a corridor component renders
 * today, at the WCAG level that pairing requires: 4.5:1 for body text (1.4.3),
 * 3:1 for non-text UI and meaningful graphics (1.4.11). The point is not that
 * they pass today — it is that a token edit which quietly pushes one of them
 * under its floor fails here instead of shipping. Several sit close to the line
 * (`text.secondary` on `surface.base` is 4.86:1 in dark; `accent.blue` on
 * `surface.base` is 4.02:1 in light), so the margin is genuinely thin.
 *
 * **What is deliberately NOT asserted, and why.** Pairings that are below their
 * floor *today* are recorded in the lane report
 * (`.project/plans/2026-08-23-ru2-surfaces-finalization/lanes/Q2.md` §2–§4) with
 * their measured ratios and owning lane, not silently allowlisted here. They
 * split into two groups: call-site misuse inside `components/browser/**` and
 * `components/sessions/localServices/**` (owned by lanes A3 and F0), and
 * properties of the global palette — `text.tertiary`, `input.placeholder`,
 * `border.default` and the `#34C759` / `#FF9500` / `#FF3B30` status colours —
 * whose correction repaints the whole product and is a design decision above
 * this change. Adding them here as passing entries would assert a clean bill of
 * health the corridors do not have.
 *
 * Every pairing here is platform-invariant. `accent.indigo`, `accent.purple`,
 * `state.info.foreground`, `border.default` and `border.strong` resolve through
 * `Platform.select`, so a single-platform test run cannot speak for both
 * branches; the two that differ by branch (`accent.indigo`, `state.info.*`) are
 * not in this table.
 */

type Rgb = Readonly<{ red: number; green: number; blue: number; alpha: number }>;

function parseColor(value: string): Rgb {
    const normalized = value.trim();
    const hex = /^#([0-9a-fA-F]{3,8})$/.exec(normalized);
    if (hex) {
        const raw = hex[1];
        const expanded = raw.length === 3 || raw.length === 4
            ? raw.split('').map((character) => `${character}${character}`).join('')
            : raw;
        return {
            red: Number.parseInt(expanded.slice(0, 2), 16),
            green: Number.parseInt(expanded.slice(2, 4), 16),
            blue: Number.parseInt(expanded.slice(4, 6), 16),
            alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
        };
    }

    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(normalized);
    if (!rgb) throw new Error(`Unparseable theme color: ${value}`);
    return {
        red: Number(rgb[1]),
        green: Number(rgb[2]),
        blue: Number(rgb[3]),
        alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
}

/**
 * Composite a possibly translucent colour over an opaque backdrop.
 *
 * Several corridor tokens are `rgba(...)` tints — the dark `border.default`, the
 * `state.*.background` fills, the success halo. A ratio computed from the raw
 * channels of a 12%-alpha tint is meaningless, so the backdrop is folded in
 * first. (The theme-profile editor's warning helper skips this step; that gap is
 * recorded in the lane report.)
 */
function compositeOver(color: Rgb, backdrop: Rgb): Rgb {
    if (color.alpha >= 1) return color;
    return {
        red: (color.red * color.alpha) + (backdrop.red * (1 - color.alpha)),
        green: (color.green * color.alpha) + (backdrop.green * (1 - color.alpha)),
        blue: (color.blue * color.alpha) + (backdrop.blue * (1 - color.alpha)),
        alpha: 1,
    };
}

function relativeLuminance(color: Rgb): number {
    const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground: string, background: string, canvas: string): number {
    const canvasColor = parseColor(canvas);
    const backgroundColor = compositeOver(parseColor(background), canvasColor);
    const foregroundColor = compositeOver(parseColor(foreground), backgroundColor);
    const foregroundLuminance = relativeLuminance(foregroundColor);
    const backgroundLuminance = relativeLuminance(backgroundColor);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function readTokenPath(colors: unknown, path: string): string {
    const value = path.split('.').reduce<unknown>(
        (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
        colors,
    );
    if (typeof value !== 'string') throw new Error(`Theme token is not a colour string: ${path}`);
    return value;
}

type CorridorPairing = Readonly<{
    foreground: string;
    background: string;
    minRatio: number;
    /** A component that renders this pairing, so a failure names something real. */
    renderedBy: string;
}>;

const CORRIDOR_PAIRINGS: readonly CorridorPairing[] = [
    // Body and label text (1.4.3 — 4.5:1).
    { foreground: 'text.primary', background: 'surface.base', minRatio: 4.5, renderedBy: 'browser/diagnostics/BrowserDiagnosticsDrawer.tsx' },
    { foreground: 'text.primary', background: 'surface.inset', minRatio: 4.5, renderedBy: 'browser/BrowserAddressField.tsx' },
    { foreground: 'text.primary', background: 'surface.elevated', minRatio: 4.5, renderedBy: 'browser/frame/engines/DesktopWebViewEngine.tsx' },
    { foreground: 'text.primary', background: 'surface.pressed', minRatio: 4.5, renderedBy: 'sessions/localServices/ServicesScopeToggle.tsx' },
    { foreground: 'text.primary', background: 'background.canvas', minRatio: 4.5, renderedBy: 'the pane ancestor of both surfaces' },
    { foreground: 'text.secondary', background: 'surface.base', minRatio: 4.5, renderedBy: 'browser/frame/styles.ts statusText' },
    { foreground: 'text.secondary', background: 'surface.inset', minRatio: 4.5, renderedBy: 'browser/BrowserStatusBar.tsx' },
    { foreground: 'text.secondary', background: 'background.canvas', minRatio: 4.5, renderedBy: 'sessions/localServices/LocalServiceFactList.tsx' },
    { foreground: 'input.text', background: 'input.background', minRatio: 4.5, renderedBy: 'browser/launchpad/BrowserLaunchpadUrlEntry.tsx' },

    // The canonical filled-button pair. `RoundButton` and `SurfaceStateCard.action`
    // paint this, and it is the pairing the corridor's two hand-rolled indigo CTAs
    // must move onto: 21.00:1 light, 7.06:1 dark, against 2.07:1 for the accent fill.
    { foreground: 'button.primary.tint', background: 'button.primary.background', minRatio: 4.5, renderedBy: 'components/ui/buttons/RoundButton.tsx' },

    // Non-text UI and meaningful graphics (1.4.11 — 3:1).
    { foreground: 'accent.blue', background: 'surface.base', minRatio: 5, renderedBy: 'browser/BrowserLoadProgressBar.tsx' },
    { foreground: 'status.error', background: 'surface.inset', minRatio: 3, renderedBy: 'browser/launchpad/BrowserLaunchpadUrlEntry.tsx invalid field border' },
    { foreground: 'state.neutral.foreground', background: 'surface.base', minRatio: 3, renderedBy: 'sessions/localServices/ServiceStatusDot.tsx idle dot' },
];

describe('browser and local-services corridor contrast', () => {
    for (const [themeName, theme] of [['light', lightTheme], ['dark', darkTheme]] as const) {
        it(`keeps every corridor pairing at its WCAG floor in the ${themeName} theme`, () => {
            const canvas = readTokenPath(theme.colors, 'background.canvas');
            const failures = CORRIDOR_PAIRINGS.flatMap((pairing) => {
                const ratio = contrastRatio(
                    readTokenPath(theme.colors, pairing.foreground),
                    readTokenPath(theme.colors, pairing.background),
                    canvas,
                );
                return ratio >= pairing.minRatio
                    ? []
                    : [`${pairing.foreground} on ${pairing.background} = ${ratio.toFixed(2)}:1 `
                        + `(needs ${pairing.minRatio}:1, rendered by ${pairing.renderedBy})`];
            });

            expect(failures).toEqual([]);
        });
    }

    it('composites translucent tints over their backdrop before measuring', () => {
        // Guards the helper itself: without compositing, a 12%-alpha success tint
        // reads as saturated green and every ratio taken against it is wrong.
        const tint = contrastRatio(
            'rgba(52, 199, 89, 0.12)',
            '#ffffff',
            '#ffffff',
        );
        expect(tint).toBeLessThan(1.2);
        expect(contrastRatio('#767676', '#ffffff', '#ffffff')).toBeCloseTo(4.54, 1);
        expect(contrastRatio('#000000', '#ffffff', '#ffffff')).toBeCloseTo(21, 5);
    });
});
