import * as React from 'react';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';

import {
    unwrapAppLockKeyWithPassword,
    unwrapAppLockKeyWithRecoveryKey,
} from './appLockCrypto';
import { readAppLockRecord, removeAppLockRecord, writeAppLockRecord, type AppLockRecord } from './appLockRecord';

/**
 * Canonical owner of this device's app-lock state.
 *
 * - `loading`: the stored record has not been read yet; nothing may render.
 * - `disabled`: no lock on this device.
 * - `locked`: the lock screen must cover everything. Before the first unlock the data key is not
 *   in memory, so sealed credentials cannot be read and the app cannot boot.
 * - `unlocked`: the data key is in memory and the app is usable.
 *
 * Re-locking a running app keeps the data key in memory (sync keeps working in the background);
 * the lock is a presentation gate that requires the password, fingerprint or a reset to lift.
 *
 * On web and desktop, windows of the same app (desktop pet overlay, extra windows, other tabs) follow
 * each other over a BroadcastChannel: locking one locks all, and unlocking one unlocks all.
 */
export type AppLockStatus = 'loading' | 'disabled' | 'locked' | 'unlocked';

export type AppLockSnapshot = Readonly<{
    status: AppLockStatus;
    record: AppLockRecord | null;
}>;

type PeerMessage =
    | { readonly t: 'lock' }
    | { readonly t: 'unlock'; readonly key: string }
    | { readonly t: 'request' }
    | { readonly t: 'record' };

const PEER_CHANNEL_NAME = 'happier-app-lock';

let snapshot: AppLockSnapshot = { status: 'loading', record: null };
let dataKey: Uint8Array | null = null;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
let peerChannel: BroadcastChannel | null | undefined;

function setSnapshot(next: AppLockSnapshot): void {
    if (next.status === snapshot.status && next.record === snapshot.record) return;
    snapshot = next;
    for (const listener of listeners) listener();
}

function getPeerChannel(): BroadcastChannel | null {
    if (peerChannel !== undefined) return peerChannel;
    if (typeof BroadcastChannel !== 'function') {
        peerChannel = null;
        return null;
    }
    try {
        peerChannel = new BroadcastChannel(PEER_CHANNEL_NAME);
        peerChannel.onmessage = (event: MessageEvent) => {
            void handlePeerMessage(event.data as PeerMessage);
        };
    } catch {
        peerChannel = null;
    }
    return peerChannel;
}

function postToPeers(message: PeerMessage): void {
    getPeerChannel()?.postMessage(message);
}

async function handlePeerMessage(message: PeerMessage | null | undefined): Promise<void> {
    if (!message || typeof message !== 'object') return;
    switch (message.t) {
        case 'lock':
            if (snapshot.status === 'unlocked') setSnapshot({ status: 'locked', record: snapshot.record });
            return;
        case 'unlock':
            if (snapshot.status === 'locked' && typeof message.key === 'string') {
                dataKey = decodeBase64(message.key);
                setSnapshot({ status: 'unlocked', record: snapshot.record });
            }
            return;
        case 'request':
            if (snapshot.status === 'unlocked' && dataKey) postToPeers({ t: 'unlock', key: encodeBase64(dataKey) });
            return;
        case 'record': {
            const record = await readAppLockRecord();
            if (!record) {
                dataKey = null;
                setSnapshot({ status: 'disabled', record: null });
                return;
            }
            setSnapshot({ status: snapshot.status === 'disabled' ? 'locked' : snapshot.status, record });
            return;
        }
    }
}

export function getAppLockSnapshot(): AppLockSnapshot {
    return snapshot;
}

export function subscribeAppLock(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useAppLockSnapshot(): AppLockSnapshot {
    return React.useSyncExternalStore(subscribeAppLock, getAppLockSnapshot, getAppLockSnapshot);
}

/** Reads the stored record once; later calls share the first load. */
export function loadAppLock(): Promise<void> {
    if (!loadPromise) {
        loadPromise = (async () => {
            const record = await readAppLockRecord();
            setSnapshot(record ? { status: 'locked', record } : { status: 'disabled', record: null });
            if (record) postToPeers({ t: 'request' });
        })();
    }
    return loadPromise;
}

/**
 * Sealing state for the credential store: when the lock is on, credentials must be sealed with
 * the data key, and they cannot be read or written while the key is not in memory.
 */
export function readAppLockCredentialSealing(): Readonly<{ enabled: false } | { enabled: true; dataKey: Uint8Array | null }> {
    if (snapshot.status === 'locked' || snapshot.status === 'unlocked') return { enabled: true, dataKey };
    return { enabled: false };
}

/** True when this device has the app lock turned on (locked or unlocked). */
export function isAppLockEnabled(): boolean {
    return snapshot.status === 'locked' || snapshot.status === 'unlocked';
}

export function getAppLockDataKey(): Uint8Array | null {
    return snapshot.status === 'unlocked' ? dataKey : null;
}

function completeUnlock(key: Uint8Array): void {
    dataKey = key;
    setSnapshot({ status: 'unlocked', record: snapshot.record });
    postToPeers({ t: 'unlock', key: encodeBase64(key) });
}

export async function unlockAppLockWithPassword(password: string): Promise<boolean> {
    const record = snapshot.record;
    if (snapshot.status !== 'locked' || !record) return false;
    const key = await unwrapAppLockKeyWithPassword(record.wrapped, password);
    if (!key) return false;
    completeUnlock(key);
    return true;
}

/** Verifies the password of an unlocked device (for changing settings) without changing state. */
export async function verifyAppLockPassword(password: string): Promise<boolean> {
    const record = snapshot.record;
    if (snapshot.status !== 'unlocked' || !record) return false;
    const verified = (await unwrapAppLockKeyWithPassword(record.wrapped, password)) !== null;
    // A prompt or derivation may outlive a re-lock or replacement of this device's record.
    return verified && snapshot.status === 'unlocked' && snapshot.record === record;
}

export async function unwrapAppLockDataKeyWithRecoveryKey(recoveryKey: string): Promise<Uint8Array | null> {
    const record = snapshot.record;
    if (!record) return null;
    return await unwrapAppLockKeyWithRecoveryKey(record.wrapped, recoveryKey);
}

/** Unlocks with a data key obtained another way (fingerprint, or a completed password reset). */
export function unlockAppLockWithDataKey(key: Uint8Array): void {
    if (snapshot.status !== 'locked') return;
    completeUnlock(key);
}

/**
 * Locks the app. A user's "Lock now" locks every window of the app; auto-lock passes
 * `{ allWindows: false }` because only the window that spent time hidden should lock.
 */
export function lockAppLock(options: Readonly<{ allWindows?: boolean }> = {}): void {
    if (snapshot.status !== 'unlocked') return;
    setSnapshot({ status: 'locked', record: snapshot.record });
    if (options.allWindows !== false) postToPeers({ t: 'lock' });
}

/** Turns the lock on with an already-unlocked data key. Callers re-seal stored credentials. */
export async function activateAppLock(record: AppLockRecord, key: Uint8Array): Promise<void> {
    await writeAppLockRecord(record);
    dataKey = key;
    setSnapshot({ status: 'unlocked', record });
    postToPeers({ t: 'record' });
    postToPeers({ t: 'unlock', key: encodeBase64(key) });
}

/** Saves a changed record (new password, email, timeout, fingerprint) without changing state. */
export async function updateAppLockRecord(record: AppLockRecord): Promise<void> {
    await writeAppLockRecord(record);
    setSnapshot({ status: snapshot.status, record });
    postToPeers({ t: 'record' });
}

/** Turns the lock off. Callers re-write stored credentials in plain form first. */
export async function deactivateAppLock(): Promise<void> {
    await removeAppLockRecord();
    dataKey = null;
    setSnapshot({ status: 'disabled', record: null });
    postToPeers({ t: 'record' });
}
