import type { MicSession } from '@/voice/runtime/mic/MicSession';

import type { TurnEndpointSignal } from './TurnEndpointController';
import type { TurnPolicy } from './turnPolicyMachine';

type WebVadControllerDeps = Readonly<{
    now?: () => number;
    onEndpointSignal: (signal: TurnEndpointSignal) => void;
    onSpeechCandidateStart?: (input: Readonly<{ sessionId: string; source: 'web_vad' }>) => void;
    onSpeechCandidateFalseAlarm?: (input: Readonly<{ sessionId: string; source: 'web_vad' }>) => void;
    turnPolicy?: Partial<TurnPolicy>;
    getLatestPartialTranscript?: () => string | null | undefined;
}>;

type StartWebVadSessionArgs = Readonly<{
    minSpeechMs: number;
    redemptionMs: number;
    sessionId: string;
    micSession?: MicSession | null;
}>;

export type WebVadController = Readonly<{
    isActiveSession: (sessionId: string | null | undefined) => boolean;
    startSession: (args: StartWebVadSessionArgs) => Promise<boolean>;
    stopSession: (sessionId?: string | null) => Promise<void>;
}>;

/**
 * Native/default fallback for the browser-only `@ricky0123/vad-web` engine.
 * The real implementation (which dynamically imports `@ricky0123/vad-web` ->
 * `onnxruntime-web`) lives in `WebVadController.web.ts` and is resolved by
 * Metro only when bundling for `platform: "web"`. Without this platform
 * split, Metro's static bundler eagerly pulled the whole `vad-web` ->
 * `onnxruntime-web` dependency tree into the iOS/Android bundle even though
 * it was never reachable at runtime there — `onnxruntime-web`'s wasm loader
 * uses webpack-only dynamic-import syntax Metro's transform can't parse,
 * failing the native bundle compile entirely.
 *
 * This stub reproduces the exact behavior the real controller already had on
 * non-DOM runtimes (its internal `isDomRuntime()` guard made every method a
 * no-op there), so native callers observe no behavior change.
 */
export function createWebVadController(_deps: WebVadControllerDeps): WebVadController {
    return {
        isActiveSession: () => false,
        startSession: async () => false,
        stopSession: async () => {},
    };
}
