import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

export type MachineLiveStreamRenderPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

export type MachineLiveStreamRenderState = Readonly<{
    phase: MachineLiveStreamRenderPhase;
    lastFrame: MachineLiveStreamFrameV1 | null;
    diagnostic?: Readonly<{ reasonCode: string }>;
}>;

export type MachineLiveStreamRenderEvent =
    | Readonly<{ type: 'connecting' }>
    | Readonly<{ type: 'frame'; frame: MachineLiveStreamFrameV1 }>
    | Readonly<{ type: 'reconnecting'; reasonCode: string }>
    | Readonly<{ type: 'error'; reasonCode: string }>
    | Readonly<{ type: 'stopped'; reasonCode?: string }>;

export function reduceMachineLiveStreamRenderState(
    state: MachineLiveStreamRenderState,
    event: MachineLiveStreamRenderEvent,
): MachineLiveStreamRenderState {
    switch (event.type) {
        case 'connecting':
            return { ...state, phase: 'connecting', diagnostic: undefined };
        case 'frame':
            return { phase: 'connected', lastFrame: event.frame };
        case 'reconnecting':
            return {
                phase: 'reconnecting',
                lastFrame: state.lastFrame,
                diagnostic: { reasonCode: event.reasonCode },
            };
        case 'error':
            return {
                phase: 'error',
                lastFrame: state.lastFrame,
                diagnostic: { reasonCode: event.reasonCode },
            };
        case 'stopped':
            return {
                phase: 'stopped',
                lastFrame: state.lastFrame,
                ...(event.reasonCode ? { diagnostic: { reasonCode: event.reasonCode } } : {}),
            };
    }
}
