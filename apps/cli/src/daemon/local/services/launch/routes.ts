import type { LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';
import type { createProjectServiceDeclarationStarter } from './projectDeclarations';
import type { ActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';

import type { LocalServiceLauncherFeed, LocalServiceLauncherFeedSnapshotRequest } from './feed';
import type { LocalServiceLauncherLeafRoutes } from './leaves';
import { createLocalServiceLauncherSnapshotReader } from './snapshotReader';
import {
    completeLocalServiceLauncherStartRequest,
    createLocalServiceLauncherStartTarget,
    type CreateLocalServiceLauncherStartTargetInput,
    type LocalServiceLauncherStartTarget,
} from './start';

export type LocalServiceLauncherRoutes = Readonly<{
    getSnapshot(request?: LocalServiceLauncherFeedSnapshotRequest): Promise<LocalServiceLauncherSnapshotV1>;
    startTarget?: LocalServiceLauncherStartTarget;
    prepareStartApproval?: ReturnType<typeof createProjectServiceDeclarationStarter>['prepareStartApproval'];
    leaves?: LocalServiceLauncherLeafRoutes;
    /** Installed host observation only; this port admits no execution. */
    bindStartOperations?: (store: Pick<ActionOperationStore, 'list' | 'subscribe'>, accountId: string) => () => void;
}>;

export function createLocalServiceLauncherRoutes<TDeclaration = unknown>(input: Readonly<{
    feed: LocalServiceLauncherFeed;
    history?: CreateLocalServiceLauncherStartTargetInput<TDeclaration>['history'];
    startTarget?: LocalServiceLauncherStartTarget;
    prepareStartApproval?: ReturnType<typeof createProjectServiceDeclarationStarter>['prepareStartApproval'];
    resolveStartTarget?: CreateLocalServiceLauncherStartTargetInput<TDeclaration>['resolveStartTarget'];
    startManagedDeclaration?: CreateLocalServiceLauncherStartTargetInput<TDeclaration>['startManagedDeclaration'];
    leaves?: LocalServiceLauncherLeafRoutes;
    bindStartOperations?: LocalServiceLauncherRoutes['bindStartOperations'];
    now?: () => number;
}>): LocalServiceLauncherRoutes {
    const startTarget = input.startTarget ?? createLocalServiceLauncherStartTarget<TDeclaration>({
        feed: input.feed,
        ...(input.history ? { history: input.history } : {}),
        ...(input.resolveStartTarget ? { resolveStartTarget: input.resolveStartTarget } : {}),
        ...(input.startManagedDeclaration ? { startManagedDeclaration: input.startManagedDeclaration } : {}),
        ...(input.now ? { now: input.now } : {}),
    });
    const prepareStartApproval: LocalServiceLauncherRoutes['prepareStartApproval'] = input.prepareStartApproval
        ? async (request, ingress, context, executeCanonicalAction) => {
            try {
                let complete = request;
                if (!request.workspace || !request.declaration) {
                    const feed = await createLocalServiceLauncherSnapshotReader({
                        feed: input.feed, machineId: request.machineId, ingress, serverId: context?.serverId, readScope: 'requester_managed_services',
                    });
                    complete = completeLocalServiceLauncherStartRequest(request, await feed.getSnapshot({
                        ...(request.workspace ? { workspaceRoot: request.workspace.rootPath } : { discovery: 'cached' as const }),
                        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
                    }));
                }
                return input.prepareStartApproval!(complete, ingress, context, executeCanonicalAction);
            } catch (error) {
                if (error instanceof Error && error.message === 'requester_credentials_unavailable') {
                    return { ok: false, errorCode: error.message, error: error.message };
                }
                throw error;
            }
        } : undefined;
    return {
        async getSnapshot(request) {
            return await input.feed.getSnapshot(request);
        },
        startTarget,
        ...(prepareStartApproval ? { prepareStartApproval } : {}),
        ...(input.leaves ? { leaves: input.leaves } : {}),
        ...(input.bindStartOperations ? { bindStartOperations: input.bindStartOperations } : {}),
    };
}
