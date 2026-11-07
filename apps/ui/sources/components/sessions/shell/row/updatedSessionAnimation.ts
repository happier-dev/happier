import type { Theme } from '@/theme';
import type { SessionRowAttentionState } from './resolveSessionRowPresentation';

/**
 * Updated session animation: how a session-list row that is waiting on the person draws attention
 * to itself. It is a presentation of the row's existing attention state, so which states qualify,
 * and in which colour, is decided here against that state rather than re-derived from the session.
 */
export type UpdatedSessionAnimation = 'none' | 'fade' | 'glow' | 'sweep';
export type UpdatedAnimationTone = 'warning' | 'danger' | 'info';

export function normalizeUpdatedSessionAnimation(value: unknown): UpdatedSessionAnimation {
    return value === 'fade' || value === 'glow' || value === 'sweep' ? value : 'none';
}

/**
 * Waiting on the person is orange; failed is red; an unseen update that needs no input (unread, or
 * ready for review) is light blue; everything else stays still.
 */
export function resolveUpdatedAnimationTone(attentionState: SessionRowAttentionState): UpdatedAnimationTone | null {
    switch (attentionState) {
        case 'permission_required':
        case 'action_required':
            return 'warning';
        case 'failed':
            return 'danger';
        case 'unread':
        case 'ready':
            return 'info';
        default:
            return null;
    }
}

/** One full inhale + exhale. Slow enough to read as breathing rather than flashing. */
export const UPDATED_ANIMATION_BREATH_MS = 2400;
/** One pass of the sweep across the row. */
export const UPDATED_ANIMATION_SWEEP_MS = 2800;
/** The fade style's steady outline: thick enough to read at a glance, not a hairline. */
export const UPDATED_ANIMATION_OUTLINE_WIDTH = 3;

export type UpdatedAnimationPalette = Readonly<{
    restSurface: string;
    /** Fade: the surface and primary ink swapped, so it holds in every light/dark theme. */
    invertedSurface: string;
    invertedInk: string;
    toneColor: string;
    /** Sweep: the plain tone on light themes, a darker shade of it on dark themes. */
    sweepColor: string;
}>;

export function resolveUpdatedAnimationPalette(theme: Theme, tone: UpdatedAnimationTone): UpdatedAnimationPalette {
    const toneColor = tone === 'danger'
        ? theme.colors.state.danger.foreground
        : tone === 'info'
            ? theme.colors.state.info.foreground
            : theme.colors.state.warning.foreground;
    return {
        restSurface: theme.colors.surface.base,
        invertedSurface: theme.colors.text.primary,
        invertedInk: theme.colors.surface.base,
        toneColor,
        sweepColor: theme.dark ? shadeHex(toneColor, 0.55) : toneColor,
    };
}

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function toHexByte(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/** Darkens `#rrggbb` toward black; anything else is returned as it came. */
export function shadeHex(color: string, factor: number): string {
    const match = HEX_COLOR.exec(color);
    if (!match) return color;
    const [, r, g, b] = match;
    return `#${toHexByte(parseInt(r, 16) * factor)}${toHexByte(parseInt(g, 16) * factor)}${toHexByte(parseInt(b, 16) * factor)}`;
}

/** Adds alpha to `#rrggbb`; anything else is returned as it came. */
export function withAlpha(color: string, alpha: number): string {
    return HEX_COLOR.test(color) ? `${color}${toHexByte(alpha * 255)}` : color;
}
