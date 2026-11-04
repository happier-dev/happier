import { useSyncExternalStore } from 'react';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { readNativeCaptureState, subscribeNativeCapture, type NativeCaptureSnapshot } from './nativeCapture';

// This is a boolean projection of the native capture owner, never recorder detection.
// Several mounted lists share one native watch; duration ticks publish no change.
let active: boolean | null = null;
const listeners = new Set<() => void>();
let disconnect: (() => void) | undefined;

// Deliberate presentation intent, local to this client lifetime. This is not
// detection of another application's sharing state and is never Account data.
let sharingPrivacyActive = false;
const sharingListeners = new Set<() => void>();
export const readScreenSharingPrivacyActive = (): boolean => sharingPrivacyActive;
export function subscribeScreenSharingPrivacyActive(listener: () => void): () => void {
    sharingListeners.add(listener);
    return () => { sharingListeners.delete(listener); };
}
export function setScreenSharingPrivacyActive(next: boolean): void {
    if (next === sharingPrivacyActive) return;
    sharingPrivacyActive = next;
    for (const listener of sharingListeners) listener();
}

function publish(snapshot: NativeCaptureSnapshot): void {
    const next = snapshot.status === 'recording'
        && snapshot.recording.phase !== 'ready' && snapshot.recording.phase !== 'failed';
    if (next === active) return;
    active = next;
    for (const listener of listeners) listener();
}

function connect(): () => void {
    let closed = false;
    let pushed = false;
    let stop: (() => void) | undefined;
    void subscribeNativeCapture(snapshot => {
        if (closed) return;
        pushed = true;
        publish(snapshot);
    }).then(async unsubscribe => {
        if (closed) { unsubscribe(); return; }
        stop = unsubscribe;
        const snapshot = await readNativeCaptureState();
        if (!closed && !pushed) publish(snapshot);
    }).catch(() => {
        // Unknown native state keeps opted-in tags private; a later push can recover.
    });
    return () => { closed = true; stop?.(); };
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) disconnect = connect();
    return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        disconnect?.();
        disconnect = undefined;
        active = null;
    };
}

const readActive = () => active !== false;
const readInactive = () => false;
const subscribeInactive = () => () => {};

/** Imperative presentation consumers share the same native watch and unknown-state policy. */
export function readCapturePrivacyActive(): boolean {
    return sharingPrivacyActive || (desktopHostKind() === 'tauri' && readActive());
}

export function subscribeCapturePrivacyActive(listener: () => void): () => void {
    const stopNative = desktopHostKind() === 'tauri' ? subscribe(listener) : undefined;
    const stopSharing = subscribeScreenSharingPrivacyActive(listener);
    return () => { stopNative?.(); stopSharing(); };
}

/** Only opted-in Tauri lists demand native state; unknown state keeps their chosen tags private. */
export function useNativeRecordingActive(enabled: boolean): boolean {
    const supported = enabled && desktopHostKind() === 'tauri';
    return useSyncExternalStore(supported ? subscribe : subscribeInactive, supported ? readActive : readInactive, readInactive);
}

export function useScreenSharingPrivacyActive(): boolean {
    return useSyncExternalStore(subscribeScreenSharingPrivacyActive, readScreenSharingPrivacyActive, readInactive);
}

/** One presentation decision for every list, from native recording or explicit sharing intent. */
export function useCapturePrivacyActive(enabled: boolean): boolean {
    return useSyncExternalStore(enabled ? subscribeCapturePrivacyActive : subscribeInactive,
        enabled ? readCapturePrivacyActive : readInactive, readInactive);
}
