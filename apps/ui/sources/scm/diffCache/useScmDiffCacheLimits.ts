import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';

import type { ScmDiffCache } from './scmDiffCache';

export function useScmDiffCacheLimits(cache: ScmDiffCache | null) {
    const maxEntriesSetting = useSetting('scmDiffCacheMaxEntries');
    const maxTotalBytesSetting = useSetting('scmDiffCacheMaxTotalBytes');

    const maxEntries = React.useMemo(() => {
        const raw = typeof maxEntriesSetting === 'number' && Number.isFinite(maxEntriesSetting) ? maxEntriesSetting : 0;
        return Math.max(0, raw);
    }, [maxEntriesSetting]);

    const maxTotalBytes = React.useMemo(() => {
        const raw = typeof maxTotalBytesSetting === 'number' && Number.isFinite(maxTotalBytesSetting) ? maxTotalBytesSetting : 0;
        return Math.max(0, raw);
    }, [maxTotalBytesSetting]);

    const lastAppliedRef = React.useRef<Readonly<{ maxEntries: number; maxTotalBytes: number }> | null>(null);

    React.useEffect(() => {
        if (!cache) return;
        const next = { maxEntries, maxTotalBytes };
        const last = lastAppliedRef.current;
        if (last && last.maxEntries === next.maxEntries && last.maxTotalBytes === next.maxTotalBytes) {
            return;
        }
        cache.setLimits(next);
        lastAppliedRef.current = next;
    }, [cache, maxEntries, maxTotalBytes]);
}
