import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonLocalServiceActionExecuteRequestV1Schema,
    DaemonLocalServiceActionExecuteResponseV1Schema,
    DaemonLocalServiceInventoryRefreshRequestV1Schema,
    DaemonLocalServiceInventoryRefreshResponseV1Schema,
    DaemonLocalServiceInventorySnapshotRequestV1Schema,
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
    DaemonLocalServiceInventoryWatchRequestV1Schema,
    DaemonLocalServiceInventoryWatchResponseV1Schema,
    DaemonLocalServiceLauncherHistoryClearResponseV1Schema,
    DaemonLocalServiceLauncherLeafRequestV1Schema,
    DaemonLocalServiceLauncherOpenPreviewResponseV1Schema,
    DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema,
    DaemonLocalServiceLauncherSnapshotRequestV1Schema,
    DaemonLocalServiceLauncherSnapshotResponseV1Schema,
    DaemonLocalServiceLauncherStartRequestV1Schema,
    DaemonLocalServiceLauncherStartResponseV1Schema,
    DaemonLocalServiceManagedSnapshotRequestV1Schema,
    DaemonLocalServiceManagedSnapshotResponseV1Schema,
    DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
    DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
    DaemonLocalServicePublicPreviewCreateRequestV1Schema,
    DaemonLocalServicePublicPreviewCreateResponseV1Schema,
    DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
    DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
    DaemonLocalServicePublicPreviewStatusRequestV1Schema,
    DaemonLocalServicePublicPreviewStatusResponseV1Schema,
    isLocalServicePublicPreviewCreateConfirmed,
    type DaemonLocalServiceActionExecuteResponseV1,
    type DaemonLocalServiceInventoryRefreshResponseV1,
    type DaemonLocalServiceInventorySnapshotResponseV1,
    type DaemonLocalServiceInventoryWatchResponseV1,
    type DaemonLocalServiceLauncherHistoryClearResponseV1,
    type DaemonLocalServiceLauncherOpenPreviewResponseV1,
    type DaemonLocalServiceLauncherRegisterPreviewResponseV1,
    type DaemonLocalServiceLauncherSnapshotResponseV1,
    type DaemonLocalServiceLauncherStartResponseV1,
    type DaemonLocalServiceManagedSnapshotResponseV1,
    type DaemonLocalServicePublicPreviewCopyUrlResponseV1,
    type DaemonLocalServicePublicPreviewCreateResponseV1,
    type DaemonLocalServicePublicPreviewRevokeResponseV1,
    type DaemonLocalServicePublicPreviewStatusResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { LocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import type { LocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import type { LocalServiceLauncherRoutes } from '@/daemon/local/services/launch/routes';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { LocalServicePublicPreviewRoutes } from '@/daemon/local/services/public/routes';
import { registerDaemonLocalServicePreviewSnapshotHandler } from './daemonLocalServicePreviewSnapshot';

export type DaemonLocalServicesMachineRpcRoutes = Readonly<{
    localServicesInventory?:
        & Pick<LocalServiceInventoryRoutes, 'getSnapshot' | 'refreshSnapshot'>
        & Partial<Pick<LocalServiceInventoryRoutes, 'watchSnapshot'>>
        | null;
    localServicesLauncher?: Pick<LocalServiceLauncherRoutes, 'getSnapshot'> & Partial<Pick<LocalServiceLauncherRoutes, 'startTarget' | 'leaves'>> | null;
    localServicesManaged?: Readonly<{ getSnapshot(): Promise<DaemonLocalServiceManagedSnapshotResponseV1['snapshot']> }> | null;
    localServicesPreview?: LocalServicePreviewRoutes | null;
    localServicesActions?: Pick<LocalServiceActionRoutes, 'execute'> | null;
    localServicesPublicPreview?: LocalServicePublicPreviewRoutes | null;
}>;

function requireInventoryRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): NonNullable<DaemonLocalServicesMachineRpcRoutes['localServicesInventory']> {
    if (!options.localServicesInventory) {
        throw new Error('Local service inventory runtime is unavailable');
    }
    return options.localServicesInventory;
}

function requireLauncherRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): Pick<LocalServiceLauncherRoutes, 'getSnapshot'> {
    if (!options.localServicesLauncher) {
        throw new Error('Local service launcher runtime is unavailable');
    }
    return options.localServicesLauncher;
}

function requireLauncherStartRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): Required<Pick<LocalServiceLauncherRoutes, 'startTarget'>> {
    if (!options.localServicesLauncher?.startTarget) {
        throw new Error('Local service launcher start runtime is unavailable');
    }
    return { startTarget: options.localServicesLauncher.startTarget };
}

function requireLauncherLeafRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): NonNullable<LocalServiceLauncherRoutes['leaves']> {
    if (!options.localServicesLauncher?.leaves) {
        throw new Error('Local service launcher leaf runtime is unavailable');
    }
    return options.localServicesLauncher.leaves;
}

function requireManagedRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): Readonly<{ getSnapshot(): Promise<DaemonLocalServiceManagedSnapshotResponseV1['snapshot']> }> {
    if (!options.localServicesManaged) {
        throw new Error('Managed local service runtime is unavailable');
    }
    return options.localServicesManaged;
}

function requireActionRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): Pick<LocalServiceActionRoutes, 'execute'> {
    if (!options.localServicesActions) {
        throw new Error('Local service action runtime is unavailable');
    }
    return options.localServicesActions;
}

function requirePublicPreviewRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): LocalServicePublicPreviewRoutes {
    if (!options.localServicesPublicPreview) {
        throw new Error('Local service public-preview runtime is unavailable');
    }
    return options.localServicesPublicPreview;
}

export function registerDaemonLocalServicesMachineRpcHandlers(
    rpc: RpcHandlerRegistrar,
    options: DaemonLocalServicesMachineRpcRoutes = {},
): void {
    if (options.localServicesInventory) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            async (raw: unknown): Promise<DaemonLocalServiceInventorySnapshotResponseV1> => {
                DaemonLocalServiceInventorySnapshotRequestV1Schema.parse(raw);
                const routes = requireInventoryRoutes(options);
                return DaemonLocalServiceInventorySnapshotResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot: await routes.getSnapshot(),
                });
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
            async (raw: unknown): Promise<DaemonLocalServiceInventoryRefreshResponseV1> => {
                DaemonLocalServiceInventoryRefreshRequestV1Schema.parse(raw);
                const routes = requireInventoryRoutes(options);
                return DaemonLocalServiceInventoryRefreshResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot: await routes.refreshSnapshot(),
                });
            },
        );

        // The push half of local-service freshness (G10): a parked read that answers when the
        // daemon's inventory registry actually changes. Clients keep exactly one of these
        // outstanding per mounted surface and re-arm on the answer, so nothing polls.
        if (options.localServicesInventory.watchSnapshot) {
            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
                async (raw: unknown): Promise<DaemonLocalServiceInventoryWatchResponseV1> => {
                    const request = DaemonLocalServiceInventoryWatchRequestV1Schema.parse(raw);
                    const watchSnapshot = requireInventoryRoutes(options).watchSnapshot;
                    if (!watchSnapshot) {
                        throw new Error('Local service inventory watch runtime is unavailable');
                    }
                    const result = await watchSnapshot(
                        request.sinceGeneratedAt === undefined
                            ? {}
                            : { sinceGeneratedAt: request.sinceGeneratedAt },
                    );
                    return DaemonLocalServiceInventoryWatchResponseV1Schema.parse(
                        result.changed
                            ? { protocolVersion: 1, changed: true, snapshot: result.snapshot }
                            : { protocolVersion: 1, changed: false },
                    );
                },
            );
        }
    }

    if (options.localServicesLauncher) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            async (raw: unknown): Promise<DaemonLocalServiceLauncherSnapshotResponseV1> => {
                const request = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(raw);
                const routes = requireLauncherRoutes(options);
                // Forward sessionId + explicit scope/workspaceRoot so the feed scopes to the
                // session's workspace PATH (D1), the requested machine view, or a session-less
                // project root. Dropping these here was the precise plumbing break that made
                // per-request scope structurally impossible.
                const feedRequest = {
                    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
                    ...(request.scope ? { scope: request.scope } : {}),
                    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
                };
                return DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot: await routes.getSnapshot(
                        Object.keys(feedRequest).length > 0 ? feedRequest : undefined,
                    ),
                });
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            async (raw: unknown): Promise<DaemonLocalServiceLauncherStartResponseV1> => {
                const request = DaemonLocalServiceLauncherStartRequestV1Schema.parse(raw);
                const routes = requireLauncherStartRoutes(options);
                return DaemonLocalServiceLauncherStartResponseV1Schema.parse(
                    await routes.startTarget(request),
                );
            },
        );

        // LSV-1 launcher leaves: openPreview (safe "open in browser"), registerPreview (persist a
        // loopback launch target as a private preview), and history.clear (dismiss the launcher
        // feed). Exposed only when the daemon-owned leaf routes are available; each delegates
        // through the shared leaf request.
        if (options.localServicesLauncher.leaves) {
            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
                async (raw: unknown): Promise<DaemonLocalServiceLauncherOpenPreviewResponseV1> => {
                    const request = DaemonLocalServiceLauncherLeafRequestV1Schema.parse(raw);
                    const leaves = requireLauncherLeafRoutes(options);
                    return DaemonLocalServiceLauncherOpenPreviewResponseV1Schema.parse(
                        await leaves.openPreview(request),
                    );
                },
            );

            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
                async (raw: unknown): Promise<DaemonLocalServiceLauncherRegisterPreviewResponseV1> => {
                    const request = DaemonLocalServiceLauncherLeafRequestV1Schema.parse(raw);
                    const leaves = requireLauncherLeafRoutes(options);
                    return DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema.parse(
                        await leaves.registerPreview(request),
                    );
                },
            );

            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
                async (raw: unknown): Promise<DaemonLocalServiceLauncherHistoryClearResponseV1> => {
                    const request = DaemonLocalServiceLauncherLeafRequestV1Schema.parse(raw);
                    const leaves = requireLauncherLeafRoutes(options);
                    return DaemonLocalServiceLauncherHistoryClearResponseV1Schema.parse(
                        await leaves.clearHistory(request),
                    );
                },
            );
        }
    }

    if (options.localServicesPreview) {
        registerDaemonLocalServicePreviewSnapshotHandler(rpc, {
            localServicesPreview: options.localServicesPreview,
        });
    }

    if (options.localServicesManaged) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_MANAGED_SNAPSHOT,
            async (raw: unknown): Promise<DaemonLocalServiceManagedSnapshotResponseV1> => {
                DaemonLocalServiceManagedSnapshotRequestV1Schema.parse(raw);
                const routes = requireManagedRoutes(options);
                return DaemonLocalServiceManagedSnapshotResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot: await routes.getSnapshot(),
                });
            },
        );
    }

    if (options.localServicesActions) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            async (raw: unknown): Promise<DaemonLocalServiceActionExecuteResponseV1> => {
                const request = DaemonLocalServiceActionExecuteRequestV1Schema.parse(raw);
                const routes = requireActionRoutes(options);
                return DaemonLocalServiceActionExecuteResponseV1Schema.parse({
                    protocolVersion: 1,
                    result: await routes.execute(request),
                });
            },
        );
    }

    if (options.localServicesPublicPreview) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
            async (raw: unknown): Promise<DaemonLocalServicePublicPreviewStatusResponseV1> => {
                const request = DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                return DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot: await routes.getStatus(request),
                });
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            async (raw: unknown): Promise<DaemonLocalServicePublicPreviewCreateResponseV1> => {
                const request = DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                // UX-5: daemon-enforced consent. Exposing a local service to the internet requires an
                // explicit acknowledged confirmation. This direct RPC chokepoint enforces the SAME rule
                // as the runtime-action executor (`isLocalServicePublicPreviewCreateConfirmed`) so a
                // scripted/non-UI client cannot bypass the consent gate by calling this route directly.
                if (!isLocalServicePublicPreviewCreateConfirmed(request)) {
                    throw new Error('local_services_public_preview_confirmation_required');
                }
                return DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse(
                    await routes.createExposure(request),
                );
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
            async (raw: unknown): Promise<DaemonLocalServicePublicPreviewRevokeResponseV1> => {
                const request = DaemonLocalServicePublicPreviewRevokeRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                return DaemonLocalServicePublicPreviewRevokeResponseV1Schema.parse(
                    await routes.revokeExposure(request),
                );
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
            async (raw: unknown): Promise<DaemonLocalServicePublicPreviewCopyUrlResponseV1> => {
                const request = DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                return DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.parse(
                    await routes.copyUrl(request),
                );
            },
        );
    }
}
