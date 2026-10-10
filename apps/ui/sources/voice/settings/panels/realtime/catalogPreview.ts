import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { acquireVoicePlaybackAudioMode, type VoiceAudioModeLease } from '@/voice/runtime/voiceAudioMode';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceCatalogRow } from './voiceCatalog';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createVoicePlaybackController, type VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';

export type VoiceCatalogPreviewSynthesizer = (input: Readonly<{
    row: VoiceCatalogRow;
    signal: AbortSignal;
    isCurrent(): boolean;
    registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}>) => Promise<void>;

type PreviewSnapshot = Readonly<{ providerId: string; voiceId: string }>;
let snapshot: PreviewSnapshot | null = null;
let preview: Readonly<{
    stop(): void;
    releaseAudioMode: () => Promise<void>;
    detachAbort: () => void;
}> | null = null;
let generation = 0;
const listeners = new Set<() => void>();
function publish(next: PreviewSnapshot | null) { snapshot = next; for (const listener of listeners) listener(); }
export const readRealtimeCatalogPreview = () => snapshot;
export function subscribeRealtimeCatalogPreview(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** The incumbent settings catalog player, shared with the Action Stop operation. */
export function stopRealtimeCatalogPreview(providerId: string): boolean {
    if (snapshot?.providerId !== providerId) return false;
    generation += 1;
    const previous = preview;
    preview = null;
    try { previous?.stop(); } catch { /* playback boundary */ }
    previous?.detachAbort();
    if (previous) fireAndForget(previous.releaseAudioMode().catch(() => {}), { tag: 'RealtimeCatalogPreview.releaseAudioMode' });
    publish(null);
    return true;
}

export async function playRealtimeCatalogPreview(input: Readonly<{
    providerId: string;
    row: VoiceCatalogRow;
    signal?: AbortSignal;
    isCurrent(): boolean;
    subscribeCurrent?(listener: () => void): () => void;
    synthesize?: VoiceCatalogPreviewSynthesizer;
}>): Promise<SettingOperationResult> {
    if (!input.row.previewUrl && !input.synthesize) return { status: 'unavailable', reason: 'voice_preview_unavailable' };
    if (input.signal?.aborted || !input.isCurrent()) return { status: 'cancelled' };
    if (snapshot) stopRealtimeCatalogPreview(snapshot.providerId);
    const attempt = ++generation;
    const current = () => generation === attempt && !input.signal?.aborted && input.isCurrent();
    publish({ providerId: input.providerId, voiceId: input.row.id });
    const stop = () => { if (generation === attempt) stopRealtimeCatalogPreview(input.providerId); };
    input.signal?.addEventListener('abort', stop, { once: true });
    const accountRetirement = captureActiveServerAccountScopeLifetime()?.onRetire(stop);
    const unsubscribeCurrent = input.subscribeCurrent?.(() => { if (!current()) stop(); });
    const detachAbort = () => {
        input.signal?.removeEventListener('abort', stop);
        accountRetirement?.dispose();
        unsubscribeCurrent?.();
    };
    let lease: VoiceAudioModeLease | null = null;
    let transferred = false;
    try {
        if (!current()) { stop(); return { status: 'cancelled' }; }
        if (!input.row.previewUrl && input.synthesize) {
            // Local speech already owns its playback audio-mode lease. Custody and Stop
            // still belong to this one preview owner, including synthesis in flight.
            const controller = new AbortController();
            const playback = createVoicePlaybackController();
            preview = { stop: () => { controller.abort(); playback.interrupt(); },
                releaseAudioMode: async () => {}, detachAbort };
            transferred = true;
            await input.synthesize({ row: input.row, signal: controller.signal, isCurrent: current,
                registerPlaybackStopper: playback.registerStopper.captureAttempt!() });
            const completed = current();
            stop();
            return completed ? { status: 'completed', value: { voiceId: input.row.id, started: true } }
                : { status: 'cancelled' };
        }
        lease = await acquireVoicePlaybackAudioMode('realtime-catalog-preview');
        if (!current()) { stop(); return { status: 'cancelled' }; }
        const { createAudioPlayer } = await import('expo-audio');
        if (!current()) { stop(); return { status: 'cancelled' }; }
        const player = createAudioPlayer(input.row.previewUrl, { keepAudioSessionActive: true });
        if (!current()) { player.remove(); stop(); return { status: 'cancelled' }; }
        const subscription = player.addListener('playbackStatusUpdate', status => { if (status.didJustFinish) stop(); });
        preview = { stop: () => { try { subscription.remove(); } finally { player.remove(); } },
            releaseAudioMode: lease.release, detachAbort };
        lease = null;
        transferred = true;
        player.play();
        return { status: 'completed', value: { voiceId: input.row.id, started: true } };
    } catch {
        const cancelled = !current();
        stop();
        return cancelled ? { status: 'cancelled' } : { status: 'unavailable', reason: 'voice_preview_playback_failed' };
    } finally {
        if (!transferred) detachAbort();
        if (lease) await lease.release().catch(() => {});
    }
}
