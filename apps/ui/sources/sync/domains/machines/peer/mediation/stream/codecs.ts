import {
    negotiateMachineLiveStreamCodecV1,
    type MachineLiveStreamCodecIdV1,
    type MachineLiveStreamCodecNegotiationResultV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';

export function resolveMachineLiveStreamCodecPreference(input: Readonly<{
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    viewerCodecs: readonly MachineLiveStreamCodecIdV1[];
    preferredCodec?: MachineLiveStreamCodecIdV1;
}>): MachineLiveStreamCodecNegotiationResultV1 {
    return negotiateMachineLiveStreamCodecV1(input);
}
