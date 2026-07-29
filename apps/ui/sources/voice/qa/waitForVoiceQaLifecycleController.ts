import type { VoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';

type WaitForVoiceQaLifecycleControllerParams<TController = VoiceSessionLifecycleController> = Readonly<{
    getController: () => TController | null;
    isReady?: (controller: TController) => boolean;
    now?: () => number;
    timeoutMs?: number;
    wait?: (waitMs: number) => Promise<void>;
}>;

/**
 * The QA route is a sibling of the runtime owner, and under StrictMode/HMR its
 * controls can become interactive one render before that owner's layout effect
 * publishes the controller. Wait only for the canonical owner to exist; never
 * create a QA-owned lifecycle controller or synthesize a session snapshot.
 */
export async function waitForVoiceQaLifecycleController<TController>(
    params: WaitForVoiceQaLifecycleControllerParams<TController>,
): Promise<TController> {
    const now = params.now ?? (() => Date.now());
    const timeoutMs = Math.max(0, params.timeoutMs ?? 10_000);
    const wait = params.wait ?? ((waitMs: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
    }));
    const deadline = now() + timeoutMs;

    while (true) {
        const controller = params.getController();
        if (controller && (params.isReady?.(controller) ?? true)) {
            return controller;
        }
        if (now() >= deadline) {
            throw new Error('voice_qa_media_lifecycle_unavailable');
        }
        await wait(25);
    }
}
