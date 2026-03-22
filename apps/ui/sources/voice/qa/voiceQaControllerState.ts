import { createVoiceQaFormatterPrefs, formatVoiceQaSessionLabel } from './formatVoiceQaSessionLabel';
import { useVoiceQaStore, type VoiceQaProvider } from './voiceQaStore';

export function beginVoiceQaRun(qaStore: typeof useVoiceQaStore, provider: VoiceQaProvider, sessionId: string): void {
    const store = qaStore.getState();
    const current = qaStore.getState();
    if (current.provider !== provider || current.sessionId !== sessionId) {
        store.clear();
    }
    store.begin(provider, sessionId);
}

export function resolveVoiceQaOperationalProvider(
    configuredProvider: VoiceQaProvider,
    current: ReturnType<typeof useVoiceQaStore.getState>,
    sessionId: string,
): VoiceQaProvider {
    if (current.status !== 'idle' && current.provider && current.sessionId === sessionId) {
        return current.provider;
    }
    return configuredProvider;
}

export function isVoiceQaTurnAbortedError(error: unknown): boolean {
    const err: any = error;
    if (err?.name === 'AbortError' && typeof err?.message === 'string' && err.message.includes('turn_aborted')) return true;
    if (typeof err?.message === 'string' && err.message.includes('turn_aborted')) return true;
    if (typeof err === 'string' && err.includes('turn_aborted')) return true;
    return false;
}

export function formatVoiceQaTargetLabel(sessionId: string, settings: unknown): string {
    const prefs = createVoiceQaFormatterPrefs(settings);
    return formatVoiceQaSessionLabel(sessionId, prefs, {
        emptyLabel: 'selected session',
        globalLabel: 'global voice agent',
        fallbackLabel: 'the selected session',
    });
}
