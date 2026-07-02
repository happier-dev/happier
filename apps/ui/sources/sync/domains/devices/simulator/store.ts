import type {
    MachineLiveStreamControlLeaseV1,
    MachineLiveStreamFrameV1,
    SimulatorSidebandKindV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol';

export type SimulatorPreviewState = Readonly<{
    phase: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';
    lastFrame: MachineLiveStreamFrameV1 | null;
    activeLease?: MachineLiveStreamControlLeaseV1 | null;
    sidebandsByKind?: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>>;
    reasonCode?: string;
}>;

export type SimulatorPreviewStateEvent =
    | Readonly<{ type: 'connecting' }>
    | Readonly<{ type: 'frame'; frame: MachineLiveStreamFrameV1 }>
    | Readonly<{ type: 'reconnecting'; reasonCode?: string }>
    | Readonly<{ type: 'error'; reasonCode: string }>
    | Readonly<{ type: 'stopped'; reasonCode?: string }>
    | Readonly<{ type: 'lease_acquired'; lease: MachineLiveStreamControlLeaseV1 }>
    | Readonly<{ type: 'lease_released'; leaseId: string }>
    | Readonly<{ type: 'sideband'; message: SimulatorSidebandMessageV1 }>;

export function reduceSimulatorPreviewState(
    state: SimulatorPreviewState,
    event: SimulatorPreviewStateEvent,
): SimulatorPreviewState {
    switch (event.type) {
        case 'connecting':
            return { ...state, phase: 'connecting', reasonCode: undefined };
        case 'frame':
            return { ...state, phase: 'connected', lastFrame: event.frame, reasonCode: undefined };
        case 'reconnecting':
            return { ...state, phase: 'reconnecting', lastFrame: state.lastFrame, reasonCode: event.reasonCode };
        case 'error':
            return { ...state, phase: 'error', lastFrame: state.lastFrame, reasonCode: event.reasonCode };
        case 'stopped':
            return { ...state, phase: 'stopped', lastFrame: state.lastFrame, reasonCode: event.reasonCode };
        case 'lease_acquired':
            return { ...state, activeLease: event.lease };
        case 'lease_released':
            return state.activeLease?.leaseId === event.leaseId ? { ...state, activeLease: null } : state;
        case 'sideband':
            return {
                ...state,
                sidebandsByKind: {
                    ...(state.sidebandsByKind ?? {}),
                    [event.message.kind]: event.message,
                },
            };
    }
}
