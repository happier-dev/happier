import type {
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionTypeV1,
    SimulatorPreviewActionV1,
} from '@happier-dev/protocol';

export type SimulatorControlSendAction = Extract<SimulatorPreviewActionV1, { type: 'simulator.control.send' }>;

export const DEFAULT_SIMULATOR_SWIPE_DURATION_MS = 250;
export const DEFAULT_SIMULATOR_LONG_PRESS_DURATION_MS = 500;

function eventType(event: SimulatorPreviewActionV1): SimulatorPreviewActionTypeV1 {
    return event.type;
}

export function acceptedSimulatorInputResult(
    event: SimulatorPreviewActionV1,
    diagnostics: readonly Record<string, unknown>[] = [],
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: eventType(event),
        status: 'accepted',
        diagnostics: [...diagnostics],
    };
}

export function rejectedSimulatorInputResult(
    event: SimulatorPreviewActionV1,
    reasonCode: string,
    diagnostics: readonly Record<string, unknown>[] = [],
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: eventType(event),
        status: 'rejected',
        reasonCode,
        diagnostics: [...diagnostics],
    };
}

export function unavailableSimulatorInputResult(
    event: SimulatorPreviewActionV1,
    reasonCode: string,
    diagnostics: readonly Record<string, unknown>[] = [],
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: eventType(event),
        status: 'unavailable',
        reasonCode,
        diagnostics: [...diagnostics],
    };
}

export function readSimulatorControlSendAction(
    event: SimulatorPreviewActionV1,
): SimulatorControlSendAction | null {
    return event.type === 'simulator.control.send' ? event : null;
}
