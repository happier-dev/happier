import type { SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { acquireVoicePlaybackAudioMode, type VoiceAudioModeLease } from '@/voice/runtime/voiceAudioMode';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceCatalogRow } from './voiceCatalog';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type PreviewSnapshot = Readonly<{ providerId: string; voiceId: string }>;
let snapshot: PreviewSnapshot | null = null;
let preview: Readonly<{
    player: ReturnType<typeof import('expo-audio')['createAudioPlayer']>;
    subscription: Readonly<{ remove(): void }>;
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
    try { previous?.subscription.remove(); } catch { /* player boundary */ }
    try { previous?.player.remove(); } catch { /* player boundary */ }
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
}>): Promise<SettingOperationResult> {
    if (!input.row.previewUrl) return { status: 'unavailable', reason: 'voice_preview_unavailable' };
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
        lease = await acquireVoicePlaybackAudioMode('realtime-catalog-preview');
        if (!current()) { stop(); return { status: 'cancelled' }; }
        const { createAudioPlayer } = await import('expo-audio');
        if (!current()) { stop(); return { status: 'cancelled' }; }
        const player = createAudioPlayer(input.row.previewUrl, { keepAudioSessionActive: true });
        if (!current()) { player.remove(); stop(); return { status: 'cancelled' }; }
        const subscription = player.addListener('playbackStatusUpdate', status => { if (status.didJustFinish) stop(); });
        preview = { player, subscription, releaseAudioMode: lease.release, detachAbort };
        lease = null;
        transferred = true;
        player.play();
        return { status: 'completed', value: { voiceId: input.row.id, started: true } };
    } catch {
        stop();
        return input.signal?.aborted || !input.isCurrent() ? { status: 'cancelled' } : { status: 'unavailable', reason: 'voice_preview_playback_failed' };
    } finally {
        if (!transferred) detachAbort();
        if (lease) await lease.release().catch(() => {});
    }
}
