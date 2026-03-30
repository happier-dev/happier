import * as React from 'react';

import { sessionReadFile } from '@/sync/ops';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { decodeBase64 } from '@/encryption/base64';

import { ImagePreviewCache } from './imagePreviewCache';

export type SessionImagePreviewState =
    | Readonly<{ status: 'disabled'; uri: null; error: null }>
    | Readonly<{ status: 'loading'; uri: null; error: null }>
    | Readonly<{ status: 'loaded'; uri: string; svgXml: string | null; error: null }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

const imagePreviewCache = new ImagePreviewCache({
    maxEntries: 20,
    maxTotalBytes: 10 * 1024 * 1024,
    now: () => Date.now(),
});

function resolveImageMimeType(input: Readonly<{ filePath: string; mimeType?: string | null }>): string | null {
    const raw = typeof input.mimeType === 'string' && input.mimeType.trim().length > 0 ? input.mimeType.trim() : null;
    const resolved = raw ?? getImageMimeTypeFromPath(input.filePath);
    if (!resolved || !resolved.startsWith('image/')) return null;
    return resolved;
}

function decodeSvgXmlIfNeeded(input: Readonly<{ mime: string; base64: string }>): string | null {
    if (input.mime !== 'image/svg+xml') return null;
    try {
        const bytes = decodeBase64(input.base64, 'base64');
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return null;
    }
}

export function useSessionImagePreview(input: Readonly<{
    sessionId: string;
    filePath: string;
    enabled: boolean;
    cacheKey?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
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

    const mime = React.useMemo(() => resolveImageMimeType({ filePath, mimeType: input.mimeType }), [filePath, input.mimeType]);
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
        if (canCache) {
            const cached = imagePreviewCache.get({ sessionId, signature: cacheKey!, filePath });
            if (cached?.status === 'loaded') return { status: 'loaded', uri: cached.uri, svgXml: cached.svgXml ?? null, error: null };
            if (cached?.status === 'error') return { status: 'error', uri: null, error: cached.error };
        }
        return { status: 'loading', uri: null, error: null };
    });

    React.useEffect(() => {
        if (!enabled || !mime) {
            setState({ status: 'disabled', uri: null, error: null });
            return;
        }

        const tooLarge =
            maxPreviewBytes > 0 &&
            sizeBytes != null &&
            sizeBytes > maxPreviewBytes;
        if (tooLarge) {
            const errorMessage = t('files.imagePreviewTooLarge');
            if (canCache) {
                imagePreviewCache.set(
                    { sessionId, signature: cacheKey!, filePath },
                    { status: 'error', error: errorMessage },
                );
            }
            setState({ status: 'error', uri: null, error: errorMessage });
            return;
        }

        if (canCache) {
            const cached = imagePreviewCache.get({ sessionId, signature: cacheKey!, filePath });
            if (cached?.status === 'loaded') {
                setState({ status: 'loaded', uri: cached.uri, svgXml: cached.svgXml ?? null, error: null });
                return;
            }
            if (cached?.status === 'error') {
                setState({ status: 'error', uri: null, error: cached.error });
                return;
            }
        }

        let cancelled = false;
        setState({ status: 'loading', uri: null, error: null });

        void (async () => {
            try {
                const res = await sessionReadFile(sessionId, filePath);
                if (cancelled) return;
                if (!res.success || typeof res.content !== 'string' || res.content.trim().length === 0) {
                    const err = (res as any)?.error;
                    const errorMessage = typeof err === 'string' && err.trim().length > 0 ? err : t('files.fileReadFailed');
                    if (canCache) {
                        imagePreviewCache.set(
                            { sessionId, signature: cacheKey!, filePath },
                            { status: 'error', error: errorMessage },
                        );
                    }
                    setState({ status: 'error', uri: null, error: errorMessage });
                    return;
                }
                const uri = `data:${mime};base64,${res.content}`;
                const svgXml = decodeSvgXmlIfNeeded({ mime, base64: res.content });
                const estimatedBytes = uri.length * 2;
                if (maxPreviewBytes > 0 && estimatedBytes > maxPreviewBytes) {
                    const errorMessage = t('files.imagePreviewTooLarge');
                    if (canCache) {
                        imagePreviewCache.set(
                            { sessionId, signature: cacheKey!, filePath },
                            { status: 'error', error: errorMessage },
                        );
                    }
                    setState({ status: 'error', uri: null, error: errorMessage });
                    return;
                }

                if (canCache) {
                    imagePreviewCache.set(
                        { sessionId, signature: cacheKey!, filePath },
                        { status: 'loaded', uri, svgXml },
                    );
                }
                setState({ status: 'loaded', uri, svgXml, error: null });
            } catch (err) {
                if (cancelled) return;
                const errorMessage = err instanceof Error ? err.message : t('files.fileReadFailed');
                if (canCache) {
                    imagePreviewCache.set(
                        { sessionId, signature: cacheKey!, filePath },
                        { status: 'error', error: errorMessage },
                    );
                }
                setState({ status: 'error', uri: null, error: errorMessage });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [cacheKey, canCache, enabled, filePath, maxPreviewBytes, mime, sessionId, sizeBytes]);

    return state;
}
