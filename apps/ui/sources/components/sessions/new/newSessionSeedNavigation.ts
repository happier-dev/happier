import type { SessionNewSessionSeedOutcome } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { admitProjectAuthoringOrigin } from '@/components/projects/detail/projectRouteState';

/** Page-host navigation adapter shared by semantic Host API and authoring Actions. */
export async function openOrdinaryNewSessionSeed(params: Readonly<{
    seed: unknown;
    pluginId?: string;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>): Promise<SessionNewSessionSeedOutcome> {
    try {
        const [{ seedAndOpenNewSession }, { router }] = await Promise.all([
            import('./newSessionSeedComposer'),
            import('expo-router'),
        ]);
        return seedAndOpenNewSession({
            seed: params.seed,
            ...(params.pluginId ? { pluginId: params.pluginId } : {}),
            scope: params.scope,
            ...(params.signal ? { signal: params.signal } : {}),
            isCurrent: params.isCurrent,
            admitOrigin: origin => admitProjectAuthoringOrigin(origin, params.scope),
            navigateToNewSession: ({ dataId, draftId, worktree, spawnServerId, machineId, directory }) => {
                router.push({
                    pathname: '/new',
                    params: {
                        draftId,
                        ...(dataId === null ? {} : { dataId }),
                        ...(worktree === undefined ? {} : { worktree }),
                        ...(spawnServerId === undefined ? {} : { spawnServerId }),
                        ...(machineId === undefined ? {} : { machineId }),
                        ...(directory === undefined ? {} : { directory }),
                    },
                });
            },
        });
    } catch {
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
}
