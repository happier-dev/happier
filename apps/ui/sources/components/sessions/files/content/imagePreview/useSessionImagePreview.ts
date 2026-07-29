import * as React from 'react';

import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { createSessionFilePreviewSource, type SessionFilePreviewSource } from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';

import { ImagePreviewCache } from '@/components/workspaces/files/imagePreview/imagePreviewCache';

export type SessionImagePreviewState =
    | Readonly<{ status: 'disabled'; uri: null; error: null }>
    | Readonly<{ status: 'loading'; uri: null; error: null }>
    | Readonly<{ status: 'loaded'; uri: string; error: null }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

const imagePreviewCache = new ImagePreviewCache({
    maxEntries: 32,
    maxTotalBytes: 96 * 1024 * 1024,
    now: () => Date.now(),
});

function resolvePreviewMimeType(input: Readonly<{ filePath: string; mimeType?: string | null }>): string | null {
    const raw = typeof input.mimeType === 'string' && input.mimeType.trim().length > 0 ? input.mimeType.trim() : null;
    const resolved = (raw ?? getImageMimeTypeFromPath(input.filePath))?.toLowerCase();
    if (
        resolved !== 'image/png'
        && resolved !== 'image/jpeg'
        && resolved !== 'image/webp'
        && resolved !== 'image/gif'
        && resolved !== 'video/webm'
    ) {
        return null;
    }
    return resolved;
}

function cleanupPreviewSource(source: SessionFilePreviewSource): () => void | Promise<void> {
    if (source.kind === 'object-url') {
        return () => source.revoke();
    }
    return async () => {
        await source.delete();
    };
}

export function useSessionImagePreview(input: Readonly<{
    sessionId: string;
    filePath: string;
    enabled: boolean;
    cacheKey?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    workspaceScope?: WorkspaceScopeBase | null;
    cacheScopeId?: string | null;
}>): SessionImagePreviewState {
    const sessionId = input.sessionId;
    const filePath = input.filePath;
    const enabled = input.enabled === true;
    const cacheKey =
        typeof input.cacheKey === 'string' && input.cacheKey.trim().length > 0
            ? input.cacheKey.trim()
            : null;
    const sizeBytes =
        typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes)
            ? Math.max(0, input.sizeBytes)
            : null;
    const providedScope = input.workspaceScope ?? null;
    const resolvedSessionScope = useSessionWorkspaceTarget(enabled && !providedScope ? sessionId : null);
    const resolvedScopeInput = providedScope ?? resolvedSessionScope;
    const resolvedScope = React.useMemo<WorkspaceScopeBase | null>(() => {
        if (!resolvedScopeInput) return null;
        return {
            serverId: resolvedScopeInput.serverId,
            machineId: resolvedScopeInput.machineId,
            rootPath: resolvedScopeInput.rootPath,
        };
    }, [
        resolvedScopeInput?.machineId,
        resolvedScopeInput?.rootPath,
        resolvedScopeInput?.serverId,
    ]);
    const cacheScopeId = (() => {
        const explicit = typeof input.cacheScopeId === 'string' && input.cacheScopeId.trim().length > 0
            ? input.cacheScopeId.trim()
            : null;
        return explicit ?? (resolvedSessionScope?.workspaceCacheKey ?? sessionId);
    })();

    const mime = React.useMemo(() => resolvePreviewMimeType({ filePath, mimeType: input.mimeType }), [filePath, input.mimeType]);
    const canCache = Boolean(cacheKey);

    const cacheMaxEntriesSetting = useSetting('filesImagePreviewCacheMaxEntries');
    const cacheMaxTotalBytesSetting = useSetting('filesImagePreviewCacheMaxTotalBytes');
    const maxPreviewBytesSetting = useSetting('filesImagePreviewMaxBytes');

    const cacheLimits = React.useMemo(() => {
        const maxEntries = typeof cacheMaxEntriesSetting === 'number' && Number.isFinite(cacheMaxEntriesSetting)
            ? Math.max(0, cacheMaxEntriesSetting)
            : 0;
        const maxTotalBytes = typeof cacheMaxTotalBytesSetting === 'number' && Number.isFinite(cacheMaxTotalBytesSetting)
            ? Math.max(0, cacheMaxTotalBytesSetting)
            : 0;
        return { maxEntries, maxTotalBytes };
    }, [cacheMaxEntriesSetting, cacheMaxTotalBytesSetting]);

    const maxPreviewBytes = React.useMemo(() => {
        const raw = typeof maxPreviewBytesSetting === 'number' && Number.isFinite(maxPreviewBytesSetting) ? maxPreviewBytesSetting : 0;
        return Math.max(0, raw);
    }, [maxPreviewBytesSetting]);
    const lastAppliedLimitsRef = React.useRef<typeof cacheLimits | null>(null);
    const lastLoadedRef = React.useRef<Readonly<{
        identity: string;
        uri: string;
    }> | null>(null);
    React.useEffect(() => {
        const last = lastAppliedLimitsRef.current;
        if (last && last.maxEntries === cacheLimits.maxEntries && last.maxTotalBytes === cacheLimits.maxTotalBytes) {
            return;
        }
        imagePreviewCache.setLimits(cacheLimits);
        lastAppliedLimitsRef.current = cacheLimits;
    }, [cacheLimits]);

    const [state, setState] = React.useState<SessionImagePreviewState>(() => {
        if (!enabled || !mime) return { status: 'disabled', uri: null, error: null };
        if (!resolvedScope) return { status: 'loading', uri: null, error: null };
        if (canCache) {
            const cached = imagePreviewCache.get({ sessionId: cacheScopeId, signature: cacheKey!, filePath });
            if (cached?.status === 'loaded') return { status: 'loaded', uri: cached.uri, error: null };
            if (cached?.status === 'error') return { status: 'error', uri: null, error: cached.error };
        }
        return { status: 'loading', uri: null, error: null };
    });

    React.useEffect(() => {
        if (!enabled || !mime) {
            setState({ status: 'disabled', uri: null, error: null });
            return;
        }
        if (!resolvedScope) {
            setState({ status: 'loading', uri: null, error: null });
            return;
        }
        const previewIdentity = `${cacheScopeId}\u0000${filePath}`;

        const tooLarge =
            maxPreviewBytes > 0 &&
            sizeBytes != null &&
            sizeBytes > maxPreviewBytes;
        if (tooLarge) {
            const errorMessage = t('files.imagePreviewTooLarge');
            if (canCache) {
                imagePreviewCache.set(
                    { sessionId: cacheScopeId, signature: cacheKey!, filePath },
                    { status: 'error', error: errorMessage },
                );
            }
            setState({ status: 'error', uri: null, error: errorMessage });
            return;
        }

        if (canCache) {
            const cached = imagePreviewCache.get({ sessionId: cacheScopeId, signature: cacheKey!, filePath });
            if (cached?.status === 'loaded') {
                lastLoadedRef.current = {
                    identity: previewIdentity,
                    uri: cached.uri,
                };
                setState({ status: 'loaded', uri: cached.uri, error: null });
                return;
            }
            if (cached?.status === 'error') {
                setState({ status: 'error', uri: null, error: cached.error });
                return;
            }
        }

        let cancelled = false;
        let uncachedCleanup: (() => void | Promise<void>) | null = null;
        const previousLoaded = lastLoadedRef.current?.identity === previewIdentity ? lastLoadedRef.current : null;
        if (!previousLoaded) {
            setState({ status: 'loading', uri: null, error: null });
        }

        void (async () => {
            try {
                const res = await createSessionFilePreviewSource({
                    scope: resolvedScope,
                    filePath,
                    mimeType: mime,
                    maxBytes: maxPreviewBytes,
                    expectedSizeBytes: sizeBytes,
                    cacheIdentity: cacheKey,
                });
                if (!res.ok) {
                    if (cancelled) return;
                    const errorMessage = res.error || t('files.fileReadFailed');
                    if (canCache && !previousLoaded) {
                        imagePreviewCache.set(
                            { sessionId: cacheScopeId, signature: cacheKey!, filePath },
                            { status: 'error', error: errorMessage },
                        );
                    }
                    if (previousLoaded) {
                        setState({ status: 'loaded', uri: previousLoaded.uri, error: null });
                    } else {
                        setState({ status: 'error', uri: null, error: errorMessage });
                    }
                    return;
                }

                const source = res.source;
                if (cancelled) {
                    await cleanupPreviewSource(source)();
                    return;
                }
                const cleanup = cleanupPreviewSource(source);

                if (canCache) {
                    imagePreviewCache.set(
                        { sessionId: cacheScopeId, signature: cacheKey!, filePath },
                        { status: 'loaded', uri: source.uri, cleanup, byteLength: source.byteLength },
                    );
                } else {
                    uncachedCleanup = cleanup;
                }
                lastLoadedRef.current = {
                    identity: previewIdentity,
                    uri: source.uri,
                };
                setState({ status: 'loaded', uri: source.uri, error: null });
            } catch (err) {
                if (cancelled) return;
                const errorMessage = err instanceof Error ? err.message : t('files.fileReadFailed');
                if (canCache && !previousLoaded) {
                    imagePreviewCache.set(
                        { sessionId: cacheScopeId, signature: cacheKey!, filePath },
                        { status: 'error', error: errorMessage },
                        );
                    }
                if (previousLoaded) {
                    setState({ status: 'loaded', uri: previousLoaded.uri, error: null });
                } else {
                    setState({ status: 'error', uri: null, error: errorMessage });
                }
            }
        })();

        return () => {
            cancelled = true;
            if (uncachedCleanup) {
                try {
                    void Promise.resolve(uncachedCleanup()).catch(() => undefined);
                } catch {}
            }
        };
    }, [cacheKey, cacheScopeId, canCache, enabled, filePath, maxPreviewBytes, mime, resolvedScope, sizeBytes]);

    return state;
}
