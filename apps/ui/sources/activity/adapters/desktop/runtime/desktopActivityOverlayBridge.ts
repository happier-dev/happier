import { desktopHostKind, invokeDesktopHost, listenDesktopHostEvent, requireDesktopHostRole, type DesktopHostAvailability } from '@/utils/platform/desktopHost';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { DESKTOP_ACTIVITY_OVERLAY_INTERACTION_RESULT_TIMEOUT_MS } from '../desktopActivityOverlayTiming';
import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import type { NotchSurface } from '../ui/presentation/notchPresentation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    emitDesktopWindowAction,
    emitDesktopWindowActionResult,
    executeDesktopWindowActionWithResult,
    listenDesktopWindowAction,
    listenDesktopWindowActionResult,
    DESKTOP_WINDOW_ACTION_EVENTS,
} from '@/utils/platform/desktopWindowActionBridge';

export const DESKTOP_ACTIVITY_OVERLAY_EVENTS = {
    state: 'activityOverlay://state',
    pointer: 'activityOverlay://pointer',
    interaction: DESKTOP_WINDOW_ACTION_EVENTS.request,
    interactionResult: DESKTOP_WINDOW_ACTION_EVENTS.result,
} as const;

export type DesktopActivityOverlayExtent = Readonly<{
    width: number;
    height: number;
    cameraOffset?: number;
    /** Additional layer bounds in logical screen coordinates (the Session window rect's units). */
    screenBounds?: DesktopActivityOverlayRect;
}>;
export type DesktopActivityOverlayPresent = Readonly<{
    surface: NotchSurface;
    engaged: boolean;
    extent: DesktopActivityOverlayExtent;
    settled?: boolean;
}>;
/** Applied window top-left in logical screen coordinates; scaleFactor maps logical to physical pixels. */
export type DesktopActivityOverlayScreenOrigin = Readonly<{ x: number; y: number; scaleFactor: number }>;
export type DesktopActivityOverlayFrame = Readonly<{
    dock: 'top' | 'left' | 'right' | 'floating';
    growth: Readonly<{ x: 'left' | 'right' | null; y: 'up' | 'down' | null }>;
    anchorOffset: Readonly<{ x: number; y: number }>;
    screenOrigin?: DesktopActivityOverlayScreenOrigin;
}>;
export type DesktopActivityOverlayPointer = Readonly<{ kind: 'enter' | 'leave' | 'outsidePress' }>;
export type DesktopNotchSetInput = Parameters<NonNullable<import('@happier-dev/protocol/actions/actionExecutor').ActionExecutorDeps['desktopNotchSet']>>[0]['input'];
export type DesktopActivityOverlayPresentationRequest = Readonly<{
    state: NonNullable<DesktopNotchSetInput['state']>; focus: boolean;
}>;

export async function setDesktopNotch(input: DesktopNotchSetInput): Promise<void> {
    await requireDesktopHostRole('activity');
    if (input.position !== undefined) {
        await invokeDesktopHost<void>('desktop_activity_overlay_move', { position: input.position, commit: true });
    }
    if (input.state !== undefined) {
        await invokeDesktopHost<void>('desktop_activity_overlay_request_presentation', { requestedState: input.state });
    }
}

export async function listenDesktopActivityOverlayPresentation(handler: (payload: DesktopActivityOverlayPresentationRequest) => void): Promise<() => void> {
    await requireDesktopHostRole('activity');
    let disposed = false;
    const drain = async () => {
        const input = await invokeDesktopHost<DesktopActivityOverlayPresentationRequest | null>('desktop_activity_overlay_take_presentation_request');
        if (!disposed && input) handler(input);
    };
    const unlisten = await listenDesktopHostEvent('activityOverlay://presentation', () => {
        fireAndForget(drain(), { tag: 'desktopActivityOverlay.presentation' });
    });
    try { await drain(); } catch (error) { unlisten(); throw error; }
    return () => { disposed = true; unlisten(); };
}

export async function setDesktopActivityOverlayKeyboardWanted(wanted: boolean): Promise<void> {
    await requireDesktopHostRole('activity');
    await invokeDesktopHost<void>('desktop_activity_overlay_set_keyboard_wanted', { wanted });
}

export type DesktopActivityOverlayRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type DesktopActivityOverlayPlacementDiagnostics = Readonly<{
    monitorSource: 'main_window' | 'overlay_window' | 'primary' | 'built_in' | 'named';
    effectiveMonitor: DesktopActivityOverlayRect;
    display?: Readonly<{ storageKey: string; name: string; source: string; fellBack: boolean; requestedName?: string }>;
    dock: DesktopActivityOverlayFrame['dock'];
    surface: NotchSurface;
    engaged: boolean;
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
    computedPosition: Readonly<{
        x: number;
        y: number;
    }>;
    nativeHostPath?: 'window' | 'panel';
    appliedNativeFrame?: DesktopActivityOverlayRect | null;
}>;

export type DesktopActivityOverlayWindowStatePayload = Readonly<{
    visible: boolean;
    surface?: NotchSurface;
    engaged?: boolean;
    frame?: DesktopActivityOverlayFrame;
    availability?: Partial<DesktopHostAvailability>;
    model: DesktopActivityOverlayModel;
    policy: DesktopOverlayPolicy;
    placementDiagnostics?: DesktopActivityOverlayPlacementDiagnostics | null;
}>;

export type DesktopActivityOverlaySyncPayload = Readonly<{
    visible: boolean;
    model: DesktopActivityOverlayModel;
    policy: DesktopOverlayPolicy;
}>;

export type DesktopActivityOverlayInteractionPayload = Readonly<{
    requestId?: string;
    actionIdentifier: string;
    data: Record<string, unknown>;
}>;

export type DesktopActivityOverlayInteractionResultPayload = Readonly<{
    requestId: string;
    ok: boolean;
    /** The Action's output when it succeeded (already validated by the executor in main). */
    result?: unknown;
    errorCode?: string;
    error?: string;
}>;

export async function syncDesktopActivityOverlay(payload: DesktopActivityOverlaySyncPayload): Promise<void> {
    await requireDesktopHostRole('activity');
    await invokeDesktopHost('desktop_activity_overlay_sync', { payload });
}

export async function getDesktopActivityOverlayWindowState(): Promise<DesktopActivityOverlayWindowStatePayload | null> {
    await requireDesktopHostRole('activity');
    return invokeDesktopHost<DesktopActivityOverlayWindowStatePayload | null>('desktop_activity_overlay_get_window_state');
}

export async function presentDesktopActivityOverlay(payload: DesktopActivityOverlayPresent): Promise<void> {
    await requireDesktopHostRole('activity');
    await invokeDesktopHost<void>('desktop_activity_overlay_present', { payload });
}

export async function listenDesktopActivityOverlayPointer(handler: (payload: DesktopActivityOverlayPointer) => void): Promise<() => void> {
    await requireDesktopHostRole('activity');
    return listenDesktopHostEvent(DESKTOP_ACTIVITY_OVERLAY_EVENTS.pointer, handler);
}

/** WebView2 supplies entry; the engaged native raw-input adapter supplies reliable exit. */
export async function enterDesktopActivityOverlayPointer(): Promise<void> {
    await requireDesktopHostRole('activity');
    if (desktopHostKind() === 'tauri') await invokeDesktopHost<void>('desktop_activity_overlay_pointer_enter');
}

export type DesktopActivityOverlayMove = Readonly<{
    delta: Readonly<{ x: number; y: number }>;
    commit: boolean;
}>;

export async function moveDesktopActivityOverlay(move: DesktopActivityOverlayMove): Promise<void> {
    await requireDesktopHostRole('activity');
    await invokeDesktopHost<void>('desktop_activity_overlay_move', move);
}

export async function showDesktopMainWindow(): Promise<void> {
    await invokeDesktopHost<void>('desktop_show_main_window');
}

export async function emitDesktopActivityOverlayInteraction(payload: DesktopActivityOverlayInteractionPayload): Promise<void> {
    await emitDesktopWindowAction({ ...payload, windowLabel: 'activity_overlay' });
}

export async function emitDesktopActivityOverlayInteractionResult(
    payload: DesktopActivityOverlayInteractionResultPayload,
): Promise<void> {
    await emitDesktopWindowActionResult({ ...payload, windowLabel: 'activity_overlay' });
}

export async function executeDesktopActivityOverlayInteractionWithResult(
    payload: DesktopActivityOverlayInteractionPayload,
    options: Readonly<{ timeoutMs?: number }> = {},
): Promise<DesktopActivityOverlayInteractionResultPayload> {
    const { windowLabel: _windowLabel, ...result } = await executeDesktopWindowActionWithResult(
        { ...payload, windowLabel: 'activity_overlay' },
        { timeoutMs: options.timeoutMs ?? DESKTOP_ACTIVITY_OVERLAY_INTERACTION_RESULT_TIMEOUT_MS },
    );
    return result;
}

export async function listenDesktopActivityOverlayWindowState(
    handler: (payload: DesktopActivityOverlayWindowStatePayload) => void,
): Promise<() => void> {
    await requireDesktopHostRole('activity');
    return listenDesktopHostEvent<DesktopActivityOverlayWindowStatePayload>(DESKTOP_ACTIVITY_OVERLAY_EVENTS.state, handler);
}

export async function listenDesktopActivityOverlayInteraction(
    handler: (payload: DesktopActivityOverlayInteractionPayload) => void,
): Promise<() => void> {
    return listenDesktopWindowAction(payload => { if (payload.windowLabel === 'activity_overlay') handler(payload); });
}

export async function listenDesktopActivityOverlayInteractionResult(
    handler: (payload: DesktopActivityOverlayInteractionResultPayload) => void,
): Promise<() => void> {
    return listenDesktopWindowActionResult(payload => { if (payload.windowLabel === 'activity_overlay') handler(payload); });
}
