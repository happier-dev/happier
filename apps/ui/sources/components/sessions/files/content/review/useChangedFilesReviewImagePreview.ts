import * as React from 'react';

import { sessionReadFile } from '@/sync/ops';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import { ImagePreviewCache } from './imagePreviewCache';

type PreviewState =
    | Readonly<{ status: 'disabled'; uri: null; error: null }>
    | Readonly<{ status: 'loading'; uri: null; error: null }>
    | Readonly<{ status: 'loaded'; uri: string; error: null }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

const imagePreviewCache = new ImagePreviewCache({
    maxEntries: 20,
    maxTotalBytes: 10 * 1024 * 1024,
    now: () => Date.now(),
});

export function useChangedFilesReviewImagePreview(input: Readonly<{
    sessionId: string;
    snapshotSignature?: string | null;
    filePath: string;
    enabled: boolean;
}>): PreviewState {
    const sessionId = input.sessionId;
    const snapshotSignature =
        typeof input.snapshotSignature === 'string' && input.snapshotSignature.trim().length > 0
            ? input.snapshotSignature.trim()
            : null;
    const filePath = input.filePath;
    const enabled = input.enabled === true;

    const mime = React.useMemo(() => getImageMimeTypeFromPath(filePath), [filePath]);
    const canCache = Boolean(snapshotSignature);

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

    const [state, setState] = React.useState<PreviewState>(() => {
        if (!enabled || !mime) return { status: 'disabled', uri: null, error: null };
        if (canCache) {
            const cached = imagePreviewCache.get({ sessionId, snapshotSignature: snapshotSignature!, filePath });
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

        if (canCache) {
            const cached = imagePreviewCache.get({ sessionId, snapshotSignature: snapshotSignature!, filePath });
            if (cached?.status === 'loaded') {
                setState({ status: 'loaded', uri: cached.uri, error: null });
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
                            { sessionId, snapshotSignature: snapshotSignature!, filePath },
                            { status: 'error', error: errorMessage },
                        );
                    }
                    setState({ status: 'error', uri: null, error: errorMessage });
                    return;
                }
                const uri = `data:${mime};base64,${res.content}`;
                const estimatedBytes = uri.length * 2;
                if (maxPreviewBytes > 0 && estimatedBytes > maxPreviewBytes) {
                    const errorMessage = t('files.imagePreviewTooLarge');
                    if (canCache) {
                        imagePreviewCache.set(
                            { sessionId, snapshotSignature: snapshotSignature!, filePath },
                            { status: 'error', error: errorMessage },
                        );
                    }
                    setState({ status: 'error', uri: null, error: errorMessage });
                    return;
                }

                if (canCache) {
                    imagePreviewCache.set(
                        { sessionId, snapshotSignature: snapshotSignature!, filePath },
                        { status: 'loaded', uri },
                    );
                }
                setState({ status: 'loaded', uri, error: null });
            } catch (err) {
                if (cancelled) return;
                const errorMessage = err instanceof Error ? err.message : t('files.fileReadFailed');
                if (canCache) {
                    imagePreviewCache.set(
                        { sessionId, snapshotSignature: snapshotSignature!, filePath },
                        { status: 'error', error: errorMessage },
                    );
                }
                setState({ status: 'error', uri: null, error: errorMessage });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [canCache, enabled, filePath, maxPreviewBytes, mime, sessionId, snapshotSignature]);

    return state;
}
