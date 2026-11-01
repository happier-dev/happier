import { parseAccentColorKey, type AccentColorKey } from '@/theme/accentColors';
import { normalizeOpaqueThemeHexColor } from '@/theme/profiles/themeProfileColorValidation';
import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol';

export type SessionAppearanceColor =
    | Readonly<{ kind: 'accent'; key: AccentColorKey }>
    | Readonly<{ kind: 'custom'; hex: `#${string}` }>;

const colorByDisplay = new WeakMap<SessionOrganizationContentEnvelope, SessionAppearanceColor | null>();

/** Opened immutable display envelopes share their decoded colour across selectors/projections. */
export function readSessionAppearanceColorFromDisplay(display: SessionOrganizationContentEnvelope | null | undefined): SessionAppearanceColor | null {
    if (!display) return null;
    if (colorByDisplay.has(display)) return colorByDisplay.get(display) ?? null;
    const value = display.t === 'plain' && display.v && typeof display.v === 'object' && !Array.isArray(display.v)
        ? parseSessionAppearanceColor((display.v as Record<string, unknown>).color) : null;
    colorByDisplay.set(display, value);
    return value;
}

export function parseSessionAppearanceColor(value: unknown): SessionAppearanceColor | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind === 'accent') {
        const key = parseAccentColorKey(record.key);
        return key ? { kind: 'accent', key } : null;
    }
    if (record.kind === 'custom') {
        const hex = normalizeOpaqueThemeHexColor(record.hex);
        return hex ? { kind: 'custom', hex } : null;
    }
    return null;
}

export function sessionAppearanceColorKey(color: SessionAppearanceColor | null | undefined): string {
    return !color ? '' : color.kind === 'accent' ? `accent:${color.key}` : `custom:${color.hex}`;
}

export function areSessionAppearanceColorsEqual(left: SessionAppearanceColor | null | undefined, right: SessionAppearanceColor | null | undefined): boolean {
    return sessionAppearanceColorKey(left) === sessionAppearanceColorKey(right);
}

/** A session override wins; clearing it reveals the workspace choice. References are preserved. */
export function resolveEffectiveSessionAppearanceColor(params: Readonly<{
    sessionColor?: SessionAppearanceColor | null;
    workspaceColor?: SessionAppearanceColor | null;
}>): SessionAppearanceColor | null {
    return params.sessionColor ?? params.workspaceColor ?? null;
}

export function resolveSessionAppearanceColor(color: SessionAppearanceColor | null | undefined, theme: Readonly<{ colors: { accent: Readonly<Record<AccentColorKey, string>> } }>): string | null {
    return !color ? null : color.kind === 'custom' ? color.hex : theme.colors.accent[color.key];
}
