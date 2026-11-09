/**
 * Which edge each surface role stands on, per colour scheme — the one place to choose it.
 *
 * - `flat`: the raised edge (`themeRaisedEdge.ts`): one side of the surface's own hairline lit on dark
 *   and lipped on light, with the role's elevation. Controls, fields and rows always use it.
 * - `rim`: the directional rim (`SurfaceRim`): the hairline lit from the top left, brightest at that
 *   corner and fading along both edges, with a short sheen inside the corner. Never on a control.
 *
 * Material D (user pick, 2026-10-07; DESIGN.md → "Flat edge in flow; the rim only for what floats"): the
 * rim only where something floats — popovers, menus, dialogs, sheets, toasts and tooltips — in both
 * schemes. Everything in flow keeps the flat edge; the message bubble is a fill only (owner, 2026-11-01).
 */
export type SurfaceEdgeTreatment = 'flat' | 'rim';

export type SurfaceEdgeRole = 'card' | 'floating' | 'composer';

export const SURFACE_EDGE_TREATMENT: Readonly<Record<SurfaceEdgeRole, Readonly<{ dark: SurfaceEdgeTreatment; light: SurfaceEdgeTreatment }>>> = Object.freeze({
    /** Grouped sheets, widget and surface cards, rows: they sit in the page, not above it. */
    card: { dark: 'flat', light: 'flat' },
    /** Popovers, menus, tooltips, dialogs, sheets and toasts. */
    floating: { dark: 'rim', light: 'rim' },
    /** The session composer. */
    composer: { dark: 'flat', light: 'flat' },
});

export function surfaceUsesRim(role: SurfaceEdgeRole, dark: boolean): boolean {
    return SURFACE_EDGE_TREATMENT[role][dark ? 'dark' : 'light'] === 'rim';
}
