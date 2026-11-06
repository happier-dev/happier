import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol/sessions';
import { parseAccentColorKey, type AccentColorKey } from '@/theme/accentColors';
import { normalizeOpaqueThemeHexColor } from '@/theme/profiles/themeProfileColorValidation';
import type { SessionOrganizationDisplayState } from './types';
import { readSessionOrganizationDisplayRecord } from './displayRecord';

export type SessionAppearanceColor =
    | Readonly<{ kind: 'accent'; key: AccentColorKey }>
    | Readonly<{ kind: 'custom'; hex: `#${string}` }>;

const colorByDisplayRecord = new WeakMap<object, SessionAppearanceColor | null>();

export function readSessionAppearanceColorFromDisplay(
    display: SessionOrganizationContentEnvelope | null | undefined,
    displayState?: SessionOrganizationDisplayState,
): SessionAppearanceColor | null {
    const record = readSessionOrganizationDisplayRecord(displayState ?? { status: 'available', value: null }, display);
    if (!record) return null;
    if (colorByDisplayRecord.has(record)) return colorByDisplayRecord.get(record) ?? null;
    const color = parseSessionAppearanceColor(record.color);
    colorByDisplayRecord.set(record, color);
    return color;
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

/** Clearing a Session override reveals its workspace choice and preserves the selected identity. */
export function resolveEffectiveSessionAppearanceColor(params: Readonly<{
    sessionColor?: SessionAppearanceColor | null;
    workspaceColor?: SessionAppearanceColor | null;
}>): SessionAppearanceColor | null {
    return params.sessionColor ?? params.workspaceColor ?? null;
}

export function resolveSessionAppearanceColor(color: SessionAppearanceColor | null | undefined, theme: Readonly<{ colors: { accent: Readonly<Record<AccentColorKey, string>> } }>): string | null {
    return !color ? null : color.kind === 'custom' ? color.hex : theme.colors.accent[color.key];
}
