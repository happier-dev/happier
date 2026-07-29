import type { MachineLiveStreamCodecIdV1 } from '@happier-dev/protocol';

export type LiveStreamPlayerPlatform = 'web' | 'native' | 'desktop';

export type LiveStreamRendererKind =
    | 'mjpeg'
    | 'webcodecs'
    | 'mse'
    | 'wasm'
    | 'native-video'
    | 'fallback';

export type LiveStreamViewerCapabilities = Readonly<{
    platform: LiveStreamPlayerPlatform;
    renderers: readonly LiveStreamRendererKind[];
    supportedCodecs: readonly MachineLiveStreamCodecIdV1[];
    degradedReasonCodes: readonly string[];
}>;

export function resolveLiveStreamViewerCapabilities(input: Readonly<{
    platform: LiveStreamPlayerPlatform;
    renderers: Readonly<{
        mjpeg: boolean;
        webcodecs: boolean;
        mse: boolean;
        wasm: boolean;
        nativeVideo: boolean;
    }>;
    policy?: Readonly<{
        allowMse?: boolean;
        allowWasm?: boolean;
    }>;
}>): LiveStreamViewerCapabilities {
    const renderers: LiveStreamRendererKind[] = [];
    const supportedCodecs: MachineLiveStreamCodecIdV1[] = [];
    const degradedReasonCodes: string[] = [];

    if (input.renderers.mjpeg) {
        renderers.push('mjpeg');
        supportedCodecs.push('image.frame.v1');
        supportedCodecs.push('image.mjpeg');
    } else {
        degradedReasonCodes.push('mjpeg_renderer_unavailable');
    }

    let hasH264CapabilityLayer = false;
    if ((input.platform === 'web' || input.platform === 'desktop') && input.renderers.webcodecs) {
        renderers.push('webcodecs');
        hasH264CapabilityLayer = true;
    }
    if ((input.platform === 'web' || input.platform === 'desktop') && input.renderers.mse) {
        if (input.policy?.allowMse !== false) {
            renderers.push('mse');
            hasH264CapabilityLayer = true;
        } else {
            degradedReasonCodes.push('mse_policy_disabled');
        }
    }
    if ((input.platform === 'web' || input.platform === 'desktop') && input.renderers.wasm) {
        if (input.policy?.allowWasm === true) {
            renderers.push('wasm');
            hasH264CapabilityLayer = true;
        } else {
            degradedReasonCodes.push('wasm_policy_disabled');
        }
    }
    if ((input.platform === 'native' || input.platform === 'desktop') && input.renderers.nativeVideo) {
        renderers.push('native-video');
        hasH264CapabilityLayer = true;
    } else if (input.platform === 'native') {
        degradedReasonCodes.push('native_video_unavailable');
    }

    if (hasH264CapabilityLayer) {
        supportedCodecs.push('h264.avcc');
    }

    return {
        platform: input.platform,
        renderers,
        supportedCodecs,
        degradedReasonCodes,
    };
}
