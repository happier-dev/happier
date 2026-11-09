import * as React from 'react';
import { useFocusEffect } from '@react-navigation/native';

import {
    mergeWorktreesEnrichmentIntoSnapshot,
    scmRepositoryService,
} from '@/scm/scmRepositoryService';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { pathBelongsToRepo } from '@/components/sessions/new/modules/worktreePathComparison';

/**
 * Fetches the SCM snapshot in TWO stages so the worktree picker chip can render
 * within sub-second latency even on repos with many active worktrees:
 *
 * 1. **Light fetch** (`fetchSnapshotForMachinePath` with NO `includeWorktreeStatus` and
 *    `detail: 'facts'`: ref queries only, no working-copy scan and no changed-file list).
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
    serverId?: string | null;
    machineId: string | null;
    path: string;
    machineHomeDir?: string | null;
    machinePlatform?: string | null;
    /**
     * `false`: show only the cached snapshot and never ask the machine. An embedded composer
     * (Home) passes `false` until the person shows intent to use it.
     */
    enabled?: boolean;
}>): ScmWorkingSnapshot | null {
    const fetchEnabled = input.enabled !== false;
    const [snapshot, setSnapshot] = React.useState<ScmWorkingSnapshot | null>(() => {
        const machineId = input.machineId?.trim() ?? '';
        const path = input.path.trim();
        if (!machineId || !path) return null;
        const light = scmRepositoryService.readCachedSnapshotForMachinePath({
            ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
            machineId,
            path,
            ...(input.machineHomeDir !== undefined ? { homeDir: input.machineHomeDir } : {}),
            detail: 'facts',
        });
        if (!light) return null;
        const enrichment = scmRepositoryService.readCachedWorktreesEnrichment({
            ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
            machineId,
            path,
            ...(input.machineHomeDir !== undefined ? { homeDir: input.machineHomeDir } : {}),
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
            ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
            machineId,
            path,
            ...(input.machineHomeDir !== undefined ? { homeDir: input.machineHomeDir } : {}),
            detail: 'facts',
        });
        const cachedEnrichment = scmRepositoryService.readCachedWorktreesEnrichment({
            ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
            machineId,
            path,
            ...(input.machineHomeDir !== undefined ? { homeDir: input.machineHomeDir } : {}),
        });
        const seededFromCache = cachedLight && cachedEnrichment
            ? mergeWorktreesEnrichmentIntoSnapshot(cachedLight, cachedEnrichment)
            : cachedLight;
        // Seed the snapshot for this path. When the new path has no cache of its
        // own BUT belongs to the SAME repository as the snapshot we're already
        // showing (e.g. the user just switched the checkout to a sibling
        // worktree), keep that snapshot instead of resetting to null: a repo's
        // `git worktree list` is repo-wide and identical across its worktrees, so
        // a reset would only flash the chip's worktree list empty for one
        // round-trip until the new path's light fetch lands. (Honors the UI rule
        // against flashing empty states for already-hydrated lists.)
        const applySeed = () => {
            setSnapshot((previous) => {
                if (seededFromCache) return seededFromCache;
                if (previous && pathBelongsToRepo({
                    candidatePath: path,
                    repoRootPath: previous.repo.rootPath,
                    worktreePaths: (previous.repo.worktrees ?? []).map((worktree) => worktree.path),
                    machineHomeDir: input.machineHomeDir ?? null,
                    machinePlatform: input.machinePlatform ?? null,
                })) {
                    return previous;
                }
                return null;
            });
        };
        applySeed();
        if (!fetchEnabled) return () => {
            cancelled = true;
        };

        void (async () => {
            try {
                // STAGE 1: Light fetch (fast).
                // The checkout chip and picker read repository facts only, never the changed files.
                const lightSnapshot = await scmRepositoryService.fetchSnapshotForMachinePath({
                    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
                    machineId,
                    path,
                    ...(input.machineHomeDir !== undefined ? { homeDir: input.machineHomeDir } : {}),
                    detail: 'facts',
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
                    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
                    machineId,
                    path,
                    ...(input.machineHomeDir !== undefined ? { homeDir: input.machineHomeDir } : {}),
                    worktreePaths,
                });
                if (cancelled || !enrichment || !lightSnapshot) return;
                setSnapshot(mergeWorktreesEnrichmentIntoSnapshot(lightSnapshot, enrichment));
            } catch (_error) {
                if (!cancelled) {
                    applySeed();
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [fetchEnabled, input.machineHomeDir, input.machineId, input.machinePlatform, input.path, input.serverId]);

    React.useEffect(() => {
        return refreshSnapshot();
    }, [refreshSnapshot]);

    useFocusEffect(refreshSnapshot);

    return snapshot;
}
