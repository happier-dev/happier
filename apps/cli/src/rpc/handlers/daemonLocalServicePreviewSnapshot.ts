import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonLocalServicePreviewOpenOrCreateRequestV1Schema, DaemonLocalServicePreviewOpenOrCreateResponseV1Schema, DaemonLocalServicePreviewRevokeRequestV1Schema, DaemonLocalServicePreviewRevokeResponseV1Schema, DaemonLocalServicePreviewSnapshotRequestV1Schema, DaemonLocalServicePreviewSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import type { DaemonLocalServicePreviewOpenOrCreateResponseV1, DaemonLocalServicePreviewRevokeResponseV1, DaemonLocalServicePreviewSnapshotResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { DaemonLocalServicePreviewAdmissionRequestV1Schema, DaemonLocalServicePreviewAdmissionResponseV1Schema,
    type DaemonLocalServicePreviewAdmissionResponseV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext } from '@happier-dev/protocol/rpc';
import { readProjectManagedServicePreviewEndpoint } from '@/daemon/local/services/preview/projectEndpoint';

// The snapshot RPC reads the preview registry; the lifecycle methods (openOrCreate/revoke)
// dispatch through the same daemon `LocalServicePreviewRoutes` owner so the UI runtime-action
// executor has a real cross-boundary transport (PRV-2, F2-preview), mirroring how the
// public-preview create/revoke handlers expose their owner over machine RPC.
export type DaemonLocalServicePreviewSnapshotHandlerOptions = Readonly<{
    /** The current daemon owner; a forwarding resolver may dereference the live registry. */
    projectManagedServices?: Pick<ReturnType<typeof createManagedServicesOwner>, 'resolveProjectService'> | null;
    /** Exact Machine and Home bound to the authenticated registration connection. */
    machineId?: string;
    serverId?: string;
    localServicesPreview?:
        | (Pick<LocalServicePreviewRoutes, 'getSnapshot'>
            & Partial<Pick<LocalServicePreviewRoutes, 'openOrCreate' | 'revoke'>>)
        | null;
}>;

// A daemon lifecycle route refused the request (e.g. wrong machine, unknown inventory entry).
// Surface the reason on the wire so the UI maps it to a stable `preview_<reason>` disabled code
// instead of a generic transport failure.
class DaemonLocalServicePreviewLifecycleError extends Error {
    constructor(public readonly reasonCode: string) {
        super(`local_service_preview_lifecycle_refused:${reasonCode}`);
        this.name = 'DaemonLocalServicePreviewLifecycleError';
    }
}

export function isDaemonLocalServicePreviewLifecycleError(
    value: unknown,
): value is DaemonLocalServicePreviewLifecycleError {
    return value instanceof DaemonLocalServicePreviewLifecycleError;
}

export function registerDaemonLocalServicePreviewSnapshotHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonLocalServicePreviewSnapshotHandlerOptions = {},
): void {
    if (options.projectManagedServices && options.serverId && options.machineId) rpc.registerHandler(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION, async (raw: unknown, context): Promise<DaemonLocalServicePreviewAdmissionResponseV1> => {
        const refused = { v: 1, kind: 'refused', reasonCode: 'service_unavailable' } as const;
        const request = DaemonLocalServicePreviewAdmissionRequestV1Schema.parse(raw);
        const admission = context?.machineAdmission;
        if (!options.projectManagedServices || !options.serverId || !options.machineId || !admission
            || !isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext(context?.authorization)
            || !context?.verifyMachineAdmissionCurrent || context.signal.aborted
            || admission.machineId !== options.machineId || request.target.machineId !== options.machineId) return refused;
        const resolved = options.projectManagedServices.resolveProjectService(request.target);
        if (resolved.status !== 'found') return refused;
        const handle = resolved.handle;
        const current = () => {
            const latest = options.projectManagedServices?.resolveProjectService(request.target);
            return !context.signal.aborted && !handle.retirementSignal.aborted && handle.isCurrent()
                && handle.workspace.serverId === options.serverId && handle.workspace.machineId === options.machineId
                && handle.requester.serverId === options.serverId && handle.requester.machineId === admission.machineId
                && handle.requester.installationId === admission.installationId && latest?.status === 'found' && latest.handle === handle;
        };
        if (!current() || !await context.verifyMachineAdmissionCurrent() || !current()) return refused;
        if (request.kind === 'wait_retirement') {
            if (request.instanceId !== handle.instanceId) return refused;
            await new Promise<void>((resolve) => {
                const finish = () => {
                    handle.retirementSignal.removeEventListener('abort', finish);
                    context.signal.removeEventListener('abort', finish);
                    resolve();
                };
                handle.retirementSignal.addEventListener('abort', finish, { once: true });
                context.signal.addEventListener('abort', finish, { once: true });
                if (handle.retirementSignal.aborted || context.signal.aborted) finish();
            });
            if (context.signal.aborted || !await context.verifyMachineAdmissionCurrent()) return refused;
            return { v: 1, kind: 'retired', instanceId: handle.instanceId };
        }
        const endpoint = readProjectManagedServicePreviewEndpoint(handle);
        if (!endpoint || !current()) return refused;
        return DaemonLocalServicePreviewAdmissionResponseV1Schema.parse({ v: 1, kind: 'admitted', instanceId: handle.instanceId,
            serviceTarget: { kind: 'managed_service', managedServiceId: handle.instanceId, machineId: handle.workspace.machineId,
                cwd: handle.cwd, declaration: handle.declaration,
                ...(request.target.workspaceId !== undefined ? { workspaceId: handle.workspace.id } : {}) },
            starterAccountId: handle.requester.accountId, endpoint });
    });
    rpc.registerHandler(
        RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
        async (raw: unknown, context): Promise<DaemonLocalServicePreviewSnapshotResponseV1> => {
            DaemonLocalServicePreviewSnapshotRequestV1Schema.parse(raw);
            if (!options.localServicesPreview) {
                throw new Error('Local service preview runtime is unavailable');
            }
            return DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({
                protocolVersion: 1,
                snapshot: await options.localServicesPreview.getSnapshot(context),
            });
        },
    );

    const routes = options.localServicesPreview;
    if (routes?.openOrCreate) {
        const openOrCreate = routes.openOrCreate;
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
            async (raw: unknown, context): Promise<DaemonLocalServicePreviewOpenOrCreateResponseV1> => {
                const request = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.parse(raw);
                const result = await openOrCreate(request, context?.signal, context);
                if (!result.ok) {
                    throw new DaemonLocalServicePreviewLifecycleError(result.reasonCode);
                }
                return DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(result.response);
            },
        );
    }

    if (routes?.revoke) {
        const revoke = routes.revoke;
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
            async (raw: unknown, context): Promise<DaemonLocalServicePreviewRevokeResponseV1> => {
                const request = DaemonLocalServicePreviewRevokeRequestV1Schema.parse(raw);
                const result = await revoke(request, context);
                if (!result.ok) {
                    throw new DaemonLocalServicePreviewLifecycleError(result.reasonCode);
                }
                return DaemonLocalServicePreviewRevokeResponseV1Schema.parse(result.response);
            },
        );
    }
}
