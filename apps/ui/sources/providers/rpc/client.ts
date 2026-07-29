import {
    DaemonProviderConnectionMutationRequestV1Schema,
    DaemonProviderConnectionMutationResponseV1Schema,
    DaemonProviderConnectionsDescribeRequestV1Schema,
    DaemonProviderConnectionsDescribeResponseV1Schema,
    DaemonProviderProbeRequestV1Schema,
    DaemonProviderProbeResponseV1Schema,
    DaemonProviderModelProjectionRequestV1Schema,
    DaemonProviderModelProjectionResponseV1Schema,
    DaemonProviderModelSettingsMutationRequestV1Schema,
    DaemonProviderModelSettingsMutationResponseV1Schema,
    DaemonProviderBindingStatusRequestV1Schema,
    DaemonProviderBindingStatusResponseV1Schema,
    DaemonProviderModelsRequestV1Schema,
    DaemonProviderModelsResponseV1Schema,
    DaemonProviderModelLoadRequestV1Schema,
    DaemonProviderModelLoadResponseV1Schema,
    DaemonProviderProfileMigrationPreviewRequestV1Schema,
    DaemonProviderProfileMigrationPreviewResponseV1Schema,
    DaemonProviderProfileMigrationConfirmRequestV1Schema,
    DaemonProviderProfileMigrationConfirmResponseV1Schema,
    DaemonProviderProfileMigrationConflictConfirmRequestV1Schema,
    DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
    RPC_METHODS,
    type DaemonProviderConnectionMutationResponseV1,
    type DaemonProviderConnectionsDescribeResponseV1,
    type DaemonProviderProbeResponseV1,
    type DaemonProviderModelProjectionResponseV1,
    type DaemonProviderModelSettingsMutationResponseV1,
    type DaemonProviderBindingStatusResponseV1,
    type DaemonProviderModelsResponseV1,
    type DaemonProviderModelLoadResponseV1,
    type DaemonProviderProfileMigrationPreviewResponseV1,
    type DaemonProviderProfileMigrationConfirmResponseV1,
    type DaemonProviderProfileMigrationConflictConfirmResponseV1,
} from '@happier-dev/protocol/rpc';
import {
    createProviderErrorV1,
    ProviderErrorV1Schema,
    type CustomProviderTemplateV1,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import type { z } from 'zod';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type ProviderRpcErrorContext = Readonly<{
    connectionId?: string;
    machineId?: string;
    sourceProfileId?: string;
}>;

type ProviderRpcOperation = 'read' | 'mutation';

async function requestProviderRpcResponse<TSchema extends z.ZodType>(
    schema: TSchema,
    operation: ProviderRpcOperation,
    context: ProviderRpcErrorContext,
    request: () => Promise<unknown>,
): Promise<z.output<TSchema>> {
    try {
        const parsed = schema.safeParse(await request());
        if (!parsed.success) {
            throw createProviderErrorV1(
                operation === 'mutation'
                    ? 'provider_rpc_mutation_outcome_unknown'
                    : 'provider_rpc_response_invalid',
                context,
            );
        }
        return parsed.data;
    } catch (caught) {
        const typed = ProviderErrorV1Schema.safeParse(caught);
        if (typed.success) throw typed.data;
        if (operation === 'mutation') {
            throw createProviderErrorV1('provider_rpc_mutation_outcome_unknown', context);
        }
        throw caught;
    }
}

function modelSettingsMutationConnectionId(
    payload: z.output<typeof DaemonProviderModelSettingsMutationRequestV1Schema>,
): string | undefined {
    switch (payload.action) {
        case 'manualAdd':
        case 'manualRemove':
        case 'confirmExperimental':
            return payload.connectionId;
        case 'setVisibility':
            return payload.ref.providerConnectionId ?? undefined;
        case 'resetVisibility':
            return payload.scope.kind === 'connection' ? payload.scope.connectionId : undefined;
        case 'bulkVisibility': {
            const connectionId = payload.changes[0]?.ref.providerConnectionId;
            if (!connectionId) return undefined;
            return payload.changes.every((change) => change.ref.providerConnectionId === connectionId)
                ? connectionId
                : undefined;
        }
    }
}

/**
 * The single UI boundary for failures thrown before a Provider RPC can return
 * its typed response union. Never surface transport messages as domain codes.
 */
export function providerErrorFromRpcFailure(
    caught: unknown,
    context: Readonly<{ connectionId?: string; machineId?: string; sourceProfileId?: string }> = {},
): ProviderErrorV1 {
    const typed = ProviderErrorV1Schema.safeParse(caught);
    return typed.success
        ? typed.data
        : createProviderErrorV1('provider_endpoint_unavailable', context);
}

export async function describeProviderConnections(input: Readonly<{
    machineId: string;
    serverId: string | null;
    connectionId?: string;
    authoringPreview?: z.input<typeof DaemonProviderConnectionsDescribeRequestV1Schema>['authoringPreview'];
}>): Promise<DaemonProviderConnectionsDescribeResponseV1> {
    const payload = DaemonProviderConnectionsDescribeRequestV1Schema.parse({
        machineId: input.machineId,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.authoringPreview ? { authoringPreview: input.authoringPreview } : {}),
    });
    return await requestProviderRpcResponse(DaemonProviderConnectionsDescribeResponseV1Schema, 'read', {
        machineId: input.machineId,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        payload,
    }));
}

export async function mutateProviderConnection(input: Readonly<{
    serverId: string | null;
    request: z.input<typeof DaemonProviderConnectionMutationRequestV1Schema>;
}>): Promise<DaemonProviderConnectionMutationResponseV1> {
    const payload = DaemonProviderConnectionMutationRequestV1Schema.parse(input.request);
    return await requestProviderRpcResponse(DaemonProviderConnectionMutationResponseV1Schema, 'mutation', {
        machineId: payload.machineId,
        ...('connectionId' in payload ? { connectionId: payload.connectionId } : {}),
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
        payload,
    }));
}

async function probeProvider(
    serverId: string | null,
    request: z.input<typeof DaemonProviderProbeRequestV1Schema>,
): Promise<DaemonProviderProbeResponseV1> {
    const payload = DaemonProviderProbeRequestV1Schema.parse(request);
    return await requestProviderRpcResponse(DaemonProviderProbeResponseV1Schema, 'read', {
        machineId: payload.machineId,
        ...('connectionId' in payload ? { connectionId: payload.connectionId } : {}),
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROBE,
        payload,
    }));
}

export async function probeProviderConnection(input: Readonly<{
    machineId: string;
    serverId: string | null;
    connectionId: string;
}>): Promise<DaemonProviderProbeResponseV1> {
    return await probeProvider(input.serverId, {
        machineId: input.machineId,
        connectionId: input.connectionId,
    });
}

export async function probeProviderDraft(input: Readonly<{
    machineId: string;
    serverId: string | null;
    draftConnectionId: string;
    template: CustomProviderTemplateV1;
    savedSecretId: string | null;
    actionNonce: string;
}>): Promise<DaemonProviderProbeResponseV1> {
    return await probeProvider(input.serverId, {
        kind: 'draft',
        machineId: input.machineId,
        draftConnectionId: input.draftConnectionId,
        template: input.template,
        savedSecretId: input.savedSecretId,
        actionNonce: input.actionNonce,
    });
}

export async function describeProviderModels(input: Readonly<{
    machineId: string;
    serverId: string | null;
    agentTargetKey: string;
    mode?: 'picker' | 'management';
    currentSelection?: z.input<typeof DaemonProviderModelProjectionRequestV1Schema>['currentSelection'];
}>): Promise<DaemonProviderModelProjectionResponseV1> {
    const payload = DaemonProviderModelProjectionRequestV1Schema.parse({
        machineId: input.machineId,
        agentTargetKey: input.agentTargetKey,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.currentSelection ? { currentSelection: input.currentSelection } : {}),
    });
    return await requestProviderRpcResponse(DaemonProviderModelProjectionResponseV1Schema, 'read', {
        machineId: payload.machineId,
        ...(payload.currentSelection?.providerConnectionId
            ? { connectionId: payload.currentSelection.providerConnectionId }
            : {}),
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        payload,
    }));
}

export async function describeProviderConnectionModels(input: Readonly<{
    machineId: string;
    serverId: string | null;
    connectionId: string;
}>): Promise<DaemonProviderModelsResponseV1> {
    const payload = DaemonProviderModelsRequestV1Schema.parse({
        machineId: input.machineId,
        connectionId: input.connectionId,
    });
    return await requestProviderRpcResponse(DaemonProviderModelsResponseV1Schema, 'read', {
        machineId: payload.machineId,
        connectionId: payload.connectionId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODELS,
        payload,
    }));
}

export async function loadProviderModel(input: Readonly<{
    machineId: string;
    serverId: string | null;
    connectionId: string;
    modelId: string;
    signal?: AbortSignal;
}>): Promise<DaemonProviderModelLoadResponseV1> {
    const payload = DaemonProviderModelLoadRequestV1Schema.parse({
        action: 'load',
        machineId: input.machineId,
        connectionId: input.connectionId,
        modelId: input.modelId,
    });
    return await requestProviderRpcResponse(DaemonProviderModelLoadResponseV1Schema, 'mutation', {
        machineId: payload.machineId,
        connectionId: payload.connectionId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
        payload,
        ...(input.signal ? { signal: input.signal } : {}),
    }));
}

export async function cancelProviderModelLoad(input: Readonly<{
    machineId: string;
    serverId: string | null;
    connectionId: string;
    modelId: string;
}>): Promise<DaemonProviderModelLoadResponseV1> {
    const payload = DaemonProviderModelLoadRequestV1Schema.parse({
        action: 'cancel',
        machineId: input.machineId,
        connectionId: input.connectionId,
        modelId: input.modelId,
    });
    return await requestProviderRpcResponse(DaemonProviderModelLoadResponseV1Schema, 'mutation', {
        machineId: payload.machineId,
        connectionId: payload.connectionId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
        payload,
    }));
}

export async function mutateProviderModelSettings(input: Readonly<{
    serverId: string | null;
    request: z.input<typeof DaemonProviderModelSettingsMutationRequestV1Schema>;
}>): Promise<DaemonProviderModelSettingsMutationResponseV1> {
    const payload = DaemonProviderModelSettingsMutationRequestV1Schema.parse(input.request);
    const connectionId = modelSettingsMutationConnectionId(payload);
    return await requestProviderRpcResponse(DaemonProviderModelSettingsMutationResponseV1Schema, 'mutation', {
        machineId: payload.machineId,
        ...(connectionId ? { connectionId } : {}),
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE,
        payload,
    }));
}

export async function describeProviderBindingStatus(input: Readonly<{
    serverId: string | null;
    request: z.input<typeof DaemonProviderBindingStatusRequestV1Schema>;
}>): Promise<DaemonProviderBindingStatusResponseV1> {
    const payload = DaemonProviderBindingStatusRequestV1Schema.parse(input.request);
    return await requestProviderRpcResponse(DaemonProviderBindingStatusResponseV1Schema, 'read', {
        machineId: payload.machineId,
        connectionId: payload.launchBinding.connectionId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS,
        payload,
    }));
}

export async function previewLegacyProfileMigration(input: Readonly<{
    serverId: string | null;
    request: z.input<typeof DaemonProviderProfileMigrationPreviewRequestV1Schema>;
}>): Promise<DaemonProviderProfileMigrationPreviewResponseV1> {
    const payload = DaemonProviderProfileMigrationPreviewRequestV1Schema.parse(input.request);
    return await requestProviderRpcResponse(DaemonProviderProfileMigrationPreviewResponseV1Schema, 'read', {
        machineId: payload.machineId,
        sourceProfileId: payload.sourceProfileId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW,
        payload,
    }));
}

export async function confirmLegacyProfileMigration(input: Readonly<{
    serverId: string | null;
    request: z.input<typeof DaemonProviderProfileMigrationConfirmRequestV1Schema>;
}>): Promise<DaemonProviderProfileMigrationConfirmResponseV1> {
    const payload = DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(input.request);
    return await requestProviderRpcResponse(DaemonProviderProfileMigrationConfirmResponseV1Schema, 'mutation', {
        machineId: payload.machineId,
        sourceProfileId: payload.sourceProfileId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM,
        payload,
    }));
}

export async function confirmLegacyProfileMigrationConflict(input: Readonly<{
    serverId: string | null;
    request: z.input<typeof DaemonProviderProfileMigrationConflictConfirmRequestV1Schema>;
}>): Promise<DaemonProviderProfileMigrationConflictConfirmResponseV1> {
    const payload = DaemonProviderProfileMigrationConflictConfirmRequestV1Schema.parse(input.request);
    return await requestProviderRpcResponse(DaemonProviderProfileMigrationConflictConfirmResponseV1Schema, 'mutation', {
        machineId: payload.machineId,
        sourceProfileId: payload.sourceProfileId,
    }, () => machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM,
        payload,
    }));
}
