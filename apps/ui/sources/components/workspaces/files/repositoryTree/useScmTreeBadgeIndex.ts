import * as React from 'react';
import { Platform } from 'react-native';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { createScmTreeBadgeIndex, type ScmTreeBadgeIndex } from './scmTreeBadges';

export function useScmTreeBadgeIndex(snapshot: ScmWorkingSnapshot | null | undefined): ScmTreeBadgeIndex | null {
    const [index, setIndex] = React.useState<ScmTreeBadgeIndex | null>(null);

    React.useEffect(() => {
        if (!snapshot) {
            setIndex(null);
            return;
        }

        let cancelled = false;
        const compute = () => {
            if (cancelled) return;
            setIndex(createScmTreeBadgeIndex(snapshot));
        };

        if (Platform.OS === 'web') {
            const handle = setTimeout(compute, 0);
            return () => {
                cancelled = true;
                clearTimeout(handle);
            };
        }

        compute();
        return () => {
            cancelled = true;
        };
    }, [snapshot]);

    return index;
}
