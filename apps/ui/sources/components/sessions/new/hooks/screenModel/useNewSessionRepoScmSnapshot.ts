import * as React from 'react';
import { useFocusEffect } from '@react-navigation/native';

import { scmRepositoryService } from '@/scm/scmRepositoryService';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export function useNewSessionRepoScmSnapshot(input: Readonly<{
    machineId: string | null;
    path: string;
}>): ScmWorkingSnapshot | null {
    const [snapshot, setSnapshot] = React.useState<ScmWorkingSnapshot | null>(() => {
        const machineId = input.machineId?.trim() ?? '';
        const path = input.path.trim();
        if (!machineId || !path) {
            return null;
        }
        return scmRepositoryService.readCachedSnapshotForMachinePath({
            machineId,
            path,
        });
    });

    const refreshSnapshot = React.useCallback(() => {
        const machineId = input.machineId?.trim() ?? '';
        const path = input.path.trim();
        if (!machineId || !path) {
            setSnapshot(null);
            return () => {};
        }

        let cancelled = false;
        const cachedSnapshot = scmRepositoryService.readCachedSnapshotForMachinePath({
            machineId,
            path,
        });
        setSnapshot(cachedSnapshot);

        void (async () => {
            try {
                const nextSnapshot = await scmRepositoryService.fetchSnapshotForMachinePath({
                    machineId,
                    path,
                });
                if (!cancelled) {
                    setSnapshot(nextSnapshot);
                }
            } catch (_error) {
                if (!cancelled) {
                    setSnapshot(cachedSnapshot);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [input.machineId, input.path]);

    React.useEffect(() => {
        return refreshSnapshot();
    }, [refreshSnapshot]);

    useFocusEffect(refreshSnapshot);

    return snapshot;
}
