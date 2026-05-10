import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const SHOWCASE_SEEN_VERSION_KEY = 'onboarding-showcase-seen-version';
const showcaseSeenVersionListeners = new Set<() => void>();

function emitShowcaseSeenVersionChanged(): void {
    for (const listener of showcaseSeenVersionListeners) {
        listener();
    }
}

export function getShowcaseSeenVersion(): string | null {
    return mmkv.getString(SHOWCASE_SEEN_VERSION_KEY) ?? null;
}

export function setShowcaseSeenVersion(version: string): void {
    mmkv.set(SHOWCASE_SEEN_VERSION_KEY, version);
    emitShowcaseSeenVersionChanged();
}

export function clearShowcaseSeenVersion(): void {
    mmkv.delete(SHOWCASE_SEEN_VERSION_KEY);
    emitShowcaseSeenVersionChanged();
}

export function subscribeShowcaseSeenVersion(listener: () => void): () => void {
    showcaseSeenVersionListeners.add(listener);
    return () => {
        showcaseSeenVersionListeners.delete(listener);
    };
}
