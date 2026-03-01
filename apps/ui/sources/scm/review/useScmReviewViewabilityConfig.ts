import * as React from 'react';
import { Platform } from 'react-native';

import { useSetting } from '@/sync/domains/state/storage';

export type ScmReviewViewabilityConfig = Readonly<{
    enabled: boolean;
    aheadCount: number;
    behindCount: number;
    debounceMs: number;
}>;

export function useScmReviewViewabilityConfig(): ScmReviewViewabilityConfig {
    const prefetchAheadWeb = useSetting('scmReviewPrefetchAheadCountWeb');
    const prefetchBehindWeb = useSetting('scmReviewPrefetchBehindCountWeb');
    const prefetchAheadNative = useSetting('scmReviewPrefetchAheadCountNative');
    const prefetchBehindNative = useSetting('scmReviewPrefetchBehindCountNative');
    const prefetchDebounceMsSetting = useSetting('scmReviewPrefetchDebounceMs');

    const aheadCount = Platform.OS === 'web' ? prefetchAheadWeb : prefetchAheadNative;
    const behindCount = Platform.OS === 'web' ? prefetchBehindWeb : prefetchBehindNative;

    const enabled = (
        typeof aheadCount === 'number' && Number.isFinite(aheadCount)
        && typeof behindCount === 'number' && Number.isFinite(behindCount)
        && typeof prefetchDebounceMsSetting === 'number' && Number.isFinite(prefetchDebounceMsSetting)
    );

    return React.useMemo(() => ({
        enabled,
        aheadCount: enabled ? Math.max(0, Math.floor(aheadCount as number)) : 0,
        behindCount: enabled ? Math.max(0, Math.floor(behindCount as number)) : 0,
        debounceMs: enabled ? Math.max(0, Math.floor(prefetchDebounceMsSetting as number)) : 0,
    }), [aheadCount, behindCount, enabled, prefetchDebounceMsSetting]);
}
