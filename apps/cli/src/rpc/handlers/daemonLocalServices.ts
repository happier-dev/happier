import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonLocalServiceActionExecuteRequestV1Schema, DaemonLocalServiceActionExecuteResponseV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceInventoryRefreshRequestV1Schema, DaemonLocalServiceInventoryRefreshResponseV1Schema, DaemonLocalServiceInventorySnapshotRequestV1Schema, DaemonLocalServiceInventorySnapshotResponseV1Schema, DaemonLocalServiceInventoryWatchRequestV1Schema, DaemonLocalServiceInventoryWatchResponseV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { DaemonLocalServiceLauncherHistoryClearResponseV1Schema, DaemonLocalServiceLauncherLeafRequestV1Schema, DaemonLocalServiceLauncherOpenPreviewResponseV1Schema, DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema, DaemonLocalServiceLauncherSnapshotRequestV1Schema, DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema, DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema, DaemonLocalServicePublicPreviewCreateRequestV1Schema, DaemonLocalServicePublicPreviewCreateResponseV1Schema, DaemonLocalServicePublicPreviewRevokeRequestV1Schema, DaemonLocalServicePublicPreviewRevokeResponseV1Schema, DaemonLocalServicePublicPreviewStatusRequestV1Schema, DaemonLocalServicePublicPreviewStatusResponseV1Schema, isLocalServicePublicPreviewCreateConfirmed } from '@happier-dev/protocol/local/services/public/v1';
import type { DaemonLocalServiceInventoryRefreshResponseV1, DaemonLocalServiceInventorySnapshotResponseV1, DaemonLocalServiceInventoryWatchResponseV1, DaemonLocalServiceLauncherHistoryClearResponseV1, DaemonLocalServiceLauncherOpenPreviewResponseV1, DaemonLocalServiceLauncherRegisterPreviewResponseV1, DaemonLocalServiceLauncherSnapshotResponseV1, DaemonLocalServicePublicPreviewCopyUrlResponseV1, DaemonLocalServicePublicPreviewCreateResponseV1, DaemonLocalServicePublicPreviewRevokeResponseV1, DaemonLocalServicePublicPreviewStatusResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS, resolveLocalServiceActionKindForRuntimeActionId } from '@happier-dev/protocol/actions/specs/localServices';
import type { RuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import type { RpcHandler } from '@/api/rpc/types';

import type { LocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import type { LocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import type { LocalServiceLauncherRoutes } from '@/daemon/local/services/launch/routes';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { LocalServicePublicPreviewRoutes } from '@/daemon/local/services/public/routes';
import { registerDaemonLocalServicePreviewSnapshotHandler, type DaemonLocalServicePreviewSnapshotHandlerOptions } from './daemonLocalServicePreviewSnapshot';
import { registerActionSpecRpcHandlers, type RegisterActionSpecRpcHandlersParams } from './registerActionSpecRpcHandlers';
import { assertLocalServiceCredentialAdmission } from '@/daemon/local/services/credentialAdmission';

export type DaemonLocalServicesMachineRpcRoutes = Pick<DaemonLocalServicePreviewSnapshotHandlerOptions,
    'projectManagedServices' | 'machineId' | 'serverId'> & Readonly<{
    /** Actual Account of this connection's daemon credential, never a caller-supplied actor. */
    accountId?: string;
    localServicesInventory?:
        & Pick<LocalServiceInventoryRoutes, 'getSnapshot' | 'refreshSnapshot'>
        & Partial<Pick<LocalServiceInventoryRoutes, 'watchSnapshot'>>
        | null;
    localServicesLauncher?: Pick<LocalServiceLauncherRoutes, 'getSnapshot'> & Partial<Pick<LocalServiceLauncherRoutes, 'startTarget' | 'leaves'>> | null;
    localServicesPreview?: LocalServicePreviewRoutes | null;
    localServicesActions?: Pick<LocalServiceActionRoutes, 'execute'> | null;
    localServicesPublicPreview?: LocalServicePublicPreviewRoutes | null;
    /** Receiving host constructs the full credential-scoped policy executor with genuine ingress. */
    resolveLauncherActionExecutor?: RegisterActionSpecRpcHandlersParams['resolveActionExecutor'];
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

function requireLauncherLeafRoutes(
    options: DaemonLocalServicesMachineRpcRoutes,
): NonNullable<LocalServiceLauncherRoutes['leaves']> {
    if (!options.localServicesLauncher?.leaves) {
        throw new Error('Local service launcher leaf runtime is unavailable');
    }
    return options.localServicesLauncher.leaves;
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
    const assertRequesterRead = (context?: RpcHandlerContext) => assertLocalServiceCredentialAdmission({
        accountId: options.accountId, machineId: options.machineId ?? '', context,
    });
    if (options.localServicesInventory) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            async (raw: unknown, context): Promise<DaemonLocalServiceInventorySnapshotResponseV1> => {
                DaemonLocalServiceInventorySnapshotRequestV1Schema.parse(raw);
                await assertRequesterRead(context);
                const routes = requireInventoryRoutes(options);
                const snapshot = await routes.getSnapshot();
                await assertRequesterRead(context);
                return DaemonLocalServiceInventorySnapshotResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot,
                });
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
            async (raw: unknown, context): Promise<DaemonLocalServiceInventoryRefreshResponseV1> => {
                DaemonLocalServiceInventoryRefreshRequestV1Schema.parse(raw);
                await assertRequesterRead(context);
                const routes = requireInventoryRoutes(options);
                const snapshot = await routes.refreshSnapshot();
                await assertRequesterRead(context);
                return DaemonLocalServiceInventoryRefreshResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot,
                });
            },
        );

        // The push half of local-service freshness (G10): a parked read that answers when the
        // daemon's inventory registry actually changes. Clients keep exactly one of these
        // outstanding per mounted surface and re-arm on the answer, so nothing polls.
        if (options.localServicesInventory.watchSnapshot) {
            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
                async (raw: unknown, context): Promise<DaemonLocalServiceInventoryWatchResponseV1> => {
                    const request = DaemonLocalServiceInventoryWatchRequestV1Schema.parse(raw);
                    await assertRequesterRead(context);
                    const watchSnapshot = requireInventoryRoutes(options).watchSnapshot;
                    if (!watchSnapshot) {
                        throw new Error('Local service inventory watch runtime is unavailable');
                    }
                    const result = await watchSnapshot({
                        ...(request.sinceGeneratedAt === undefined ? {} : { sinceGeneratedAt: request.sinceGeneratedAt }),
                        ...(context ? { signal: context.signal } : {}),
                    });
                    await assertRequesterRead(context);
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
            async (raw: unknown, context): Promise<DaemonLocalServiceLauncherSnapshotResponseV1> => {
                const request = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(raw);
                await assertRequesterRead(context);
                const routes = requireLauncherRoutes(options);
                // Forward sessionId + explicit scope/workspaceRoot so the feed scopes to the
                // session's workspace PATH (D1), the requested machine view, or a session-less
                // project root. Dropping these here was the precise plumbing break that made
                // per-request scope structurally impossible.
                const feedRequest = {
                    ...(request.projection ? { projection: request.projection } : {}),
                    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
                    ...(request.scope ? { scope: request.scope } : {}),
                    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
                };
                const snapshot = await routes.getSnapshot(
                    Object.keys(feedRequest).length > 0 ? feedRequest : undefined,
                );
                await assertRequesterRead(context);
                return DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot,
                });
            },
        );

        if (options.localServicesLauncher.startTarget && options.resolveLauncherActionExecutor) {
            registerActionSpecRpcHandlers({
                rpcHandlerManager: rpc,
                actionIds: ['localServices.launcher.start'],
                resolveActionExecutor: options.resolveLauncherActionExecutor,
                ...(options.machineId ? { targetMachineId: options.machineId, defaultMachineTarget: true } : {}),
            });
        }

        // LSV-1 launcher leaves: openPreview (safe "open in browser"), registerPreview (persist a
        // loopback launch target as a private preview), and history.clear (dismiss the launcher
        // feed). Exposed only when the daemon-owned leaf routes are available; each delegates
        // through the shared leaf request.
        if (options.localServicesLauncher.leaves) {
            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
                async (raw: unknown, context): Promise<DaemonLocalServiceLauncherOpenPreviewResponseV1> => {
                    const request = DaemonLocalServiceLauncherLeafRequestV1Schema.parse(raw);
                    const leaves = requireLauncherLeafRoutes(options);
                    return DaemonLocalServiceLauncherOpenPreviewResponseV1Schema.parse(
                        await leaves.openPreview(request, context),
                    );
                },
            );

            rpc.registerHandler(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
                async (raw: unknown, context): Promise<DaemonLocalServiceLauncherRegisterPreviewResponseV1> => {
                    const request = DaemonLocalServiceLauncherLeafRequestV1Schema.parse(raw);
                    const leaves = requireLauncherLeafRoutes(options);
                    return DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema.parse(
                        await leaves.registerPreview(request, context?.signal, context),
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

    if (options.localServicesPreview || options.projectManagedServices) {
        registerDaemonLocalServicePreviewSnapshotHandler(rpc, {
            localServicesPreview: options.localServicesPreview,
            projectManagedServices: options.projectManagedServices,
            machineId: options.machineId,
            serverId: options.serverId,
        });
    }

    if (options.localServicesActions) {
        // The legacy aggregate is only a shape adapter to the same policy-admitted
        // handlers. It must not become a second, unapproved control executor.
        const controlHandlers = new Map<string, RpcHandler<unknown, unknown>>();
        if (options.resolveLauncherActionExecutor) registerActionSpecRpcHandlers({
            rpcHandlerManager: {
                registerHandler(method, handler) {
                    controlHandlers.set(method, handler);
                    rpc.registerHandler(method, handler);
                },
            },
            actionIds: Object.keys(LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS),
            resolveActionExecutor: options.resolveLauncherActionExecutor,
            ...(options.machineId ? { targetMachineId: options.machineId, defaultMachineTarget: true } : {}),
        });
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            async (raw: unknown, context) => {
                const request = DaemonLocalServiceActionExecuteRequestV1Schema.parse(raw);
                const binding = Object.entries(LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS).find(
                    ([actionId]) => resolveLocalServiceActionKindForRuntimeActionId(actionId as RuntimeActionIdV1) === request.action,
                );
                const handler = binding ? controlHandlers.get(binding[1]) : undefined;
                if (!handler) return { ok: false, errorCode: 'local_service_action_executor_unavailable',
                    error: 'Local service Action policy executor is unavailable' };
                const result = await handler(request, context);
                if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return result;
                return DaemonLocalServiceActionExecuteResponseV1Schema.parse({
                    protocolVersion: 1,
                    result,
                });
            },
        );
    }

    if (options.localServicesPublicPreview) {
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
            async (raw: unknown, context): Promise<DaemonLocalServicePublicPreviewStatusResponseV1> => {
                const request = DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                return DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse({
                    protocolVersion: 1,
                    snapshot: await routes.getStatus(request, context),
                });
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            async (raw: unknown, context): Promise<DaemonLocalServicePublicPreviewCreateResponseV1> => {
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
                    await routes.createExposure(request, context),
                );
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
            async (raw: unknown, context): Promise<DaemonLocalServicePublicPreviewRevokeResponseV1> => {
                const request = DaemonLocalServicePublicPreviewRevokeRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                return DaemonLocalServicePublicPreviewRevokeResponseV1Schema.parse(
                    await routes.revokeExposure(request, context),
                );
            },
        );

        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
            async (raw: unknown, context): Promise<DaemonLocalServicePublicPreviewCopyUrlResponseV1> => {
                const request = DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema.parse(raw);
                const routes = requirePublicPreviewRoutes(options);
                return DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.parse(
                    await routes.copyUrl(request, context),
                );
            },
        );
    }
}
