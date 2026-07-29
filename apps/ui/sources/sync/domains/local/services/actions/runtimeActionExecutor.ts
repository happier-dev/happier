import {
    createUnavailableRuntimeActionExecutor,
    DaemonLocalServicePreviewOpenOrCreateRequestV1Schema,
    DaemonLocalServicePreviewRevokeRequestV1Schema,
    DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
    DaemonLocalServicePublicPreviewCreateRequestV1Schema,
    DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
    DaemonLocalServicePublicPreviewStatusRequestV1Schema,
    getActionSpec,
    LocalServiceActionRequestV1Schema,
    redactLocalServicePublicPreviewCreateResponseForAgentEgress,
    redactLocalServicePublicPreviewRevokeResponseForAgentEgress,
    redactLocalServicePublicPreviewSnapshotForAgentEgress,
    resolveRuntimeActionExecutionFamily,
    type LocalServicePreviewSnapshotV1,
    type LocalServicePublicPreviewSnapshotV1,
    type RuntimeActionExecute,
    type RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

import {
    executeLocalServiceActionViaRequest,
    type LocalServiceActionExecuteClientInput,
    type LocalServiceActionExecuteClientResult,
    type LocalServiceActionExecuteRequest,
} from './api';
import {
    fetchLocalServiceInventorySnapshot,
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
    type LocalServiceInventorySnapshotRequest,
} from '../inventory/api';
import { publishLocalServiceInventorySnapshot } from '../inventory/sharedStore';
import type { LocalServiceInventorySnapshot } from '../inventory/store';
import {
    fetchLocalServiceLauncherSnapshot,
    type LocalServiceLauncherSnapshotClientInput,
    type LocalServiceLauncherSnapshotClientResult,
    type LocalServiceLauncherSnapshotRequest,
} from '../launch/api';
import type {
    LocalServiceLauncherHistoryClearClientInput,
    LocalServiceLauncherHistoryClearClientResult,
    LocalServiceLauncherLeafTargetClientInput,
    LocalServiceLauncherOpenPreviewClientResult,
    LocalServiceLauncherRegisterPreviewClientResult,
    LocalServiceLauncherStartClientInput,
    LocalServiceLauncherStartClientResult,
} from '../launch/types';
import { publishLocalServiceLauncherSnapshot } from '../launch/sharedStore';
import type { LocalServiceLauncherSnapshot } from '../launch/types';
import {
    clearLocalServiceLauncherHistoryViaMachineRpc,
    openLocalServiceLauncherPreviewViaMachineRpc,
    registerLocalServiceLauncherPreviewViaMachineRpc,
} from '../launch/machineRpc';
import {
    fetchLocalServicePreviewSnapshot,
    normalizeLocalServicePreviewSnapshotPayload,
    type LocalServicePreviewLifecycleFailureReason,
    type LocalServicePreviewOpenOrCreateClientInput,
    type LocalServicePreviewOpenOrCreateClientResult,
    type LocalServicePreviewRevokeClientInput,
    type LocalServicePreviewRevokeClientResult,
    type LocalServicePreviewSnapshotClientInput,
    type LocalServicePreviewSnapshotClientResult,
    type LocalServicePreviewSnapshotRequest,
} from '../preview/api';
import {
    openOrCreateLocalServicePreviewViaMachineRpc,
    revokeLocalServicePreviewViaMachineRpc,
} from '../preview/machineRpc';
import { publishLocalServicePreviewSnapshot } from '../preview/sharedStore';
import type { LocalServicePreviewSnapshot } from '../preview/store';
import type {
    LocalServicePublicPreviewCopyUrlClientInput,
    LocalServicePublicPreviewCopyUrlClientResult,
    LocalServicePublicPreviewCreateClientInput,
    LocalServicePublicPreviewCreateClientResult,
    LocalServicePublicPreviewRevokeClientInput,
    LocalServicePublicPreviewRevokeClientResult,
    LocalServicePublicPreviewStatusClientInput,
    LocalServicePublicPreviewStatusClientResult,
} from '../publicPreview/api';
import { publishLocalServicePublicPreviewSnapshot } from '../publicPreview/sharedStore';

export type CreateLocalServicesRuntimeActionExecutorInput = Readonly<{
    resolveMachineId?: (args: RuntimeActionExecuteArgs) => string | null | undefined;
    request?: LocalServiceInventorySnapshotRequest
        | LocalServiceLauncherSnapshotRequest
        | LocalServicePreviewSnapshotRequest
        | LocalServiceActionExecuteRequest;
    fetchInventorySnapshot?: (
        input: LocalServiceInventorySnapshotClientInput,
    ) => Promise<LocalServiceInventorySnapshotClientResult>;
    onInventorySnapshot?: (input: Readonly<{
        machineId: string;
        serverId?: string;
        sessionId?: string;
        snapshot: LocalServiceInventorySnapshot;
    }>) => void;
    fetchLauncherSnapshot?: (
        input: LocalServiceLauncherSnapshotClientInput,
    ) => Promise<LocalServiceLauncherSnapshotClientResult>;
    onLauncherSnapshot?: (input: Readonly<{
        machineId: string;
        serverId?: string;
        sessionId?: string;
        snapshot: LocalServiceLauncherSnapshot;
    }>) => void;
    startLauncherTarget?: (
        input: LocalServiceLauncherStartClientInput,
    ) => Promise<LocalServiceLauncherStartClientResult>;
    // LSV-1 launcher leaves. Default to the canonical UI→daemon machine-RPC transport (mirroring
    // the preview openOrCreate/revoke pattern) so a bare executor is executor-backed, never
    // `local_services_runtime_action_unbacked`; injectable for isolated unit tests.
    openLauncherPreview?: (
        input: LocalServiceLauncherLeafTargetClientInput,
    ) => Promise<LocalServiceLauncherOpenPreviewClientResult>;
    registerLauncherPreview?: (
        input: LocalServiceLauncherLeafTargetClientInput,
    ) => Promise<LocalServiceLauncherRegisterPreviewClientResult>;
    clearLauncherHistory?: (
        input: LocalServiceLauncherHistoryClearClientInput,
    ) => Promise<LocalServiceLauncherHistoryClearClientResult>;
    fetchPreviewSnapshot?: (
        input: LocalServicePreviewSnapshotClientInput,
    ) => Promise<LocalServicePreviewSnapshotClientResult>;
    openOrCreatePreview?: (
        input: LocalServicePreviewOpenOrCreateClientInput,
    ) => Promise<LocalServicePreviewOpenOrCreateClientResult>;
    revokePreview?: (
        input: LocalServicePreviewRevokeClientInput,
    ) => Promise<LocalServicePreviewRevokeClientResult>;
    // Action-driven invalidation sink: each preview lifecycle/status snapshot is published into
    // the shared preview-status store (PRV-4) so an open pane refreshes immediately. Defaults to
    // the singleton store; injectable for isolated unit tests.
    onPreviewSnapshot?: (input: Readonly<{
        machineId: string;
        serverId?: string;
        snapshot: LocalServicePreviewSnapshot;
    }>) => void;
    onPublicPreviewSnapshot?: (input: Readonly<{
        machineId: string;
        serverId?: string;
        sessionId?: string;
        previewId?: string;
        exposureId?: string;
        snapshot: LocalServicePublicPreviewSnapshotV1;
    }>) => void;
    fetchPublicPreviewStatus?: (
        input: LocalServicePublicPreviewStatusClientInput,
    ) => Promise<LocalServicePublicPreviewStatusClientResult>;
    createPublicPreviewExposure?: (
        input: LocalServicePublicPreviewCreateClientInput,
    ) => Promise<LocalServicePublicPreviewCreateClientResult>;
    revokePublicPreviewExposure?: (
        input: LocalServicePublicPreviewRevokeClientInput,
    ) => Promise<LocalServicePublicPreviewRevokeClientResult>;
    copyPublicPreviewUrl?: (
        input: LocalServicePublicPreviewCopyUrlClientInput,
    ) => Promise<LocalServicePublicPreviewCopyUrlClientResult>;
    executeLocalServiceAction?: (
        input: LocalServiceActionExecuteClientInput,
    ) => Promise<LocalServiceActionExecuteClientResult>;
    fallback?: RuntimeActionExecute;
}>;

type LocalServicesRouteKind = 'inventory' | 'launcher' | 'preview' | 'public_preview' | 'action';
type LocalServicesRouteFailureReason = 'unavailable' | 'request_failed' | 'invalid_response';
type LocalServicesRuntimeActionDisabledReason =
    | 'local_services_machine_unavailable'
    | 'local_services_runtime_action_unbacked'
    | `local_services_${LocalServicesRouteKind}_${LocalServicesRouteFailureReason}`
    | `local_services_preview_refused:${string}`;

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isLocalServicesRuntimeAction(actionId: RuntimeActionExecuteArgs['actionId']): boolean {
    return resolveRuntimeActionExecutionFamily(actionId) === 'localServices';
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

function readMachineIdFromInput(input: unknown): string | null {
    if (!isRecord(input)) return null;
    const directMachineId = normalizeNonEmptyString(input.machineId);
    if (directMachineId) return directMachineId;
    return isRecord(input.target) ? normalizeNonEmptyString(input.target.machineId) : null;
}

function readSessionIdFromInput(input: unknown): string | null {
    return isRecord(input) ? normalizeNonEmptyString(input.sessionId) : null;
}

function readWorkspaceIdFromInput(input: unknown): string | null {
    return isRecord(input) ? normalizeNonEmptyString(input.workspaceId) : null;
}

function readTargetIdFromInput(input: unknown): string | null {
    return isRecord(input) ? normalizeNonEmptyString(input.targetId) : null;
}

function readPreviewIdFromInput(input: unknown): string | null {
    return isRecord(input) ? normalizeNonEmptyString(input.previewId) : null;
}

function readExposureIdFromInput(input: unknown): string | null {
    return isRecord(input) ? normalizeNonEmptyString(input.exposureId) : null;
}

function isAgentSurface(args: RuntimeActionExecuteArgs): boolean {
    return normalizeNonEmptyString(args.context.surface) === 'agent';
}

function previewLifecycleFailureResult(reason: LocalServicePreviewLifecycleFailureReason) {
    // Transport failures reuse the preview route-failure code; a daemon domain refusal carries a
    // `refused:<code>` reason → surface it as a stable `preview_<reason>` disabled code.
    if (reason === 'unavailable' || reason === 'request_failed' || reason === 'invalid_response') {
        return routeFailureResult('preview', reason);
    }
    return disabledResult(`local_services_preview_refused:${reason.slice('refused:'.length)}`);
}

// The openOrCreate request resolves the preview from exactly one canonical target reference
// (inventory entry / managed service / launch target) — never a raw URL. The action input carries
// these through its passthrough schema; forward only the recognised reference fields.
function readPreviewTargetReferences(input: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(input)) return {};
    const references: Record<string, unknown> = {};
    const inventoryEntryId = normalizeNonEmptyString(input.inventoryEntryId);
    if (inventoryEntryId) references.inventoryEntryId = inventoryEntryId;
    const managedServiceId = normalizeNonEmptyString(input.managedServiceId);
    if (managedServiceId) references.managedServiceId = managedServiceId;
    const launchTargetId = normalizeNonEmptyString(input.launchTargetId);
    if (launchTargetId) references.launchTargetId = launchTargetId;
    if (isRecord(input.initialPath)) references.initialPath = input.initialPath;
    return references;
}

function publishLifecycleSnapshot(
    sink: (input: Readonly<{ machineId: string; serverId?: string; snapshot: LocalServicePreviewSnapshot }>) => void,
    machineId: string,
    serverId: string | undefined,
    snapshot: LocalServicePreviewSnapshotV1,
): void {
    const normalized = normalizeLocalServicePreviewSnapshotPayload(snapshot, machineId);
    if (normalized) {
        sink({ machineId, serverId, snapshot: normalized });
    }
}

function publishPublicPreviewSnapshot(
    sink: NonNullable<CreateLocalServicesRuntimeActionExecutorInput['onPublicPreviewSnapshot']>,
    input: Readonly<{
        machineId: string;
        serverId?: string;
        sessionId?: string;
        previewId?: string;
        exposureId?: string;
        snapshot?: LocalServicePublicPreviewSnapshotV1;
    }>,
): void {
    if (!input.snapshot) {
        return;
    }
    sink({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        previewId: input.previewId,
        exposureId: input.exposureId,
        snapshot: input.snapshot,
    });
}

function resolveMachineId(input: Readonly<{
    parsedInput: unknown;
    args: RuntimeActionExecuteArgs;
    fallback?: (args: RuntimeActionExecuteArgs) => string | null | undefined;
}>): string | null {
    return readMachineIdFromInput(input.parsedInput)
        ?? normalizeNonEmptyString(input.fallback?.(input.args));
}

function routeFailureResult(
    kind: LocalServicesRouteKind,
    reason: LocalServicesRouteFailureReason,
) {
    return disabledResult(`local_services_${kind}_${reason}`);
}

export function createLocalServicesRuntimeActionExecutor(
    input: CreateLocalServicesRuntimeActionExecutorInput = {},
): RuntimeActionExecute {
    const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();
    const fetchInventorySnapshot = input.fetchInventorySnapshot ?? fetchLocalServiceInventorySnapshot;
    const onInventorySnapshot = input.onInventorySnapshot
        ?? ((published) => publishLocalServiceInventorySnapshot(
            {
                machineId: published.machineId,
                serverId: published.serverId,
                sessionId: published.sessionId,
            },
            published.snapshot,
        ));
    const fetchLauncherSnapshot = input.fetchLauncherSnapshot ?? fetchLocalServiceLauncherSnapshot;
    const onLauncherSnapshot = input.onLauncherSnapshot
        ?? ((published) => publishLocalServiceLauncherSnapshot(
            {
                machineId: published.machineId,
                serverId: published.serverId,
                sessionId: published.sessionId,
            },
            published.snapshot,
        ));
    const startLauncherTarget = input.startLauncherTarget;
    const openLauncherPreview = input.openLauncherPreview ?? openLocalServiceLauncherPreviewViaMachineRpc;
    const registerLauncherPreview = input.registerLauncherPreview ?? registerLocalServiceLauncherPreviewViaMachineRpc;
    const clearLauncherHistory = input.clearLauncherHistory ?? clearLocalServiceLauncherHistoryViaMachineRpc;
    const fetchPreviewSnapshot = input.fetchPreviewSnapshot ?? fetchLocalServicePreviewSnapshot;
    const openOrCreatePreview = input.openOrCreatePreview ?? openOrCreateLocalServicePreviewViaMachineRpc;
    const revokePreview = input.revokePreview ?? revokeLocalServicePreviewViaMachineRpc;
    const onPreviewSnapshot = input.onPreviewSnapshot
        ?? ((published) => publishLocalServicePreviewSnapshot(
            { machineId: published.machineId, serverId: published.serverId },
            published.snapshot,
        ));
    const onPublicPreviewSnapshot = input.onPublicPreviewSnapshot
        ?? ((published) => publishLocalServicePublicPreviewSnapshot(
            {
                machineId: published.machineId,
                serverId: published.serverId,
                sessionId: published.sessionId,
                previewId: published.previewId,
                exposureId: published.exposureId,
            },
            published.snapshot,
        ));
    const fetchPublicPreviewStatus = input.fetchPublicPreviewStatus;
    const createPublicPreviewExposure = input.createPublicPreviewExposure;
    const revokePublicPreviewExposure = input.revokePublicPreviewExposure;
    const copyPublicPreviewUrl = input.copyPublicPreviewUrl;
    const executeLocalServiceAction = input.executeLocalServiceAction ?? executeLocalServiceActionViaRequest;

    return async (args) => {
        if (!isLocalServicesRuntimeAction(args.actionId)) {
            return await fallback(args);
        }

        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;

        const machineId = resolveMachineId({
            parsedInput: parsed.input,
            args,
            fallback: input.resolveMachineId,
        });
        const serverId = normalizeNonEmptyString(args.context.serverId) ?? undefined;
        const sessionId = readSessionIdFromInput(parsed.input) ?? normalizeNonEmptyString(args.context.defaultSessionId) ?? undefined;
        const workspaceId = readWorkspaceIdFromInput(parsed.input) ?? undefined;

        if (args.actionId === 'localServices.inventory.list' || args.actionId === 'localServices.inventory.refresh') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const result = await fetchInventorySnapshot({
                machineId,
                serverId,
                sessionId,
                refresh: args.actionId === 'localServices.inventory.refresh',
                request: input.request,
            });
            if (!result.ok) return routeFailureResult('inventory', result.reason);
            onInventorySnapshot({ machineId, serverId, sessionId, snapshot: result.snapshot });
            return result.snapshot;
        }

        if (args.actionId === 'localServices.launcher.snapshot') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const result = await fetchLauncherSnapshot({
                machineId,
                serverId,
                sessionId,
                request: input.request,
            });
            if (!result.ok) return routeFailureResult('launcher', result.reason);
            onLauncherSnapshot({ machineId, serverId, sessionId, snapshot: result.snapshot });
            return result.snapshot;
        }

        if (args.actionId === 'localServices.launcher.start') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const targetId = readTargetIdFromInput(parsed.input);
            if (!targetId) return invalidParametersResult;
            if (!startLauncherTarget) return routeFailureResult('launcher', 'unavailable');
            const result = await startLauncherTarget({
                machineId,
                targetId,
                serverId,
                sessionId,
                workspaceId,
            });
            if (!result.ok) return routeFailureResult('launcher', result.reason);
            onLauncherSnapshot({ machineId, serverId, sessionId, snapshot: result.response.snapshot });
            return result.response;
        }

        if (args.actionId === 'localServices.launcher.openPreview') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const targetId = readTargetIdFromInput(parsed.input);
            if (!targetId) return invalidParametersResult;
            const result = await openLauncherPreview({ machineId, targetId, serverId, sessionId });
            return result.ok ? result.response : routeFailureResult('launcher', result.reason);
        }

        if (args.actionId === 'localServices.launcher.registerPreview') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const targetId = readTargetIdFromInput(parsed.input);
            if (!targetId) return invalidParametersResult;
            const result = await registerLauncherPreview({ machineId, targetId, serverId, sessionId });
            return result.ok ? result.response : routeFailureResult('launcher', result.reason);
        }

        if (args.actionId === 'localServices.launcher.history.clear') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const result = await clearLauncherHistory({ machineId, serverId, sessionId });
            if (!result.ok) return routeFailureResult('launcher', result.reason);
            onLauncherSnapshot({ machineId, serverId, sessionId, snapshot: result.response.snapshot });
            return result.response;
        }

        if (args.actionId === 'localServices.preview.status') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const result = await fetchPreviewSnapshot({
                machineId,
                serverId,
                request: input.request,
            });
            if (!result.ok) return routeFailureResult('preview', result.reason);
            // Converge the action read into the shared store so the status truth and the open pane
            // do not diverge (DUP-6).
            onPreviewSnapshot({ machineId, serverId, snapshot: result.snapshot });
            return result.snapshot;
        }

        if (args.actionId === 'localServices.preview.openOrCreate') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const request = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.safeParse({
                machineId,
                ...(sessionId ? { sessionId } : {}),
                ...readPreviewTargetReferences(parsed.input),
            });
            if (!request.success) return invalidParametersResult;
            const result = await openOrCreatePreview({ request: request.data, serverId });
            if (!result.ok) return previewLifecycleFailureResult(result.reason);
            publishLifecycleSnapshot(onPreviewSnapshot, machineId, serverId, result.response.snapshot);
            return result.response;
        }

        if (args.actionId === 'localServices.preview.revoke') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const previewId = readPreviewIdFromInput(parsed.input);
            if (!previewId) return invalidParametersResult;
            const request = DaemonLocalServicePreviewRevokeRequestV1Schema.safeParse({ machineId, previewId });
            if (!request.success) return invalidParametersResult;
            const result = await revokePreview({ request: request.data, serverId });
            if (!result.ok) return previewLifecycleFailureResult(result.reason);
            publishLifecycleSnapshot(onPreviewSnapshot, machineId, serverId, result.response.snapshot);
            return result.response;
        }

        if (args.actionId === 'localServices.publicPreview.status') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const request = DaemonLocalServicePublicPreviewStatusRequestV1Schema.safeParse({
                machineId,
                ...(sessionId ? { sessionId } : {}),
                ...(readPreviewIdFromInput(parsed.input) ? { previewId: readPreviewIdFromInput(parsed.input) } : {}),
                ...(readExposureIdFromInput(parsed.input) ? { exposureId: readExposureIdFromInput(parsed.input) } : {}),
            });
            if (!request.success) return invalidParametersResult;
            if (!fetchPublicPreviewStatus) return routeFailureResult('public_preview', 'unavailable');
            const result = await fetchPublicPreviewStatus({
                request: request.data,
                serverId,
            });
            if (!result.ok) return routeFailureResult('public_preview', result.reason);
            publishPublicPreviewSnapshot(onPublicPreviewSnapshot, {
                machineId,
                serverId,
                sessionId: request.data.sessionId,
                previewId: request.data.previewId,
                exposureId: request.data.exposureId,
                snapshot: result.snapshot,
            });
            return isAgentSurface(args)
                ? redactLocalServicePublicPreviewSnapshotForAgentEgress(result.snapshot)
                : result.snapshot;
        }

        if (args.actionId === 'localServices.publicPreview.create') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const request = DaemonLocalServicePublicPreviewCreateRequestV1Schema.safeParse({
                ...(isRecord(parsed.input) ? parsed.input : {}),
                machineId,
                sessionId,
            });
            if (!request.success) return invalidParametersResult;
            if (!createPublicPreviewExposure) return routeFailureResult('public_preview', 'unavailable');
            const result = await createPublicPreviewExposure({
                request: request.data,
                serverId,
            });
            if (!result.ok) return routeFailureResult('public_preview', result.reason);
            publishPublicPreviewSnapshot(onPublicPreviewSnapshot, {
                machineId,
                serverId,
                sessionId: request.data.sessionId,
                previewId: request.data.previewId,
                snapshot: result.response.snapshot,
            });
            return isAgentSurface(args)
                ? redactLocalServicePublicPreviewCreateResponseForAgentEgress(result.response)
                : result.response;
        }

        if (args.actionId === 'localServices.publicPreview.revoke') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const request = DaemonLocalServicePublicPreviewRevokeRequestV1Schema.safeParse({
                ...(isRecord(parsed.input) ? parsed.input : {}),
                machineId,
                sessionId,
            });
            if (!request.success) return invalidParametersResult;
            if (!revokePublicPreviewExposure) return routeFailureResult('public_preview', 'unavailable');
            const result = await revokePublicPreviewExposure({
                request: request.data,
                serverId,
            });
            if (!result.ok) return routeFailureResult('public_preview', result.reason);
            publishPublicPreviewSnapshot(onPublicPreviewSnapshot, {
                machineId,
                serverId,
                sessionId: request.data.sessionId,
                previewId: request.data.previewId,
                exposureId: request.data.exposureId,
                snapshot: result.response.snapshot,
            });
            return isAgentSurface(args)
                ? redactLocalServicePublicPreviewRevokeResponseForAgentEgress(result.response)
                : result.response;
        }

        if (args.actionId === 'localServices.publicPreview.copyUrl') {
            if (!machineId) return disabledResult('local_services_machine_unavailable');
            const request = DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema.safeParse({
                ...(isRecord(parsed.input) ? parsed.input : {}),
                machineId,
                sessionId,
            });
            if (!request.success) return invalidParametersResult;
            if (!copyPublicPreviewUrl) return routeFailureResult('public_preview', 'unavailable');
            const result = await copyPublicPreviewUrl({
                request: request.data,
                serverId,
            });
            return result.ok ? result.response : routeFailureResult('public_preview', result.reason);
        }

        if (args.actionId.startsWith('localServices.actions.')) {
            const request = LocalServiceActionRequestV1Schema.safeParse(parsed.input);
            if (!request.success) return invalidParametersResult;
            const result = await executeLocalServiceAction({
                request: request.data,
                serverId,
                executeRequest: input.request,
            });
            return result.ok ? result.result : routeFailureResult('action', result.reason);
        }

        return disabledResult('local_services_runtime_action_unbacked');
    };
}
