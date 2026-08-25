import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();
const SHOWCASE_SEEN_VERSION_KEY = 'onboarding-showcase-seen-version';
const listeners = new Set<() => void>();

function emitChanged(): void {
    for (const listener of listeners) listener();
}

export function getShowcaseSeenVersion(): string | null {
    return mmkv.getString(SHOWCASE_SEEN_VERSION_KEY) ?? null;
}

export function setShowcaseSeenVersion(version: string): void {
    mmkv.set(SHOWCASE_SEEN_VERSION_KEY, version);
    emitChanged();
}

export function clearShowcaseSeenVersion(): void {
    mmkv.delete(SHOWCASE_SEEN_VERSION_KEY);
    emitChanged();
}

export function subscribeShowcaseSeenVersion(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
