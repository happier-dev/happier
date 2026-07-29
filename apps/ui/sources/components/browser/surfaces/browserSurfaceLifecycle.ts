export type BrowserSurfaceRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

export type BrowserPresentationSlotState = Readonly<{
    presentationSlotId: string;
    visible: boolean;
    active: boolean;
    measuredRect?: BrowserSurfaceRect | null;
}>;

export type BrowserLogicalViewState = 'open' | 'suspended' | 'closed';
export type BrowserSurfaceHostAvailability = 'available' | 'host_lost' | 'adapter_recovering' | 'live_state_lost';
export type BrowserSurfaceLifecycleState = 'visible' | 'hidden' | 'parked' | 'suspended' | 'orphaned' | 'closed';

export type BrowserSurfaceLifecycleSnapshot = Readonly<{
    logicalViewId: string;
    lifecycleState: BrowserSurfaceLifecycleState;
    slotsById: Readonly<Record<string, BrowserPresentationSlotState>>;
    cleanupReason: string | null;
}>;

function hasPaintableRect(slot: BrowserPresentationSlotState): boolean {
    const rect = slot.measuredRect;
    return !!rect && rect.width > 0 && rect.height > 0;
}

export function resolveBrowserSurfaceLifecycleState(input: Readonly<{
    logicalViewState: BrowserLogicalViewState;
    slot: BrowserPresentationSlotState | null;
    hostAvailability: BrowserSurfaceHostAvailability;
}>): BrowserSurfaceLifecycleState {
    if (input.logicalViewState === 'closed') {
        return 'closed';
    }
    if (input.logicalViewState === 'suspended' || input.hostAvailability !== 'available') {
        return 'suspended';
    }
    if (!input.slot) {
        return 'orphaned';
    }
    if (!input.slot.visible) {
        return 'hidden';
    }
    return hasPaintableRect(input.slot) ? 'visible' : 'parked';
}

function choosePresentationSlot(
    slots: readonly BrowserPresentationSlotState[],
): BrowserPresentationSlotState | null {
    return slots.find((slot) => slot.visible && slot.active)
        ?? slots.find((slot) => slot.visible)
        ?? slots.find((slot) => slot.active)
        ?? slots[0]
        ?? null;
}

function createDormantPresentationSlot(
    slot: BrowserPresentationSlotState,
): BrowserPresentationSlotState {
    return {
        ...slot,
        visible: false,
        active: false,
    };
}

export function reconcileBrowserPresentationSlots(input: Readonly<{
    logicalViewId: string;
    previous?: BrowserSurfaceLifecycleSnapshot | null;
    nextSlots: readonly BrowserPresentationSlotState[];
    hostAvailability: BrowserSurfaceHostAvailability;
    logicalViewState?: BrowserLogicalViewState;
}>): BrowserSurfaceLifecycleSnapshot {
    const slotsById: Record<string, BrowserPresentationSlotState> = {};
    const canCarryPreviousSlots = input.previous?.logicalViewId === input.logicalViewId
        && (input.logicalViewState ?? 'open') !== 'closed';
    if (canCarryPreviousSlots && input.previous) {
        for (const slot of Object.values(input.previous.slotsById)) {
            slotsById[slot.presentationSlotId] = createDormantPresentationSlot(slot);
        }
    }
    for (const slot of input.nextSlots) {
        slotsById[slot.presentationSlotId] = slot;
    }
    const logicalViewState = input.logicalViewState ?? 'open';
    const lifecycleState = resolveBrowserSurfaceLifecycleState({
        logicalViewState,
        slot: choosePresentationSlot(input.nextSlots),
        hostAvailability: input.hostAvailability,
    });
    return {
        logicalViewId: input.logicalViewId,
        lifecycleState,
        slotsById,
        cleanupReason: lifecycleState === 'closed'
            ? 'logical_view_closed'
            : input.previous?.logicalViewId === input.logicalViewId
                ? input.previous.cleanupReason
                : null,
    };
}
