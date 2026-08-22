import { invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { DESKTOP_ACTIVITY_OVERLAY_INTERACTION_RESULT_TIMEOUT_MS } from '../desktopActivityOverlayTiming';
import type { DesktopOverlayAnchor, DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';

export const DESKTOP_ACTIVITY_OVERLAY_EVENTS = {
    state: 'activityOverlay://state',
    interaction: 'activityOverlay://interaction',
    interactionResult: 'activityOverlay://interaction-result',
} as const;

let nextDesktopActivityOverlayInteractionRequestSequence = 0;

export type DesktopActivityOverlayRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type DesktopActivityOverlayPlacementDiagnostics = Readonly<{
    monitorSource: 'main_window' | 'overlay_window' | 'primary' | 'built_in' | 'focused';
    effectiveMonitor: DesktopActivityOverlayRect;
    anchor: DesktopOverlayAnchor;
    placementMode: DesktopOverlayPolicy['placementMode'];
    requestedHostMode: 'floating' | 'notch_integrated';
    hostMode: 'floating' | 'notch_integrated';
    hostFallbackReason?:
        | 'missing_display_context'
        | 'unsupported_platform'
        | 'external_display'
        | 'display_has_no_physical_notch'
        | 'panel_host_apply_failed'
        | 'panel_position_unavailable'
        | null;
    displayContext?: Readonly<{
        isMacos: boolean;
        isBuiltinDisplay: boolean;
        hasPhysicalNotch: boolean;
        safeAreaTop: number;
        physicalNotchSize?: Readonly<{
            width: number;
            height: number;
        }> | null;
        screenFrame: DesktopActivityOverlayRect;
        visibleFrame: DesktopActivityOverlayRect;
    }> | null;
    effectiveOffsetX: number;
    effectiveOffsetY: number;
    computedPosition: Readonly<{
        x: number;
        y: number;
    }>;
    nativeHostPath?: 'window' | 'panel';
    appliedNativeFrame?: DesktopActivityOverlayRect | null;
}>;

export type DesktopActivityOverlayWindowStatePayload = Readonly<{
    visible: boolean;
    expanded: boolean;
    model: DesktopActivityOverlayModel;
    policy: DesktopOverlayPolicy;
    window: DesktopActivityOverlayModel['window'];
    placementDiagnostics?: DesktopActivityOverlayPlacementDiagnostics | null;
}>;

export type DesktopActivityOverlaySyncPayload = Readonly<{
    visible: boolean;
    expanded: boolean;
    model: DesktopActivityOverlayModel;
    policy: DesktopOverlayPolicy;
    window: DesktopActivityOverlayModel['window'];
}>;

export type DesktopActivityOverlayInteractionPayload = Readonly<{
    requestId?: string;
    actionIdentifier: string;
    data: Record<string, unknown>;
}>;

export type DesktopActivityOverlayInteractionResultPayload = Readonly<{
    requestId: string;
    ok: boolean;
    errorCode?: string;
    error?: string;
}>;

export type DesktopActivityOverlayPointerId = number | string;

export type DesktopActivityOverlayDragVelocityPayload = Readonly<{
    pointerId: DesktopActivityOverlayPointerId;
    vx: number;
    vy: number;
    sampleWindowMs: number;
}>;

export type DesktopActivityOverlayMomentumDeltaPayload = Readonly<{
    generation: number;
    deltaX: number;
    deltaY: number;
}>;

type DesktopActivityOverlayScheduledMomentumDelta = Readonly<{
    deltaX: number;
    deltaY: number;
    delayMs: number;
}>;

type DesktopActivityOverlayMomentumPlan = Readonly<{
    generation: number;
    tickMs: number;
    deltas: readonly DesktopActivityOverlayScheduledMomentumDelta[];
}>;

function createDesktopActivityOverlayInteractionRequestId(): string {
    nextDesktopActivityOverlayInteractionRequestSequence =
        (nextDesktopActivityOverlayInteractionRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `desktop-overlay-interaction-${Date.now().toString(36)}-${nextDesktopActivityOverlayInteractionRequestSequence}`;
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'action_failed');
}

export async function syncDesktopActivityOverlay(payload: DesktopActivityOverlaySyncPayload): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_sync', { payload });
}

export async function getDesktopActivityOverlayWindowState(): Promise<DesktopActivityOverlayWindowStatePayload | null> {
    return invokeDesktopHost<DesktopActivityOverlayWindowStatePayload | null>('desktop_activity_overlay_get_window_state');
}

export async function setDesktopActivityOverlayExpanded(expanded: boolean): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_set_expanded', { expanded });
}

export async function setDesktopActivityOverlayInputLocked(locked: boolean): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_set_input_locked', { locked });
}

export async function applyDesktopActivityOverlayDragDelta(deltaX: number, deltaY: number): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_apply_drag_delta', { deltaX, deltaY });
}

export async function releaseDesktopActivityOverlayDragVelocity(
    payload: DesktopActivityOverlayDragVelocityPayload,
): Promise<void> {
    const plan = await invokeDesktopHost<DesktopActivityOverlayMomentumPlan>('desktop_activity_overlay_release_drag_velocity', {
        payload: {
            ...payload,
            pointerId: String(payload.pointerId),
        },
    });
    scheduleDesktopActivityOverlayMomentumPlan(plan);
}

export async function applyDesktopActivityOverlayMomentumDelta(
    payload: DesktopActivityOverlayMomentumDeltaPayload,
): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_apply_momentum_delta', { payload });
}

function scheduleDesktopActivityOverlayMomentumPlan(
    plan: DesktopActivityOverlayMomentumPlan | undefined,
): void {
    if (!plan || !Array.isArray(plan.deltas)) {
        return;
    }
    plan.deltas.forEach((delta, index) => {
        const delayMs = Number.isFinite(delta.delayMs) && delta.delayMs >= 0
            ? delta.delayMs * (index + 1)
            : plan.tickMs * (index + 1);
        setTimeout(() => {
            void applyDesktopActivityOverlayMomentumDelta({
                generation: plan.generation,
                deltaX: delta.deltaX,
                deltaY: delta.deltaY,
            }).catch(() => undefined);
        }, delayMs);
    });
}

export async function resetDesktopActivityOverlayPosition(): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_reset_position');
}

export async function showDesktopMainWindow(): Promise<void> {
    await invokeDesktopHost<void>('desktop_show_main_window');
}

export async function emitDesktopActivityOverlayInteraction(payload: DesktopActivityOverlayInteractionPayload): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_emit_interaction', { payload });
}

export async function emitDesktopActivityOverlayInteractionResult(
    payload: DesktopActivityOverlayInteractionResultPayload,
): Promise<void> {
    await invokeDesktopHost<void>('desktop_activity_overlay_emit_interaction_result', { payload });
}

export async function executeDesktopActivityOverlayInteractionWithResult(
    payload: DesktopActivityOverlayInteractionPayload,
    options: Readonly<{ timeoutMs?: number }> = {},
): Promise<DesktopActivityOverlayInteractionResultPayload> {
    const requestId = payload.requestId ?? createDesktopActivityOverlayInteractionRequestId();
    const timeoutMs = options.timeoutMs ?? DESKTOP_ACTIVITY_OVERLAY_INTERACTION_RESULT_TIMEOUT_MS;

    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let dispose: (() => void) | null = null;

    return new Promise<DesktopActivityOverlayInteractionResultPayload>((resolve) => {
        const settle = (result: DesktopActivityOverlayInteractionResultPayload) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            dispose?.();
            resolve(result);
        };

        timeoutId = setTimeout(() => {
            settle({
                requestId,
                ok: false,
                errorCode: 'ack_timeout',
                error: 'ack_timeout',
            });
        }, timeoutMs);

        listenDesktopActivityOverlayInteractionResult((result) => {
            if (result.requestId !== requestId) {
                return;
            }
            settle(result);
        }).then((nextDispose) => {
            if (settled) {
                nextDispose();
                return;
            }
            dispose = nextDispose;
            return emitDesktopActivityOverlayInteraction({
                ...payload,
                requestId,
            });
        }).catch((error: unknown) => {
            settle({
                requestId,
                ok: false,
                errorCode: 'bridge_emit_failed',
                error: readErrorMessage(error),
            });
        });
    });
}

export async function listenDesktopActivityOverlayWindowState(
    handler: (payload: DesktopActivityOverlayWindowStatePayload) => void,
): Promise<() => void> {
    return listenDesktopHostEvent<DesktopActivityOverlayWindowStatePayload>(DESKTOP_ACTIVITY_OVERLAY_EVENTS.state, handler);
}

export async function listenDesktopActivityOverlayInteraction(
    handler: (payload: DesktopActivityOverlayInteractionPayload) => void,
): Promise<() => void> {
    return listenDesktopHostEvent<DesktopActivityOverlayInteractionPayload>(DESKTOP_ACTIVITY_OVERLAY_EVENTS.interaction, handler);
}

export async function listenDesktopActivityOverlayInteractionResult(
    handler: (payload: DesktopActivityOverlayInteractionResultPayload) => void,
): Promise<() => void> {
    return listenDesktopHostEvent<DesktopActivityOverlayInteractionResultPayload>(DESKTOP_ACTIVITY_OVERLAY_EVENTS.interactionResult, handler);
}
