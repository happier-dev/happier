import * as React from 'react';

import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';

export function useDiffFilesExpansionState(params: Readonly<{
    files: readonly DiffFileEntry[];
    defaultExpanded: boolean;
}>): Readonly<{
    expandedKeys: ReadonlySet<string>;
    allExpanded: boolean;
    setAllExpanded: (expanded: boolean) => void;
    toggleExpanded: (key: string) => void;
}> {
    const files = params.files;
    const defaultExpanded = params.defaultExpanded;

    const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(() => new Set());
    const keysFingerprint = React.useMemo(() => files.map((f) => f.key).join('|'), [files]);

    React.useEffect(() => {
        setExpandedKeys((prev) => {
            const next = new Set<string>();
            const keys = new Set(files.map((f) => f.key));
            for (const key of prev) {
                if (keys.has(key)) next.add(key);
            }

            if (defaultExpanded) {
                for (const key of keys) next.add(key);
            }

            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [defaultExpanded, keysFingerprint]);

    const allExpanded = files.length > 0 && files.every((f) => expandedKeys.has(f.key));

    const setAllExpanded = React.useCallback(
        (expanded: boolean) => {
            setExpandedKeys(() => {
                if (!expanded) return new Set();
                return new Set(files.map((f) => f.key));
            });
        },
        [files],
    );

    const toggleExpanded = React.useCallback((key: string) => {
        setExpandedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    return {
        expandedKeys,
        allExpanded,
        setAllExpanded,
        toggleExpanded,
    };
}
