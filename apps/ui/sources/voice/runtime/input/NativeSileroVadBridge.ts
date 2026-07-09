import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import type { NativeVadBridge } from './NativeVadController';

const NATIVE_SILERO_VAD_SPEECH_END_EVENT = 'vadSpeechEnd';
const NATIVE_SILERO_VAD_SPEECH_START_EVENT = 'vadSpeechStart';

type NativeSileroVadSubscription = Readonly<{
    remove: () => void;
}>;

type NativeSileroVadEventName =
    | typeof NATIVE_SILERO_VAD_SPEECH_END_EVENT
    | typeof NATIVE_SILERO_VAD_SPEECH_START_EVENT;

type NativeSileroVadNativeModule = Readonly<{
    addListener: (
        eventName: NativeSileroVadEventName,
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
        startSession: async ({ minSpeechMs, onSpeechEnd, onSpeechStart, redemptionMs, sessionId }) => {
            const subscriptions: NativeSileroVadSubscription[] = [];
            subscriptions.push(resolvedNativeModule.addListener(
                NATIVE_SILERO_VAD_SPEECH_END_EVENT,
                (event) => {
                    if (normalizeSpeechEndEventSessionId(event) !== sessionId) {
                        return;
                    }

                    onSpeechEnd();
                },
            ));
            if (onSpeechStart) {
                // Optional speech-START edge for the two-stage hysteresis machine.
                // Native modules that do not emit it simply never fire this listener.
                subscriptions.push(resolvedNativeModule.addListener(
                    NATIVE_SILERO_VAD_SPEECH_START_EVENT,
                    (event) => {
                        if (normalizeSpeechEndEventSessionId(event) !== sessionId) {
                            return;
                        }

                        onSpeechStart();
                    },
                ));
            }
            const removeSubscriptions = () => {
                subscriptions.forEach((subscription) => subscription.remove());
            };
            let nativeSessionStarted = false;

            try {
                await resolvedNativeModule.startVadSession({
                    minSpeechMs,
                    redemptionMs,
                    sessionId,
                });
                nativeSessionStarted = true;
            } catch (error) {
                removeSubscriptions();
                throw error;
            }

            let stopped = false;
            return {
                stop: async () => {
                    if (stopped) {
                        return;
                    }
                    stopped = true;
                    removeSubscriptions();

                    if (nativeSessionStarted) {
                        await resolvedNativeModule.stopVadSession({ sessionId });
                    }
                },
            };
        },
    };
}
