import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();
const SHOWCASE_SEEN_VERSION_KEY = 'onboarding-showcase-seen-version';
// This device was seen signed out with the tour unread: its next sign-in is a first one here, even across a reload.
const SHOWCASE_AWAITING_SIGN_IN_KEY = 'onboarding-showcase-awaiting-sign-in';
const listeners = new Set<() => void>();

function emitChanged(): void {
    for (const listener of listeners) listener();
}

export function getShowcaseSeenVersion(): string | null {
    return mmkv.getString(SHOWCASE_SEEN_VERSION_KEY) ?? null;
}

export function setShowcaseSeenVersion(version: string): void {
    mmkv.set(SHOWCASE_SEEN_VERSION_KEY, version);
    mmkv.delete(SHOWCASE_AWAITING_SIGN_IN_KEY);
    emitChanged();
}

export function clearShowcaseSeenVersion(): void {
    mmkv.delete(SHOWCASE_SEEN_VERSION_KEY);
    mmkv.delete(SHOWCASE_AWAITING_SIGN_IN_KEY);
    emitChanged();
}

export function isShowcaseAwaitingSignIn(): boolean {
    return mmkv.getBoolean(SHOWCASE_AWAITING_SIGN_IN_KEY) === true;
}

export function markShowcaseAwaitingSignIn(): void {
    mmkv.set(SHOWCASE_AWAITING_SIGN_IN_KEY, true);
}

export function subscribeShowcaseSeenVersion(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
