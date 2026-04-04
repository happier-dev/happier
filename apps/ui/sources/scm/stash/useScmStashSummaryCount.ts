import * as React from 'react';
import type { ScmStashEntry, ScmStashListResponse, ScmWorkingSnapshot } from '@happier-dev/protocol';

type ScmStashSummaryResponse = Pick<ScmStashListResponse, 'success' | 'stashes' | 'totalCount'>;

export function resolveSnapshotScmStashCount(snapshot: Pick<ScmWorkingSnapshot, 'stashCount'> | null): number {
    const value = snapshot?.stashCount;
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function resolveScmStashCount(input: Pick<ScmStashSummaryResponse, 'stashes' | 'totalCount'> | null | undefined): number {
    if (typeof input?.totalCount === 'number' && Number.isFinite(input.totalCount)) {
        return Math.max(0, Math.floor(input.totalCount));
    }
    return Array.isArray(input?.stashes) ? input.stashes.length : 0;
}

export function resolveScmStashEntries(input: Pick<ScmStashSummaryResponse, 'stashes'> | null | undefined): ScmStashEntry[] {
    return Array.isArray(input?.stashes) ? [...input.stashes] : [];
}

export function useScmStashSummaryCount(input: Readonly<{
    enabled: boolean;
    snapshotCount: number;
    refreshKey: string;
    load: () => Promise<ScmStashSummaryResponse>;
}>): number {
    const [stashCount, setStashCount] = React.useState(input.enabled ? input.snapshotCount : 0);

    React.useEffect(() => {
        if (!input.enabled) {
            setStashCount(0);
            return;
        }
        setStashCount(input.snapshotCount);
    }, [input.enabled, input.snapshotCount]);

    React.useEffect(() => {
        let active = true;
        if (!input.enabled) {
            setStashCount(0);
            return () => {
                active = false;
            };
        }

        void (async () => {
            try {
                const response = await input.load();
                if (!active) return;
                if (!response.success) {
                    setStashCount(input.snapshotCount);
                    return;
                }
                setStashCount(resolveScmStashCount(response));
            } catch {
                if (!active) return;
                setStashCount(input.snapshotCount);
            }
        })();

        return () => {
            active = false;
        };
    }, [input.enabled, input.load, input.refreshKey, input.snapshotCount]);

    return stashCount;
}
