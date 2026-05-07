import { invokeTauri, isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';

export const DESKTOP_PET_OVERLAY_COMMANDS = {
    readWindowState: 'desktop_pet_overlay_read_window_state',
    setInputLocked: 'desktop_pet_overlay_set_input_locked',
    startDragSession: 'desktop_pet_overlay_start_drag_session',
    applyDragDelta: 'desktop_pet_overlay_apply_drag_delta',
    releaseDragVelocity: 'desktop_pet_overlay_release_drag_velocity',
    applyMomentumDelta: 'desktop_pet_overlay_apply_momentum_delta',
    syncElementMetrics: 'desktop_pet_overlay_sync_element_metrics',
    endDragSession: 'desktop_pet_overlay_end_drag_session',
    resetPosition: 'desktop_pet_overlay_reset_position',
    showMainWindow: 'desktop_pet_overlay_show_main_window',
} as const;

export const DESKTOP_PET_OVERLAY_EVENTS = {
    windowStateChanged: 'desktop_pet_overlay_window_state_changed',
    interactionResult: 'desktop_pet_overlay_interaction_result',
    showMainWindowRequested: 'desktop_pet_overlay_show_main_window_requested',
} as const;

export type DesktopPetOverlayPointerId = number | string;

export type DesktopPetOverlaySize = Readonly<{
    width: number;
    height: number;
}>;

export type DesktopPetOverlayRect = DesktopPetOverlaySize & Readonly<{
    x: number;
    y: number;
}>;

export type DesktopPetOverlayLayoutPlacement =
    | 'topStart'
    | 'topEnd'
    | 'bottomStart'
    | 'bottomEnd'
    | 'compact';

export type DesktopPetOverlayElementMetricsPayload = Readonly<{
    isTrayVisible: boolean;
    mascot: DesktopPetOverlayRect;
    tray: DesktopPetOverlayRect | null;
    controls: DesktopPetOverlayRect | null;
}>;

export type DesktopPetOverlayLayoutPayload = Readonly<{
    placement: DesktopPetOverlayLayoutPlacement;
    window: DesktopPetOverlaySize;
    mascot: DesktopPetOverlayRect;
    tray: DesktopPetOverlayRect | null;
    controls: DesktopPetOverlayRect | null;
}>;

export type DesktopPetOverlayPolicy = Readonly<{
    enabled: boolean;
    alwaysOnTop: boolean;
    inputLocked: boolean;
    anchor: 'bottomRight' | 'bottomLeft' | 'topRight' | 'topLeft';
}>;

export type DesktopPetOverlaySyncPayload = Readonly<{
    visible: boolean;
    expanded: boolean;
    window: DesktopPetOverlaySize;
    policy: DesktopPetOverlayPolicy;
}>;

export type DesktopPetOverlayPosition = Readonly<{
    x: number;
    y: number;
}>;

export type DesktopPetOverlayWindowStatePayload = Readonly<{
    visible: boolean;
    inputLocked: boolean;
    monitorId: string | null;
    logicalPosition: DesktopPetOverlayPosition;
    logicalSize: DesktopPetOverlaySize;
    scaleFactor: number;
    lastPlacementRecoveryCode: string | null;
    layout?: DesktopPetOverlayLayoutPayload | null;
}>;

export type DesktopPetOverlayDragStart = Readonly<{
    pointerId: DesktopPetOverlayPointerId;
    screenX: number;
    screenY: number;
    startedAtMs: number;
}>;

export type DesktopPetOverlayDragDelta = Readonly<{
    pointerId: DesktopPetOverlayPointerId;
    dx: number;
    dy: number;
    coordinateSpace: 'screen';
}>;

export type DesktopPetOverlayDragEnd = Readonly<{
    pointerId: DesktopPetOverlayPointerId;
    cancelled: boolean;
    screenX: number;
    screenY: number;
}>;

export type DesktopPetOverlayDragVelocity = Readonly<{
    pointerId: DesktopPetOverlayPointerId;
    vx: number;
    vy: number;
    sampleWindowMs: number;
}>;

export type DesktopPetOverlayMomentumDelta = Readonly<{
    generation: number;
    dx: number;
    dy: number;
}>;

type DesktopPetOverlayScheduledMomentumDelta = Readonly<{
    dx: number;
    dy: number;
    delayMs: number;
}>;

type DesktopPetOverlayMomentumPlan = Readonly<{
    generation: number;
    tickMs: number;
    deltas: readonly DesktopPetOverlayScheduledMomentumDelta[];
}>;

export type DesktopPetOverlayShowMainWindow = Readonly<{
    reason: 'mascot-click' | 'tray-action';
    targetSessionId?: string;
    targetThreadId?: string;
}>;

export type DesktopPetOverlayShowMainWindowRequestedPayload = DesktopPetOverlayShowMainWindow;

export type DesktopPetOverlayInputLocked = Readonly<{
    locked: boolean;
    reason:
        | 'disabled'
        | 'hidden'
        | 'dragging'
        | 'tray-open'
        | 'route-unmount'
        | 'feature-disabled'
        | 'shutdown';
}>;

export type DesktopPetOverlayInteractionResultPayload = Readonly<{
    requestId: string;
    ok: boolean;
    errorCode?: string;
    error?: string;
}>;

export async function syncDesktopPetOverlayState(payload: DesktopPetOverlaySyncPayload): Promise<void> {
    await invokeTauri<void>('sync_desktop_pet_overlay_state', { payload });
}

export async function getDesktopPetOverlayWindowState(): Promise<DesktopPetOverlayWindowStatePayload | null> {
    return invokeTauri<DesktopPetOverlayWindowStatePayload | null>(DESKTOP_PET_OVERLAY_COMMANDS.readWindowState);
}

export async function setDesktopPetOverlayInputLocked(payload: DesktopPetOverlayInputLocked): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.setInputLocked, { payload });
}

function normalizePointerPayload<TPayload extends { pointerId: DesktopPetOverlayPointerId }>(
    payload: TPayload,
): Omit<TPayload, 'pointerId'> & { pointerId: string } {
    return {
        ...payload,
        pointerId: String(payload.pointerId),
    };
}

export async function startDesktopPetOverlayDragSession(payload: DesktopPetOverlayDragStart): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.startDragSession, {
        payload: normalizePointerPayload(payload),
    });
}

export async function applyDesktopPetOverlayDragDelta(payload: DesktopPetOverlayDragDelta): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.applyDragDelta, {
        payload: normalizePointerPayload(payload),
    });
}

export async function endDesktopPetOverlayDragSession(payload: DesktopPetOverlayDragEnd): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.endDragSession, {
        payload: normalizePointerPayload(payload),
    });
}

export async function releaseDesktopPetOverlayDragVelocity(payload: DesktopPetOverlayDragVelocity): Promise<void> {
    const plan = await invokeTauri<DesktopPetOverlayMomentumPlan>(DESKTOP_PET_OVERLAY_COMMANDS.releaseDragVelocity, {
        payload: normalizePointerPayload(payload),
    });
    scheduleDesktopPetOverlayMomentumPlan(plan);
}

export async function applyDesktopPetOverlayMomentumDelta(payload: DesktopPetOverlayMomentumDelta): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.applyMomentumDelta, { payload });
}

function scheduleDesktopPetOverlayMomentumPlan(plan: DesktopPetOverlayMomentumPlan | undefined): void {
    if (!plan || !Array.isArray(plan.deltas)) {
        return;
    }
    plan.deltas.forEach((delta, index) => {
        const delayMs = Number.isFinite(delta.delayMs) && delta.delayMs >= 0
            ? delta.delayMs * (index + 1)
            : plan.tickMs * (index + 1);
        setTimeout(() => {
            void applyDesktopPetOverlayMomentumDelta({
                generation: plan.generation,
                dx: delta.dx,
                dy: delta.dy,
            }).catch(() => undefined);
        }, delayMs);
    });
}

export async function syncDesktopPetOverlayElementMetrics(
    payload: DesktopPetOverlayElementMetricsPayload,
): Promise<void> {
    if (!isTauriDesktop()) return;
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.syncElementMetrics, { payload });
}

export async function resetDesktopPetOverlayPosition(): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.resetPosition);
}

export async function emitDesktopPetOverlayInteractionResult(
    payload: DesktopPetOverlayInteractionResultPayload,
): Promise<void> {
    await invokeTauri<void>('emit_desktop_pet_overlay_interaction_result', { payload });
}

export async function showMainWindowFromDesktopPetOverlay(
    payload: DesktopPetOverlayShowMainWindow = { reason: 'mascot-click' },
): Promise<void> {
    await invokeTauri<void>(DESKTOP_PET_OVERLAY_COMMANDS.showMainWindow, { payload });
}

export async function listenDesktopPetOverlayWindowState(
    handler: (payload: DesktopPetOverlayWindowStatePayload) => void,
): Promise<() => void> {
    return listenTauriEvent<DesktopPetOverlayWindowStatePayload>(DESKTOP_PET_OVERLAY_EVENTS.windowStateChanged, handler);
}

export async function listenDesktopPetOverlayInteractionResult(
    handler: (payload: DesktopPetOverlayInteractionResultPayload) => void,
): Promise<() => void> {
    return listenTauriEvent<DesktopPetOverlayInteractionResultPayload>(DESKTOP_PET_OVERLAY_EVENTS.interactionResult, handler);
}

export async function listenDesktopPetOverlayShowMainWindowRequested(
    handler: (payload: DesktopPetOverlayShowMainWindowRequestedPayload) => void,
): Promise<() => void> {
    return listenTauriEvent<DesktopPetOverlayShowMainWindowRequestedPayload>(
        DESKTOP_PET_OVERLAY_EVENTS.showMainWindowRequested,
        handler,
    );
}
