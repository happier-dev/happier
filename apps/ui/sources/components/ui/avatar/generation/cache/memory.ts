import { LruMap } from '@/utils/cache/lruMap';

const avatarXmlCache = new LruMap<string, string>({ maxEntries: 192 });
const avatarRasterCache = new LruMap<string, string>({ maxEntries: 192 });

export function readAvatarXmlFromMemory(key: string): string | null {
    return avatarXmlCache.get(key) ?? null;
}

export function writeAvatarXmlToMemory(key: string, xml: string): void {
    avatarXmlCache.set(key, xml);
}

export function readAvatarRasterFromMemory(key: string): string | null {
    return avatarRasterCache.get(key) ?? null;
}

export function writeAvatarRasterToMemory(key: string, dataUri: string): void {
    avatarRasterCache.set(key, dataUri);
}
