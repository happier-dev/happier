import type { LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';

import type { LocalServiceLauncherFeed, LocalServiceLauncherFeedSnapshotRequest } from './feed';
import type { LocalServiceLauncherLeafRoutes } from './leaves';
import {
    createLocalServiceLauncherStartTarget,
    type CreateLocalServiceLauncherStartTargetInput,
    type LocalServiceLauncherStartTarget,
} from './start';

export type LocalServiceLauncherRoutes = Readonly<{
    getSnapshot(request?: LocalServiceLauncherFeedSnapshotRequest): Promise<LocalServiceLauncherSnapshotV1>;
    startTarget?: LocalServiceLauncherStartTarget;
    leaves?: LocalServiceLauncherLeafRoutes;
}>;

export function createLocalServiceLauncherRoutes<TDeclaration = unknown>(input: Readonly<{
    feed: LocalServiceLauncherFeed;
    startTarget?: LocalServiceLauncherStartTarget;
    resolveStartTarget?: CreateLocalServiceLauncherStartTargetInput<TDeclaration>['resolveStartTarget'];
    startManagedDeclaration?: CreateLocalServiceLauncherStartTargetInput<TDeclaration>['startManagedDeclaration'];
    leaves?: LocalServiceLauncherLeafRoutes;
    now?: () => number;
}>): LocalServiceLauncherRoutes {
    const startTarget = input.startTarget ?? createLocalServiceLauncherStartTarget<TDeclaration>({
        feed: input.feed,
        ...(input.resolveStartTarget ? { resolveStartTarget: input.resolveStartTarget } : {}),
        ...(input.startManagedDeclaration ? { startManagedDeclaration: input.startManagedDeclaration } : {}),
        ...(input.now ? { now: input.now } : {}),
    });
    return {
        async getSnapshot(request) {
            return await input.feed.getSnapshot(request);
        },
        startTarget,
        ...(input.leaves ? { leaves: input.leaves } : {}),
    };
}
