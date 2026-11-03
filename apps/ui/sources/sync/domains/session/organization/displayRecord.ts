import type { SessionOrganizationDisplayState } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Opened state is authoritative; the plain fallback preserves the released display shape. */
export function readSessionOrganizationDisplayRecord(
    displayState: SessionOrganizationDisplayState,
    display: unknown,
): Record<string, unknown> | null {
    if (displayState.status !== 'available') return null;
    if (isRecord(displayState.value)) return displayState.value;
    return isRecord(display) && display.t === 'plain' && isRecord(display.v) ? display.v : null;
}
