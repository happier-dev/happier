import { hasRemoteImageConsent, type RemoteImageConsentV1 } from '@/sync/domains/settings/remoteImageConsent';
import { createPersistentUiState, UiStatePersistenceError } from './persistentUiState';
import { subscribePersistenceStorageCleared } from './persistenceStorage';

/** Only an explicit true grants permission to load this document's remote images. */
export const markdownImageConsentState = createPersistentUiState('markdown-remote-image-consent-v1', value => value === true);
const importedKeys = new Set<string>();
subscribePersistenceStorageCleared(() => importedKeys.clear());

/** Import only the requested document, before its first subscription; retained Settings stay untouched. */
export function importMarkdownImageConsent(
    workspaceCacheKey: string,
    filePath: string,
    readRetained: () => RemoteImageConsentV1,
): string {
    const key = JSON.stringify([workspaceCacheKey, filePath]);
    if (importedKeys.has(key)) return key;
    try {
        if (markdownImageConsentState.readStrict(key) === undefined
            && hasRemoteImageConsent(readRetained(), workspaceCacheKey, filePath)) {
            markdownImageConsentState.set(key, true);
        }
        importedKeys.add(key);
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[markdown] Remote image consent could not be imported.');
    }
    return key;
}

export function allowMarkdownRemoteImages(key: string): void {
    try { markdownImageConsentState.set(key, true); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[markdown] Remote image consent could not be persisted.');
    }
}
