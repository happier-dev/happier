import type { DesktopActivityOverlaySyncPayload } from './desktopActivityOverlayBridge';

export const DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE_KEY = '__HAPPIER_DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE__';
export const DESKTOP_ACTIVITY_OVERLAY_QA_PROOF_PIN_UNTIL_MODEL_KEY = '__happierQaProofPinUntilEpochMs';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isDesktopActivityOverlaySyncPayload(value: unknown): value is DesktopActivityOverlaySyncPayload {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.visible === 'boolean'
        && typeof value.expanded === 'boolean'
        && isRecord(value.model)
        && isRecord(value.policy)
        && isRecord(value.window);
}

function resolveOverrideTarget(windowObj: object | null | undefined): Record<string, unknown> | null {
    if (!windowObj || typeof windowObj !== 'object') {
        return null;
    }
    return windowObj as Record<string, unknown>;
}

export function writeDesktopActivityOverlayQaSyncOverride({
    payload,
    ttlMs,
    now = Date.now(),
    windowObj = globalThis,
}: Readonly<{
    payload: DesktopActivityOverlaySyncPayload;
    ttlMs: number;
    now?: number;
    windowObj?: object | null;
}>): void {
    const target = resolveOverrideTarget(windowObj);
    if (!target) {
        return;
    }
    target[DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE_KEY] = {
        payload,
        expiresAt: now + Math.max(0, ttlMs),
    };
}

export function clearDesktopActivityOverlayQaSyncOverride(windowObj: object | null | undefined = globalThis): void {
    const target = resolveOverrideTarget(windowObj);
    if (!target) {
        return;
    }
    delete target[DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE_KEY];
}

export function readDesktopActivityOverlayQaSyncOverride({
    now = Date.now(),
    windowObj = globalThis,
}: Readonly<{
    now?: number;
    windowObj?: object | null;
}> = {}): DesktopActivityOverlaySyncPayload | null {
    const target = resolveOverrideTarget(windowObj);
    if (!target) {
        return null;
    }
    const entry = target[DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE_KEY];
    if (!isRecord(entry)) {
        return null;
    }
    const expiresAt = Number(entry.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        clearDesktopActivityOverlayQaSyncOverride(windowObj);
        return null;
    }
    return isDesktopActivityOverlaySyncPayload(entry.payload) ? entry.payload : null;
}
