import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import type { NativeVadBridge } from './NativeVadController';

const NATIVE_SILERO_VAD_SPEECH_END_EVENT = 'vadSpeechEnd';

type NativeSileroVadSubscription = Readonly<{
    remove: () => void;
}>;

type NativeSileroVadNativeModule = Readonly<{
    addListener: (
        eventName: typeof NATIVE_SILERO_VAD_SPEECH_END_EVENT,
        listener: (event: unknown) => void,
    ) => NativeSileroVadSubscription;
    startVadSession: (params: Readonly<{
        minSpeechMs: number;
        redemptionMs: number;
        sessionId: string;
    }>) => void | Promise<void>;
    stopVadSession: (params: Readonly<{
        sessionId: string;
    }>) => void | Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNativeSileroVadNativeModule(value: unknown): value is NativeSileroVadNativeModule {
    if (!isRecord(value)) {
        return false;
    }

    return (
        typeof value.addListener === 'function'
        && typeof value.startVadSession === 'function'
        && typeof value.stopVadSession === 'function'
    );
}

function normalizeSpeechEndEventSessionId(event: unknown): string | null {
    if (!isRecord(event)) {
        return null;
    }

    return normalizeNonEmptyString(event.sessionId);
}

async function getOptionalSherpaNativeModule(): Promise<unknown> {
    try {
        const mod = await import('@happier-dev/sherpa-native') as unknown;
        if (!isRecord(mod)) {
            return null;
        }

        const getter = mod.getOptionalHappierSherpaNativeModule;
        if (typeof getter !== 'function') {
            return null;
        }

        return (getter as () => unknown)();
    } catch {
        return null;
    }
}

export async function resolveNativeSileroVadBridge(
    nativeModule?: unknown,
): Promise<NativeVadBridge | null> {
    const resolvedNativeModule = nativeModule === undefined
        ? await getOptionalSherpaNativeModule()
        : nativeModule;

    if (!isNativeSileroVadNativeModule(resolvedNativeModule)) {
        return null;
    }

    return {
        startSession: async ({ minSpeechMs, onSpeechEnd, redemptionMs, sessionId }) => {
            const subscription = resolvedNativeModule.addListener(
                NATIVE_SILERO_VAD_SPEECH_END_EVENT,
                (event) => {
                    if (normalizeSpeechEndEventSessionId(event) !== sessionId) {
                        return;
                    }

                    onSpeechEnd();
                },
            );
            let nativeSessionStarted = false;

            try {
                await resolvedNativeModule.startVadSession({
                    minSpeechMs,
                    redemptionMs,
                    sessionId,
                });
                nativeSessionStarted = true;
            } catch (error) {
                subscription.remove();
                throw error;
            }

            let stopped = false;
            return {
                stop: async () => {
                    if (stopped) {
                        return;
                    }
                    stopped = true;
                    subscription.remove();

                    if (nativeSessionStarted) {
                        await resolvedNativeModule.stopVadSession({ sessionId });
                    }
                },
            };
        },
    };
}
