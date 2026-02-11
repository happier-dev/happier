import { Platform } from 'react-native';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { storage } from '@/sync/domains/state/storage';
import type { LocalVoiceState } from './localVoiceEngine';

type DeviceSttHandle = {
    sessionId: string;
    transcript: string;
    isFinal: boolean;
    module: any;
    resolveEnd: () => void;
    endPromise: Promise<void>;
    subscriptions: { remove(): void }[];
};

let deviceStt: DeviceSttHandle | null = null;

export async function startDeviceSpeechRecognition(opts: {
    sessionId: string;
    setState: (patch: Partial<LocalVoiceState>) => void;
}): Promise<void> {
    const perm = await requestMicrophonePermission();
    if (!perm.granted) {
        showMicrophonePermissionDeniedAlert(perm.canAskAgain);
        return;
    }

    const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');

    if (
        typeof ExpoSpeechRecognitionModule?.isRecognitionAvailable === 'function' &&
        !ExpoSpeechRecognitionModule.isRecognitionAvailable()
    ) {
        opts.setState({ status: 'idle', sessionId: null, error: 'device_stt_unavailable' });
        return;
    }

    try {
        const res = await ExpoSpeechRecognitionModule.requestPermissionsAsync?.();
        if (res && res.granted === false) {
            opts.setState({ status: 'idle', sessionId: null, error: 'device_stt_permission_denied' });
            return;
        }
    } catch {
        // Permission request best-effort; start() may still work on web.
    }

    // Cleanup any previous listeners (single recognizer instance semantics).
    try {
        deviceStt?.subscriptions.forEach((s) => s.remove());
    } catch {
        // ignore
    }

    let resolveEnd: null | (() => void) = null;
    const endPromise = new Promise<void>((resolve) => {
        resolveEnd = resolve;
    });

    const handle: DeviceSttHandle = {
        sessionId: opts.sessionId,
        transcript: '',
        isFinal: false,
        module: ExpoSpeechRecognitionModule,
        resolveEnd: () => resolveEnd?.(),
        endPromise,
        subscriptions: [],
    };
    deviceStt = handle;

    handle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
            const results = Array.isArray(event?.results) ? event.results : [];
            const transcript = typeof results?.[0]?.transcript === 'string' ? results[0].transcript.trim() : '';
            if (!transcript) return;
            handle.transcript = transcript;
            if (event?.isFinal) handle.isFinal = true;
        }),
    );
    handle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('end', () => {
            handle.resolveEnd();
        }),
    );
    handle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('error', () => {
            handle.resolveEnd();
        }),
    );

    const settings: any = storage.getState().settings;
    const lang =
        typeof settings.voiceAssistantLanguage === 'string' && settings.voiceAssistantLanguage.trim()
            ? settings.voiceAssistantLanguage.trim()
            : undefined;

    try {
        ExpoSpeechRecognitionModule.start({
            ...(lang ? { lang } : {}),
            interimResults: true,
            maxAlternatives: 1,
            continuous: true,
        } as any);
    } catch (e) {
        deviceStt = null;
        opts.setState({ status: 'idle', sessionId: null, error: 'device_stt_start_failed' });
        throw e;
    }

    opts.setState({ status: 'recording', sessionId: opts.sessionId, error: null });
}

export async function stopDeviceSpeechRecognitionAndSend(opts: {
    sessionId: string;
    setState: (patch: Partial<LocalVoiceState>) => void;
    sendVoiceTextTurn: (sessionId: string, settings: any, userText: string) => Promise<void>;
}): Promise<void> {
    if (!deviceStt || deviceStt.sessionId !== opts.sessionId) {
        opts.setState({ status: 'idle', sessionId: null });
        return;
    }

    opts.setState({ status: 'transcribing', error: null });

    try {
        deviceStt.module?.stop?.();
    } catch {
        // ignore
    }

    await Promise.race([deviceStt.endPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);

    const text = deviceStt.transcript.trim();
    const subs = deviceStt.subscriptions;
    deviceStt = null;
    try {
        subs.forEach((s) => s.remove());
    } catch {
        // ignore
    }

    if (!text) {
        opts.setState({ status: 'idle', sessionId: null });
        return;
    }

    const settings = storage.getState().settings as any;
    await opts.sendVoiceTextTurn(opts.sessionId, settings, text);
}

