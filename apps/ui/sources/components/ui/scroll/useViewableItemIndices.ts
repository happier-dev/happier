import * as React from 'react';

import { createAdvancedDebounce } from '@/utils/timing/debounce';

export function useViewableItemIndices(input: Readonly<{
    enabled: boolean;
    debounceMs: number;
}>) {
    const enabled = input.enabled === true;
    const debounceMs = React.useMemo(() => {
        const raw = typeof input.debounceMs === 'number' && Number.isFinite(input.debounceMs) ? input.debounceMs : 0;
        return Math.max(0, Math.floor(raw));
    }, [input.debounceMs]);

    const [viewableIndices, setViewableIndices] = React.useState<readonly number[]>([]);
    const commit = React.useCallback((indices: readonly number[]) => {
        setViewableIndices((prev) => {
            if (prev.length === indices.length) {
                let same = true;
                for (let i = 0; i < prev.length; i++) {
                    if (prev[i] !== indices[i]) {
                        same = false;
                        break;
                    }
                }
                if (same) return prev;
            }
            return indices;
        });
    }, []);

    const debouncedCommit = React.useMemo(() => {
        return createAdvancedDebounce<readonly number[]>(
            (indices) => commit(indices),
            { delay: debounceMs, immediateCount: 1 },
        );
    }, [commit, debounceMs]);
    React.useEffect(() => () => debouncedCommit.cancel(), [debouncedCommit]);

    const onViewableItemsChanged = React.useCallback((info: any) => {
        if (!enabled) return;
        const viewableItems = Array.isArray(info?.viewableItems) ? info.viewableItems : [];
        const indices: number[] = [];
        for (const item of viewableItems) {
            const index = item?.index;
            if (typeof index === 'number' && Number.isFinite(index)) {
                indices.push(index);
            }
        }
        indices.sort((a, b) => a - b);
        for (let i = indices.length - 1; i > 0; i--) {
            if (indices[i] === indices[i - 1]) indices.splice(i, 1);
        }
        debouncedCommit.debounced(indices);
    }, [debouncedCommit, enabled]);

    return { viewableIndices, onViewableItemsChanged };
}
