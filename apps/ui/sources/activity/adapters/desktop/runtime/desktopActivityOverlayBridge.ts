import { invokeTauri, listenTauriEvent } from '@/utils/platform/tauri';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopOverlayAnchor, DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';

export const DESKTOP_ACTIVITY_OVERLAY_EVENTS = {
    state: 'activityOverlay://state',
    interaction: 'activityOverlay://interaction',
} as const;

export type DesktopActivityOverlayRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type DesktopActivityOverlayPlacementDiagnostics = Readonly<{
    monitorSource: 'main_window' | 'overlay_window' | 'primary';
    effectiveMonitor: DesktopActivityOverlayRect;
    anchor: DesktopOverlayAnchor;
    placementMode: DesktopOverlayPolicy['placementMode'];
    hostMode: 'floating' | 'notch_integrated';
    displayContext?: Readonly<{
        isMacos: boolean;
        isBuiltinDisplay: boolean;
        hasPhysicalNotch: boolean;
        safeAreaTop: number;
        screenFrame: DesktopActivityOverlayRect;
        visibleFrame: DesktopActivityOverlayRect;
    }> | null;
    effectiveOffsetX: number;
    effectiveOffsetY: number;
    computedPosition: Readonly<{
        x: number;
        y: number;
    }>;
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
    actionIdentifier: string;
    data: Record<string, unknown>;
}>;

export async function syncDesktopActivityOverlay(payload: DesktopActivityOverlaySyncPayload): Promise<void> {
    await invokeTauri<void>('desktop_activity_overlay_sync', { payload });
}

export async function getDesktopActivityOverlayWindowState(): Promise<DesktopActivityOverlayWindowStatePayload | null> {
    return invokeTauri<DesktopActivityOverlayWindowStatePayload | null>('desktop_activity_overlay_get_window_state');
}

export async function setDesktopActivityOverlayExpanded(expanded: boolean): Promise<void> {
    await invokeTauri<void>('desktop_activity_overlay_set_expanded', { expanded });
}

export async function applyDesktopActivityOverlayDragDelta(deltaX: number, deltaY: number): Promise<void> {
    await invokeTauri<void>('desktop_activity_overlay_apply_drag_delta', { deltaX, deltaY });
}

export async function resetDesktopActivityOverlayPosition(): Promise<void> {
    await invokeTauri<void>('desktop_activity_overlay_reset_position');
}

export async function emitDesktopActivityOverlayInteraction(payload: DesktopActivityOverlayInteractionPayload): Promise<void> {
    await invokeTauri<void>('desktop_activity_overlay_emit_interaction', { payload });
}

export async function listenDesktopActivityOverlayWindowState(
    handler: (payload: DesktopActivityOverlayWindowStatePayload) => void,
): Promise<() => void> {
    return listenTauriEvent<DesktopActivityOverlayWindowStatePayload>(DESKTOP_ACTIVITY_OVERLAY_EVENTS.state, handler);
}

export async function listenDesktopActivityOverlayInteraction(
    handler: (payload: DesktopActivityOverlayInteractionPayload) => void,
): Promise<() => void> {
    return listenTauriEvent<DesktopActivityOverlayInteractionPayload>(DESKTOP_ACTIVITY_OVERLAY_EVENTS.interaction, handler);
}
