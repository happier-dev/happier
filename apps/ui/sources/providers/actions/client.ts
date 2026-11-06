import { safeParse, type z } from 'zod/mini';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema, isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 as outputs, PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1,
    PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createProviderErrorV1, ProviderErrorV1Schema, providerErrorFromRpcFailure } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderProfileMigrationPreviewResponseV1Schema, DaemonProviderProfileMigrationConfirmResponseV1Schema,
    DaemonProviderProfileMigrationConflictConfirmResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resumeActionExecutionResult, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ProviderActionPendingApprovalError } from './ProviderActionPendingApprovalError';
export { ProviderActionPendingApprovalError } from './ProviderActionPendingApprovalError';
export { providerErrorFromRpcFailure } from '@/providers/rpc/client';

type IncumbentClient = typeof import('@/providers/rpc/client');
type InvocationScope = Readonly<{ serverId: string | null; accountId?: string; signal?: AbortSignal; onDispatched?: () => void }>;
export type ProviderActionApprovalOptions = Pick<UiActionOperation, 'confirmed'> & Pick<ActionExecutorContext, 'interactivePresentation'> & Readonly<{
    scope: ServerAccountScope;
    signal: AbortSignal;
    onApprovalPending: (registration: ActionApprovalRegistration) => void;
    /** Retains only this mounted invocation, without changing Action approval policy. */
    retainInvocationSignal?: AbortSignal;
}>;
type ProviderActionMethod<Name extends keyof IncumbentClient> = IncumbentClient[Name] extends (input: infer Input) => Promise<infer Output>
    ? (input: Input, approval?: ProviderActionApprovalOptions) => Promise<Output> : never;

async function invoke<TSchema extends z.core.$ZodType>(actionId: ActionId, input: unknown,
    schema: TSchema, scope: InvocationScope, approvalOptions?: ProviderActionApprovalOptions,
): Promise<z.output<TSchema>> {
    if (approvalOptions && (scope.serverId && !areServerProfileIdentifiersEquivalent(scope.serverId, approvalOptions.scope.serverId)
        || scope.accountId && scope.accountId !== approvalOptions.scope.accountId)) {
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    const merged = mergeAbortSignals([scope.signal, approvalOptions?.signal, approvalOptions?.retainInvocationSignal]);
    const signal = merged.signal;
    try {
        // The dispatch owner preserves acknowledged mutations after Account retirement.
        // Only the deferred Artifact follower may race the caller's local interest.
        const executor = createDefaultActionExecutor({ onProviderRpcDispatched: scope.onDispatched,
            ...(approvalOptions?.retainInvocationSignal && signal ? {
                hostActionApprovalLifetime: { actionId, signal, surface: 'ui' as const },
                // The blocking executor owns the result; this registration only
                // presents its Artifact and retires with the mounted invocation.
                onBlockingApprovalPending: pending => approvalOptions.onApprovalPending({
                    ...pending, scope: approvalOptions.scope, refreshAfterExecution: false,
                    onExecuted: async () => 'consumed',
                }),
            } : {}),
        });
        const result = await (approvalOptions?.confirmed ? executor.executeConfirmed : executor.execute)(actionId, input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            ...(approvalOptions?.interactivePresentation ? { interactivePresentation: approvalOptions.interactivePresentation } : {}),
            ...(scope.serverId || approvalOptions?.scope.serverId ? { serverId: scope.serverId ?? approvalOptions?.scope.serverId } : {}),
            ...(scope.accountId || approvalOptions?.scope.accountId ? { expectedAccountId: scope.accountId ?? approvalOptions?.scope.accountId } : {}),
            ...(signal ? { signal } : {}),
        });
        if (!result.ok) throw actionFailure(result);
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success && !approvalOptions) throw new ProviderActionPendingApprovalError(approval.data);
        const settlement = approvalOptions ? await resumeActionExecutionResult({
            result, actionId, actionInput: input, scope: approvalOptions.scope, signal,
            onApprovalPending: approvalOptions.onApprovalPending,
        }) : result;
        if (!settlement.ok) throw actionFailure(settlement);
        const parsed = safeParse(schema, settlement.result);
        if (parsed.success) return parsed.data;
        throw getActionSpec(actionId).sideEffectClass === 'read'
            ? createProviderErrorV1('provider_rpc_response_invalid') : parsed.error;
    } catch (caught) {
        // A declined approval is the person's decision, not a Provider failure: its code survives for the caller.
        if (getActionSpec(actionId).sideEffectClass !== 'read'
            || (caught as { code?: unknown } | null)?.code === 'action_interactive_review_required'
            || isActionApprovalDeclinedErrorCode((caught as { code?: unknown } | null)?.code)
            || caught instanceof ProviderActionPendingApprovalError
            || ProviderErrorV1Schema.safeParse(caught).success) throw caught;
        throw providerErrorFromRpcFailure(caught);
    } finally {
        merged.dispose();
    }
}
function actionFailure(result: Readonly<{ error: string; errorCode: string; details?: unknown }>): unknown {
        const provider = ProviderErrorV1Schema.safeParse(result.details);
        return provider.success ? provider.data : Object.assign(new Error(result.error), { code: result.errorCode, details: result.details });
}

// UI callers supply schema inputs; the Action executor owns parsing and branded output.
type ProviderActionInput<Id extends keyof typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1> = z.input<(typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[Id]>;
export type ProviderConnectionActionInputV1 = ProviderActionInput<(typeof PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1)[keyof typeof PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1]>;
export type ProviderModelSettingsActionInputV1 = ProviderActionInput<(typeof PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1)[keyof typeof PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1]>;
export const describeProviderConnections = async (input: ProviderActionInput<'providers.connections.describe'> & InvocationScope, approval?: ProviderActionApprovalOptions) => {
    const { serverId, signal, accountId, onDispatched, ...request } = input;
    return invoke('providers.connections.describe', request, outputs['providers.connections.describe'], { serverId, signal, accountId, onDispatched }, approval);
};
export const mutateProviderConnection = (input: Readonly<{ serverId: string | null; request: ProviderConnectionActionInputV1 }>, approval?: ProviderActionApprovalOptions) => invoke(
    PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[input.request.action], input.request,
    outputs['providers.connections.update'], input, approval,
);
export const probeProviderConnection: ProviderActionMethod<'probeProviderConnection'> = async (input, approval) => {
    const { serverId, ...request } = input;
    return invoke('providers.probe', request, outputs['providers.probe'], { serverId }, approval);
};
export const refreshProviderConnectionUsage = async (
    input: ProviderActionInput<'providers.usage.refresh'> & InvocationScope,
    approval?: ProviderActionApprovalOptions,
) => {
    const { serverId, signal, accountId, onDispatched, ...request } = input;
    return invoke('providers.usage.refresh', request, outputs['providers.usage.refresh'],
        { serverId, signal, accountId, onDispatched }, approval);
};
export const probeProviderDraft: ProviderActionMethod<'probeProviderDraft'> = async (input, approval) => {
    const { serverId, ...request } = input;
    return invoke('providers.probe', { kind: 'draft', ...request }, outputs['providers.probe'], { serverId }, approval);
};
export const describeProviderModels = async (input: ProviderActionInput<'providers.models.projection' | 'providers.models.refresh'> & Readonly<{ serverId: string | null }>, approval?: ProviderActionApprovalOptions) => {
    const { serverId, ...request } = input;
    const id = input.forceRefresh ? 'providers.models.refresh' : 'providers.models.projection';
    return invoke(id, request, outputs[id], { serverId }, approval);
};
export const describeProviderConnectionModels = async (input: ProviderActionInput<'providers.models.list'> & Readonly<{ serverId: string | null }>, approval?: ProviderActionApprovalOptions) => {
    const { serverId, ...request } = input;
    return invoke('providers.models.list', request, outputs['providers.models.list'], { serverId }, approval);
};
export const loadProviderModel: ProviderActionMethod<'loadProviderModel'> = async (input, approval) => {
    const { serverId, signal, ...request } = input;
    return invoke('providers.models.load', { action: 'load', ...request }, outputs['providers.models.load'], { serverId, signal }, approval);
};
export const cancelProviderModelLoad: ProviderActionMethod<'cancelProviderModelLoad'> = async (input, approval) => {
    const { serverId, ...request } = input;
    return invoke('providers.models.cancel_load', { action: 'cancel', ...request }, outputs['providers.models.cancel_load'], { serverId }, approval);
};
export const mutateProviderModelSettings = (input: Readonly<{ serverId: string | null; request: ProviderModelSettingsActionInputV1 }>, approval?: ProviderActionApprovalOptions) => invoke(
    PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1[input.request.action], input.request,
    outputs['providers.models.manual.add'], input, approval,
);
export function setProviderModelPickerVisibility(input: Readonly<{
    serverId: string | null; connectionId: string; shown: boolean | null;
}>, approval?: ProviderActionApprovalOptions) {
    const { serverId, connectionId, shown } = input;
    return invoke('providers.models.source_visibility.set', { action: 'setConnectionVisibility', connectionId, shown },
        outputs['providers.models.source_visibility.set'], { serverId }, approval);
}
export const setProviderDefaultModelSelection = async (input: ProviderActionInput<'providers.defaults.set'> & Readonly<{ serverId: string | null }>, approval?: ProviderActionApprovalOptions) => {
    const { serverId, ...request } = input;
    return invoke('providers.defaults.set', request, outputs['providers.defaults.set'], { serverId }, approval);
};
export const describeProviderBindingStatus: ProviderActionMethod<'describeProviderBindingStatus'> = (input, approval) => invoke(
    'providers.binding.status', input.request, outputs['providers.binding.status'], input, approval,
);
export const prepareLegacyProfileMigrationSource: ProviderActionMethod<'prepareLegacyProfileMigrationSource'> = (input, approval) => invoke(
    'providers.legacy.prepare', input.request, outputs['providers.legacy.prepare'], input, approval,
);
// The Profile family already owns conversion. These adapters consume it instead of duplicating it.
export const previewLegacyProfileMigration: ProviderActionMethod<'previewLegacyProfileMigration'> = (input, approval) => invoke(
    'launch_profiles.legacy.preview', input.request, DaemonProviderProfileMigrationPreviewResponseV1Schema, input, approval,
);
export const confirmLegacyProfileMigration: ProviderActionMethod<'confirmLegacyProfileMigration'> = (input, approval) => invoke(
    'launch_profiles.legacy.convert', input.request, DaemonProviderProfileMigrationConfirmResponseV1Schema, input, approval,
);
export const confirmLegacyProfileMigrationConflict: ProviderActionMethod<'confirmLegacyProfileMigrationConflict'> = (input, approval) => invoke(
    'launch_profiles.legacy.resolve_conflict', input.request, DaemonProviderProfileMigrationConflictConfirmResponseV1Schema, input, approval,
);
