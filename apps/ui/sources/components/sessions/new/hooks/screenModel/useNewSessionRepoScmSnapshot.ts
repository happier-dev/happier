import * as React from 'react';
import { useFocusEffect } from '@react-navigation/native';

import {
    mergeWorktreesEnrichmentIntoSnapshot,
    scmRepositoryService,
} from '@/scm/scmRepositoryService';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

/**
 * Fetches the SCM snapshot in TWO stages so the worktree picker chip can render
 * within sub-second latency even on repos with many active worktrees:
 *
 * 1. **Light fetch** (`fetchSnapshotForMachinePath` with NO `includeWorktreeStatus`).
 *    This returns the repo + branch + worktree-list quickly; the chip becomes
 *    visible as soon as this completes.
 * 2. **Background enrichment** (`fetchWorktreesEnrichment`). Once the light
 *    snapshot is in, we kick off the per-worktree `changeCount` +
 *    `lastActivityAt` fetch and merge it into the snapshot when it arrives.
 *    The merge produces a new snapshot reference so consumers re-render with
 *    the augmented data without losing the light-snapshot rows.
 *
 * Both layers have INDEPENDENT cache slots inside `scmRepositoryService` so a
 * background enrichment refresh never invalidates the light data driving the
 * chip. Stale-while-revalidate is implemented per layer (cached value returned
 * immediately, refresh happens in the background).
 */
export function useNewSessionRepoScmSnapshot(input: Readonly<{
    machineId: string | null;
    path: string;
}>): ScmWorkingSnapshot | null {
    const [snapshot, setSnapshot] = React.useState<ScmWorkingSnapshot | null>(() => {
        const machineId = input.machineId?.trim() ?? '';
        const path = input.path.trim();
        if (!machineId || !path) return null;
        const light = scmRepositoryService.readCachedSnapshotForMachinePath({
            machineId,
            path,
        });
        if (!light) return null;
        const enrichment = scmRepositoryService.readCachedWorktreesEnrichment({
            machineId,
            path,
        });
        return enrichment ? mergeWorktreesEnrichmentIntoSnapshot(light, enrichment) : light;
    });

    const refreshSnapshot = React.useCallback(() => {
        const machineId = input.machineId?.trim() ?? '';
        const path = input.path.trim();
        if (!machineId || !path) {
            setSnapshot(null);
            return () => {};
        }

        let cancelled = false;
        const cachedLight = scmRepositoryService.readCachedSnapshotForMachinePath({
            machineId,
            path,
        });
        const cachedEnrichment = scmRepositoryService.readCachedWorktreesEnrichment({
            machineId,
            path,
        });
        const seededSnapshot = cachedLight && cachedEnrichment
            ? mergeWorktreesEnrichmentIntoSnapshot(cachedLight, cachedEnrichment)
            : cachedLight;
        setSnapshot(seededSnapshot);

        void (async () => {
            try {
                // STAGE 1: Light fetch (fast).
                const lightSnapshot = await scmRepositoryService.fetchSnapshotForMachinePath({
                    machineId,
                    path,
                });
                if (cancelled) return;
                // Apply any cached enrichment immediately so the chip doesn't
                // lose its accessories while the background refresh runs.
                const lightWithCachedEnrichment = lightSnapshot && cachedEnrichment
                    ? mergeWorktreesEnrichmentIntoSnapshot(lightSnapshot, cachedEnrichment)
                    : lightSnapshot;
                setSnapshot(lightWithCachedEnrichment);

                // STAGE 2: Background enrichment for the freshly listed worktrees.
                const worktreePaths = lightSnapshot?.repo.worktrees?.map((w) => w.path) ?? [];
                if (worktreePaths.length === 0) return;

                const enrichment = await scmRepositoryService.fetchWorktreesEnrichment({
                    machineId,
                    path,
                    worktreePaths,
                });
                if (cancelled || !enrichment || !lightSnapshot) return;
                setSnapshot(mergeWorktreesEnrichmentIntoSnapshot(lightSnapshot, enrichment));
            } catch (_error) {
                if (!cancelled) {
                    setSnapshot(seededSnapshot);
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
