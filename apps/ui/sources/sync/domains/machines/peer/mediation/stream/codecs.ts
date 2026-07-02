import {
    negotiateMachineLiveStreamCodecV1,
    type MachineLiveStreamCodecIdV1,
    type MachineLiveStreamCodecNegotiationResultV1,
} from '@happier-dev/protocol';

export function resolveMachineLiveStreamCodecPreference(input: Readonly<{
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    viewerCodecs: readonly MachineLiveStreamCodecIdV1[];
    preferredCodec?: MachineLiveStreamCodecIdV1;
}>): MachineLiveStreamCodecNegotiationResultV1 {
    return negotiateMachineLiveStreamCodecV1(input);
}

export type MachineLiveStreamAvccFallbackState = Readonly<{
    streamed: boolean;
    fellBackToMjpeg: boolean;
}>;

export type MachineLiveStreamAvccFallbackEvent =
    | Readonly<{ type: 'frame' }>
    | Readonly<{ type: 'startup_timeout' }>
    | Readonly<{ type: 'reset' }>;

export const initialMachineLiveStreamAvccFallbackState: MachineLiveStreamAvccFallbackState = {
    streamed: false,
    fellBackToMjpeg: false,
};

export function reduceMachineLiveStreamAvccFallbackState(
    state: MachineLiveStreamAvccFallbackState,
    event: MachineLiveStreamAvccFallbackEvent,
): MachineLiveStreamAvccFallbackState {
    switch (event.type) {
        case 'frame':
            return state.streamed ? state : { ...state, streamed: true };
        case 'startup_timeout':
            return state.streamed || state.fellBackToMjpeg ? state : { ...state, fellBackToMjpeg: true };
        case 'reset':
            return initialMachineLiveStreamAvccFallbackState;
    }
}
