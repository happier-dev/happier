import * as React from 'react';
import { Platform } from 'react-native';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildScmTreeBadgeSignature, createScmTreeBadgeIndex, type ScmTreeBadgeIndex } from './scmTreeBadges';

export function useScmTreeBadgeIndex(snapshot: ScmWorkingSnapshot | null | undefined): ScmTreeBadgeIndex | null {
    const [index, setIndex] = React.useState<ScmTreeBadgeIndex | null>(null);
    const badgeSignature = buildScmTreeBadgeSignature(snapshot);
    const snapshotRef = React.useRef(snapshot);
    snapshotRef.current = snapshot;

    const nativeIndex = React.useMemo(() => {
        if (!snapshot) return null;
        return createScmTreeBadgeIndex(snapshot);
    }, [badgeSignature, snapshot]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!snapshot) {
            setIndex(null);
            return;
        }

        let cancelled = false;
        const compute = () => {
            if (cancelled) return;
            setIndex(createScmTreeBadgeIndex(snapshotRef.current));
        };

        const handle = setTimeout(compute, 0);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [badgeSignature, snapshot]);

    return Platform.OS === 'web' ? index : nativeIndex;
}
