import { createUnavailableRuntimeActionExecutor, resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import { requiresAgentEgressRedaction } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { resolveLocalServiceActionKindForRuntimeActionId } from '@happier-dev/protocol/actions/specs/localServices';
import { DaemonLocalServiceLauncherLeafRequestV1Schema, DaemonLocalServiceLauncherSnapshotRequestV1Schema, DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePreviewOpenOrCreateRequestV1Schema, DaemonLocalServicePreviewRevokeRequestV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema, DaemonLocalServicePublicPreviewCreateRequestV1Schema, DaemonLocalServicePublicPreviewRevokeRequestV1Schema, DaemonLocalServicePublicPreviewStatusRequestV1Schema, isLocalServicePublicPreviewCreateConfirmed, redactLocalServicePublicPreviewCreateResponseForAgentEgress, redactLocalServicePublicPreviewRevokeResponseForAgentEgress, redactLocalServicePublicPreviewSnapshotForAgentEgress } from '@happier-dev/protocol/local/services/public/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { ProjectServiceRelocateInputV1Schema, type ProjectServiceRelocateInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RuntimeActionExecute, RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { RpcHandlerContext } from '@/api/rpc/types';

import type { LocalServiceActionRoutes } from './routes';
import type { LocalServiceActionExecutionContext } from './executor';
import type { LocalServicesDaemonFeatureGate, LocalServicesDaemonFeatureGateId } from '../featureGate';
import type { LocalServiceInventoryRoutes } from '../inventory/routes';
import type { LocalServiceLauncherRoutes } from '../launch/routes';
import type { LocalServicePreviewRoutes } from '../preview/routes';
import type { LocalServicePublicPreviewRoutes } from '../public/routes';

export type LocalServicesRuntimeActionRoutes = Readonly<{
    inventoryRoutes?: Pick<LocalServiceInventoryRoutes, 'getSnapshot' | 'refreshSnapshot'>;
    launcherRoutes?: Pick<LocalServiceLauncherRoutes, 'getSnapshot'> & Partial<Pick<LocalServiceLauncherRoutes, 'startTarget' | 'leaves'>>;
    previewRoutes?: Pick<LocalServicePreviewRoutes, 'getSnapshot'> & Partial<Pick<LocalServicePreviewRoutes, 'openOrCreate' | 'revoke'>>;
    actionRoutes?: Pick<LocalServiceActionRoutes, 'execute'>;
    publicPreviewRoutes?: LocalServicePublicPreviewRoutes;
    relocateService?: (request: ProjectServiceRelocateInputV1, context: RuntimeActionExecuteArgs['context']) => Promise<ActionExecuteResult>;
}>;

type CreateLocalServicesDaemonRuntimeActionExecutorInput = Readonly<{
    routes: LocalServicesRuntimeActionRoutes;
    /** Captured by the receiving host, never reconstructed from Action input/context. */
    ingress?: RpcHandlerContext;
    prepareStartAction?: LocalServiceActionExecutionContext['prepareStartAction'];
    fallback?: RuntimeActionExecute;
    // Single-owner daemon feature-gate (REQUIRED — mirrors the browser daemon executor). Each
    // local-service action family is refused at the execution boundary when its server feature
    // decision is disabled. Safety-critical params must not be optional: an omitted gate silently
    // disabled ALL family gating (the BRW-F3 optional-gate fail-open family), so untyped/stale
    // compiled callers that still omit it fall back to a fail-closed gate at runtime.
    featureGate: LocalServicesDaemonFeatureGate;
}>;

type LocalServicesRuntimeActionDisabledReason =
    | 'local_services_inventory_routes_unavailable'
    | 'local_services_launcher_routes_unavailable'
    | 'local_services_launcher_start_route_unavailable'
    | 'local_services_preview_routes_unavailable'
    | 'local_services_action_routes_unavailable'
    | 'local_services_public_preview_routes_unavailable'
    | 'local_services_public_preview_confirmation_required'
    | 'local_services_runtime_action_unbacked';

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const;

function disabledResult(reason: LocalServicesRuntimeActionDisabledReason) {
    return {
        ok: false as const,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:localServices:${reason}`,
    };
}

// A preview-lifecycle route refusal (e.g. unknown target, non-loopback) surfaced with its
// daemon reasonCode so the UI can present a precise cause rather than a generic disable.
function previewLifecycleDisabledResult(reasonCode: string) {
    return {
        ok: false as const,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:localServices:preview_${reasonCode}`,
    };
}

function readField(input: unknown, key: string): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function buildPreviewOpenOrCreateRequest(input: unknown): Record<string, unknown> {
    const machineId = readField(input, 'machineId');
    const sessionId = readField(input, 'sessionId');
    // The runtime preview input carries a single `targetId`; private preview resolves it as the
    // canonical detected-inventory entry (the common dev-server case).
    const inventoryEntryId = readField(input, 'inventoryEntryId') ?? readField(input, 'targetId');
    const source = input && typeof input === 'object' ? (input as Record<string, unknown>)['serviceTarget'] : undefined;
    return {
        ...(machineId ? { machineId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(source !== undefined ? { serviceTarget: source } : inventoryEntryId ? { inventoryEntryId } : {}),
    };
}

function buildLauncherLeafRequest(input: unknown): Record<string, unknown> {
    const machineId = readField(input, 'machineId');
    const targetId = readField(input, 'targetId');
    const sessionId = readField(input, 'sessionId');
    const scope = readField(input, 'scope');
    const workspaceRoot = readField(input, 'workspaceRoot');
    return {
        ...(machineId ? { machineId } : {}),
        ...(targetId ? { targetId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(scope ? { scope } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
    };
}

function buildPreviewRevokeRequest(input: unknown): Record<string, unknown> {
    const machineId = readField(input, 'machineId');
    const previewId = readField(input, 'previewId');
    const source = input && typeof input === 'object' ? (input as Record<string, unknown>)['serviceTarget'] : undefined;
    return {
        ...(machineId ? { machineId } : {}),
        ...(previewId ? { previewId } : {}),
        ...(source !== undefined ? { serviceTarget: source } : {}),
    };
}

function isLocalServicesRuntimeAction(actionId: RuntimeActionExecuteArgs['actionId']): boolean {
    return resolveRuntimeActionExecutionFamily(actionId) === 'localServices';
}

function featureDisabledResult(featureId: LocalServicesDaemonFeatureGateId) {
    return {
        ok: false as const,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:localServices:feature_disabled:${featureId}`,
    };
}

/**
 * The server feature(s) that must be enabled for an action to execute. All listed features must
 * be enabled; the first disabled one fails the action closed. Managed/terminate dangerous actions
 * additionally require their narrower gate beyond the base `localServices.actions` gate.
 */
function requiredFeatureGateIds(
    actionId: RuntimeActionExecuteArgs['actionId'],
): readonly LocalServicesDaemonFeatureGateId[] {
    if (actionId === 'projects.service.relocate') {
        return ['localServices.launcher', 'localServices.actions', 'localServices.managed'];
    }
    if (actionId === 'localServices.inventory.list' || actionId === 'localServices.inventory.refresh') {
        return ['localServices.inventory'];
    }
    if (actionId.startsWith('localServices.launcher.')) {
        return ['localServices.launcher'];
    }
    if (actionId.startsWith('localServices.preview.')) {
        return ['localServices.preview'];
    }
    if (actionId.startsWith('localServices.publicPreview.')) {
        return ['localServices.publicPreview'];
    }
    if (actionId.startsWith('localServices.actions.')) {
        if (actionId === 'localServices.actions.terminateDetected') {
            return ['localServices.actions', 'localServices.actions.terminate'];
        }
        if (actionId === 'localServices.actions.stopManaged' || actionId === 'localServices.actions.restartManaged') {
            return ['localServices.actions', 'localServices.managed'];
        }
        return ['localServices.actions'];
    }
    return [];
}

function resolveFeatureGateRefusal(
    gate: LocalServicesDaemonFeatureGate,
    actionId: RuntimeActionExecuteArgs['actionId'],
): LocalServicesDaemonFeatureGateId | null {
    for (const featureId of requiredFeatureGateIds(actionId)) {
        if (!gate.isEnabled(featureId)) return featureId;
    }
    return null;
}

function parseRuntimeActionInput(args: RuntimeActionExecuteArgs): Readonly<
    | { ok: true; input: unknown }
    | { ok: false; result: typeof invalidParametersResult }
> {
    const spec = getActionSpec(args.actionId);
    const parsed = spec.inputSchema.safeParse(args.input ?? {});
    return parsed.success
        ? { ok: true, input: parsed.data }
        : { ok: false, result: invalidParametersResult };
}

// Runtime fallback for untyped/stale compiled callers that omit the required gate: every
// local-services feature reads disabled, so omission can never silently open all family gating.
const failClosedLocalServicesDaemonFeatureGate: LocalServicesDaemonFeatureGate = {
    isEnabled: () => false,
    refresh: async () => {},
};

export function createLocalServicesDaemonRuntimeActionExecutor(
    input: CreateLocalServicesDaemonRuntimeActionExecutorInput,
): RuntimeActionExecute {
    const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();
    const featureGate = input.featureGate ?? failClosedLocalServicesDaemonFeatureGate;

    return async (args) => {
        if (!isLocalServicesRuntimeAction(args.actionId)) {
            return await fallback(args);
        }

        // Execution-boundary gate: refuse disabled features before any route dispatch, so a
        // server-disabled launcher/managed/terminate/preview/publicPreview surface fails closed
        // at the daemon rather than relying on the UI to hide it.
        {
            const refusedFeatureId = resolveFeatureGateRefusal(featureGate, args.actionId);
            if (refusedFeatureId) return featureDisabledResult(refusedFeatureId);
        }

        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;

        if (args.actionId === 'projects.service.relocate') {
            const relocate = input.routes.relocateService;
            if (!relocate) return disabledResult('local_services_runtime_action_unbacked');
            const request = ProjectServiceRelocateInputV1Schema.safeParse(parsed.input);
            if (!request.success) return invalidParametersResult;
            const result = await relocate(request.data, args.context);
            return result.ok ? result.result : result;
        }

        if (args.actionId === 'localServices.inventory.list') {
            const routes = input.routes.inventoryRoutes;
            return routes
                ? await routes.getSnapshot()
                : disabledResult('local_services_inventory_routes_unavailable');
        }

        if (args.actionId === 'localServices.inventory.refresh') {
            const routes = input.routes.inventoryRoutes;
            return routes
                ? await routes.refreshSnapshot()
                : disabledResult('local_services_inventory_routes_unavailable');
        }

        if (args.actionId === 'localServices.launcher.snapshot') {
            const routes = input.routes.launcherRoutes;
            if (!routes) return disabledResult('local_services_launcher_routes_unavailable');
            const leaf = buildLauncherLeafRequest(parsed.input);
            const request = DaemonLocalServiceLauncherSnapshotRequestV1Schema.omit({ machineId: true }).safeParse({
                sessionId: leaf.sessionId, scope: leaf.scope, workspaceRoot: leaf.workspaceRoot,
            });
            return request.success ? await routes.getSnapshot(request.data) : invalidParametersResult;
        }

        if (args.actionId === 'localServices.launcher.start') {
            const routes = input.routes.launcherRoutes;
            if (!routes) {
                return disabledResult('local_services_launcher_routes_unavailable');
            }
            if (!routes.startTarget) {
                return disabledResult('local_services_launcher_start_route_unavailable');
            }
            const request = DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(parsed.input);
            return request.success ? await routes.startTarget(request.data, input.ingress, args.context, args.executeCanonicalAction) : invalidParametersResult;
        }

        if (
            args.actionId === 'localServices.launcher.openPreview'
            || args.actionId === 'localServices.launcher.registerPreview'
            || args.actionId === 'localServices.launcher.history.clear'
        ) {
            const leaves = input.routes.launcherRoutes?.leaves;
            if (!leaves) {
                return disabledResult('local_services_launcher_routes_unavailable');
            }
            const request = DaemonLocalServiceLauncherLeafRequestV1Schema.safeParse(
                buildLauncherLeafRequest(parsed.input),
            );
            if (!request.success) return invalidParametersResult;
            if (args.actionId === 'localServices.launcher.openPreview') {
                return await leaves.openPreview(request.data, input.ingress);
            }
            if (args.actionId === 'localServices.launcher.registerPreview') {
                return await leaves.registerPreview(request.data, args.context.signal, input.ingress);
            }
            return await leaves.clearHistory(request.data);
        }

        if (args.actionId === 'localServices.preview.status') {
            const routes = input.routes.previewRoutes;
            return routes
                ? await routes.getSnapshot(input.ingress)
                : disabledResult('local_services_preview_routes_unavailable');
        }

        if (args.actionId === 'localServices.preview.openOrCreate') {
            const routes = input.routes.previewRoutes;
            if (!routes?.openOrCreate) {
                return disabledResult('local_services_preview_routes_unavailable');
            }
            const request = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.safeParse(
                buildPreviewOpenOrCreateRequest(parsed.input),
            );
            if (!request.success) return invalidParametersResult;
            const result = await routes.openOrCreate(request.data, args.context.signal, input.ingress);
            return result.ok
                ? result.response
                : previewLifecycleDisabledResult(result.reasonCode);
        }

        if (args.actionId === 'localServices.preview.revoke') {
            const routes = input.routes.previewRoutes;
            if (!routes?.revoke) {
                return disabledResult('local_services_preview_routes_unavailable');
            }
            const request = DaemonLocalServicePreviewRevokeRequestV1Schema.safeParse(
                buildPreviewRevokeRequest(parsed.input),
            );
            if (!request.success) return invalidParametersResult;
            const result = await routes.revoke(request.data, input.ingress);
            return result.ok
                ? result.response
                : previewLifecycleDisabledResult(result.reasonCode);
        }

        if (args.actionId === 'localServices.publicPreview.status') {
            const routes = input.routes.publicPreviewRoutes;
            if (!routes) {
                return disabledResult('local_services_public_preview_routes_unavailable');
            }
            const request = DaemonLocalServicePublicPreviewStatusRequestV1Schema.safeParse(parsed.input);
            if (!request.success) return invalidParametersResult;
            const snapshot = await routes.getStatus(request.data, input.ingress);
            return requiresAgentEgressRedaction(args.context)
                ? redactLocalServicePublicPreviewSnapshotForAgentEgress(snapshot)
                : snapshot;
        }

        if (args.actionId === 'localServices.publicPreview.create') {
            const routes = input.routes.publicPreviewRoutes;
            if (!routes) {
                return disabledResult('local_services_public_preview_routes_unavailable');
            }
            const request = DaemonLocalServicePublicPreviewCreateRequestV1Schema.safeParse(parsed.input);
            if (!request.success) return invalidParametersResult;
            // UX-5: daemon-enforced consent. Exposing a local service to the internet requires an
            // explicit acknowledged confirmation, so a non-UI/agent caller cannot do it silently.
            if (!isLocalServicePublicPreviewCreateConfirmed(request.data)) {
                return disabledResult('local_services_public_preview_confirmation_required');
            }
            const response = await routes.createExposure(request.data, input.ingress);
            return requiresAgentEgressRedaction(args.context)
                ? redactLocalServicePublicPreviewCreateResponseForAgentEgress(response)
                : response;
        }

        if (args.actionId === 'localServices.publicPreview.revoke') {
            const routes = input.routes.publicPreviewRoutes;
            if (!routes) {
                return disabledResult('local_services_public_preview_routes_unavailable');
            }
            const request = DaemonLocalServicePublicPreviewRevokeRequestV1Schema.safeParse(parsed.input);
            if (!request.success) return invalidParametersResult;
            const response = await routes.revokeExposure(request.data, input.ingress);
            return requiresAgentEgressRedaction(args.context)
                ? redactLocalServicePublicPreviewRevokeResponseForAgentEgress(response)
                : response;
        }

        if (args.actionId === 'localServices.publicPreview.copyUrl') {
            const routes = input.routes.publicPreviewRoutes;
            if (!routes) {
                return disabledResult('local_services_public_preview_routes_unavailable');
            }
            const request = DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema.safeParse(parsed.input);
            return request.success ? await routes.copyUrl(request.data, input.ingress) : invalidParametersResult;
        }

        if (args.actionId.startsWith('localServices.actions.')) {
            const routes = input.routes.actionRoutes;
            if (!routes) {
                return disabledResult('local_services_action_routes_unavailable');
            }
            const request = LocalServiceActionRequestV1Schema.safeParse(parsed.input);
            if (
                !request.success
                || resolveLocalServiceActionKindForRuntimeActionId(args.actionId) !== request.data.action
            ) {
                return invalidParametersResult;
            }
            return await routes.execute(request.data, { ingress: input.ingress, actionContext: args.context,
                prepareStartAction: input.prepareStartAction });
        }

        return disabledResult('local_services_runtime_action_unbacked');
    };
}
