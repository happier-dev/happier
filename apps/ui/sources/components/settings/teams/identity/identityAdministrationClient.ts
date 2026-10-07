import type { z } from 'zod';
import {
    type TeamDirectoryActionIdV1,
    type TeamDirectoryGroupsListInputV1,
    type TeamDirectoryGroupPageV1,
    type TeamDirectoryPeopleListInputV1,
    type TeamDirectoryPeoplePageV1,
    type TeamDirectorySourceCreateInputV1,
    type TeamDirectorySourcePageV1,
    type TeamDirectorySourceRefInputV1,
    type TeamDirectorySourceRemoveResultV1,
    type TeamDirectorySourceRemovalPreflightV1,
    type TeamDirectorySourceSetupListInputV1,
    type TeamDirectorySourceSetupOptionsV1,
    type TeamDirectorySourceSummaryV1,
    type TeamDirectorySourceSyncResultV1,
    type TeamExternalGroupBindingActionIdV1,
    type TeamExternalGroupBindingRemoveInputV1,
    type TeamExternalGroupBindingRemoveResultV1,
    type TeamExternalGroupBindingSetInputV1,
    type TeamExternalGroupBindingV1,
    type TeamExternalGroupBindingsListInputV1,
    type TeamExternalGroupBindingsPageV1,
    TeamIdentityConnectionCreateInputV1Schema,
    TeamIdentityConnectionListInputV1Schema,
    TeamIdentityConnectionListResultV1Schema,
    TeamIdentityConnectionMutationResultV1Schema,
    TeamIdentityConnectionSettingsUpdateInputV1Schema,
    TeamIdentityConnectionRefInputV1Schema,
    TeamIdentityConnectionRemoveResultV1Schema,
    TeamIdentityConnectionTestConsumeInputV1Schema,
    TeamIdentityConnectionTestConsumeResultV1Schema,
    TeamIdentityConnectionTestStartInputV1Schema,
    TeamIdentityConnectionTestStartResultV1Schema,
    TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema,
    TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema,
    TeamIdentityWorkosConnectionSetInputV1Schema,
    TeamIdentityWorkosConnectionCreateInputV1Schema,
    TeamIdentityWorkosConnectionCreateResultV1Schema,
    TeamIdentityWorkosReconcileInputV1Schema,
    TeamIdentityWorkosReconcileResultV1Schema,
    TeamDirectorySourceRemovalPreflightV1Schema,
    TeamIdentityConnectionRemovalPreflightV1Schema,
} from '@happier-dev/protocol/teams';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { homeDomainActionInputSchemaV1, homeDomainActionOutputSchemaV1, type HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import type { TeamIdentityActionIdV1 } from '@happier-dev/protocol/teams/identity/actionIds';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { resolveApprovalSettledReadFailure, resolveIdentityAdministrationFailureRetryable } from '@/components/settings/identity/identityAdministrationFailure';
import {
    awaitActionApprovalResult,
    createHomeActionApprovalContinuation,
    type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';

type TeamIdentityActionInputMap = Readonly<{
    'teams.identity.connections.list': z.infer<typeof TeamIdentityConnectionListInputV1Schema>;
    'teams.identity.connections.create': z.infer<typeof TeamIdentityConnectionCreateInputV1Schema>;
    'teams.identity.connections.settings.update': z.infer<typeof TeamIdentityConnectionSettingsUpdateInputV1Schema>;
    'teams.identity.connections.enable': z.infer<typeof TeamIdentityConnectionRefInputV1Schema>;
    'teams.identity.connections.disable': z.infer<typeof TeamIdentityConnectionRefInputV1Schema>;
    'teams.identity.connections.remove.preview': z.infer<typeof TeamIdentityConnectionRefInputV1Schema>;
    'teams.identity.connections.remove': z.infer<typeof TeamIdentityConnectionRefInputV1Schema>;
    'teams.identity.connections.test.start': z.infer<typeof TeamIdentityConnectionTestStartInputV1Schema>;
    'teams.identity.connections.test.consume': z.infer<typeof TeamIdentityConnectionTestConsumeInputV1Schema>;
    'teams.identity.workos.adminPortalLink.create': z.infer<typeof TeamIdentityWorkosAdminPortalLinkCreateInputV1Schema>;
    'teams.identity.workos.connection.create': z.infer<typeof TeamIdentityWorkosConnectionCreateInputV1Schema>;
    'teams.identity.workos.reconcile': z.infer<typeof TeamIdentityWorkosReconcileInputV1Schema>;
    'teams.identity.workos.connection.set': z.infer<typeof TeamIdentityWorkosConnectionSetInputV1Schema>;
}>;

type TeamIdentityActionOutputMap = Readonly<{
    'teams.identity.connections.list': z.infer<typeof TeamIdentityConnectionListResultV1Schema>;
    'teams.identity.connections.create': z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;
    'teams.identity.connections.settings.update': z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;
    'teams.identity.connections.enable': z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;
    'teams.identity.connections.disable': z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;
    'teams.identity.connections.remove.preview': z.infer<typeof TeamIdentityConnectionRemovalPreflightV1Schema>;
    'teams.identity.connections.remove': z.infer<typeof TeamIdentityConnectionRemoveResultV1Schema>;
    'teams.identity.connections.test.start': z.infer<typeof TeamIdentityConnectionTestStartResultV1Schema>;
    'teams.identity.connections.test.consume': z.infer<typeof TeamIdentityConnectionTestConsumeResultV1Schema>;
    'teams.identity.workos.adminPortalLink.create': z.infer<typeof TeamIdentityWorkosAdminPortalLinkCreateResultV1Schema>;
    'teams.identity.workos.connection.create': z.infer<typeof TeamIdentityWorkosConnectionCreateResultV1Schema>;
    'teams.identity.workos.reconcile': z.infer<typeof TeamIdentityWorkosReconcileResultV1Schema>;
    'teams.identity.workos.connection.set': z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;
}>;

type TeamDirectoryActionInputMap = Readonly<{
    'teams.directory.sourceSetup.list': TeamDirectorySourceSetupListInputV1;
    'teams.directory.sources.list': import('@happier-dev/protocol/teams').TeamDirectorySourcesListInputV1;
    'teams.directory.sources.get': TeamDirectorySourceRefInputV1;
    'teams.directory.people.list': TeamDirectoryPeopleListInputV1;
    'teams.directory.groups.list': TeamDirectoryGroupsListInputV1;
    'teams.directory.sources.create': TeamDirectorySourceCreateInputV1;
    'teams.directory.sources.sync': TeamDirectorySourceRefInputV1;
    'teams.directory.sources.pause': TeamDirectorySourceRefInputV1;
    'teams.directory.sources.resume': TeamDirectorySourceRefInputV1;
    'teams.directory.sources.remove.preview': TeamDirectorySourceRefInputV1;
    'teams.directory.sources.remove': TeamDirectorySourceRefInputV1;
}>;

type TeamDirectoryActionOutputMap = Readonly<{
    'teams.directory.sourceSetup.list': TeamDirectorySourceSetupOptionsV1;
    'teams.directory.sources.list': TeamDirectorySourcePageV1;
    'teams.directory.sources.get': TeamDirectorySourceSummaryV1;
    'teams.directory.people.list': TeamDirectoryPeoplePageV1;
    'teams.directory.groups.list': TeamDirectoryGroupPageV1;
    'teams.directory.sources.create': TeamDirectorySourceSummaryV1;
    'teams.directory.sources.sync': TeamDirectorySourceSyncResultV1;
    'teams.directory.sources.pause': TeamDirectorySourceSummaryV1;
    'teams.directory.sources.resume': TeamDirectorySourceSummaryV1;
    'teams.directory.sources.remove.preview': TeamDirectorySourceRemovalPreflightV1;
    'teams.directory.sources.remove': TeamDirectorySourceRemoveResultV1;
}>;

type TeamExternalGroupBindingActionInputMap = Readonly<{
    'teams.externalGroupBindings.list': TeamExternalGroupBindingsListInputV1;
    'teams.externalGroupBindings.set': TeamExternalGroupBindingSetInputV1;
    'teams.externalGroupBindings.remove': TeamExternalGroupBindingRemoveInputV1;
}>;

type TeamExternalGroupBindingActionOutputMap = Readonly<{
    'teams.externalGroupBindings.list': TeamExternalGroupBindingsPageV1;
    'teams.externalGroupBindings.set': TeamExternalGroupBindingV1;
    'teams.externalGroupBindings.remove': TeamExternalGroupBindingRemoveResultV1;
}>;

export type TeamIdentityActionInput<TActionId extends TeamIdentityActionIdV1> =
    TeamIdentityActionInputMap[TActionId];
export type TeamIdentityActionOutput<TActionId extends TeamIdentityActionIdV1> =
    TeamIdentityActionOutputMap[TActionId];
export type TeamExternalGroupBindingActionOutput<TActionId extends TeamExternalGroupBindingActionIdV1> =
    TeamExternalGroupBindingActionOutputMap[TActionId];

export type IdentityAdministrationExecuteOptions<TValue> = Readonly<{
    signal?: AbortSignal;
    onApprovalSucceeded?: (value: TValue) => void | Promise<void>;
    onApprovalFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>;

function approvalCallbacks<TValue>(
    options: IdentityAdministrationExecuteOptions<TValue> | undefined,
): Readonly<{
    onSucceeded?: (value: TValue) => void | Promise<void>;
    onFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}> | undefined {
    if (!options?.onApprovalSucceeded && !options?.onApprovalFailed) return undefined;
    return Object.freeze({
        ...(options.onApprovalSucceeded ? { onSucceeded: options.onApprovalSucceeded } : {}),
        ...(options.onApprovalFailed ? { onFailed: options.onApprovalFailed } : {}),
    });
}

export type IdentityAdministrationActionResult<TValue> =
    | Readonly<{ ok: true; value: TValue }>
    | Readonly<{ ok: false; failure: Readonly<{ code: string; retryable: boolean; domainFailure?: HomeDomainFailure }> }>
    | Readonly<{
        ok: false;
        approvalPending: true;
        artifactId: string;
        failure: Readonly<{ code: 'approval_pending'; retryable: false }>;
    }>;

export type IdentityAdministrationReadResult<TValue> = Exclude<IdentityAdministrationActionResult<TValue>, { approvalPending: true }>;

/**
 * Keep a mounted read's ordinary Promise pending while its existing approval
 * continuation owns the result. The read executes once; cancellation releases
 * only this caller's interest, never the durable approval or its effect.
 * Callers name `TValue`: contextually typing the `options` lambda parameter
 * would otherwise fix it to `unknown` before the return type is inferred.
 */
export function executeIdentityAdministrationRead<TValue>(
    execute: (options: IdentityAdministrationExecuteOptions<TValue>) => Promise<IdentityAdministrationActionResult<TValue>>,
    signal?: AbortSignal,
): Promise<IdentityAdministrationReadResult<TValue>> {
    return awaitActionApprovalResult<TValue, IdentityAdministrationReadResult<TValue>>({
        execute,
        signal,
        succeeded: (value) => ({ ok: true, value }),
        aborted: () => ({ ok: false, failure: { code: 'aborted', retryable: false } }),
        failed: (code, actionFailure) => ({ ok: false, failure: resolveApprovalSettledReadFailure(code, actionFailure) }),
    });
}

export type IdentityAdministrationClient = Readonly<{
    execute: <TActionId extends TeamIdentityActionIdV1>(
        actionId: TActionId,
        input: TeamIdentityActionInput<TActionId>,
        options?: IdentityAdministrationExecuteOptions<TeamIdentityActionOutput<TActionId>>,
    ) => Promise<IdentityAdministrationActionResult<TeamIdentityActionOutput<TActionId>>>;
    executeDirectory: <TActionId extends TeamDirectoryActionIdV1>(
        actionId: TActionId,
        input: TeamDirectoryActionInputMap[TActionId],
        options?: IdentityAdministrationExecuteOptions<TeamDirectoryActionOutputMap[TActionId]>,
    ) => Promise<IdentityAdministrationActionResult<TeamDirectoryActionOutputMap[TActionId]>>;
    executeExternalGroupBinding: <TActionId extends TeamExternalGroupBindingActionIdV1>(
        actionId: TActionId,
        input: TeamExternalGroupBindingActionInputMap[TActionId],
        options?: IdentityAdministrationExecuteOptions<TeamExternalGroupBindingActionOutputMap[TActionId]>,
    ) => Promise<IdentityAdministrationActionResult<TeamExternalGroupBindingActionOutputMap[TActionId]>>;
}>;

export function createIdentityAdministrationClient(
    scope: ServerAccountScope,
    options?: Readonly<{ onApprovalPending?: (registration: ActionApprovalRegistration) => void }>,
): IdentityAdministrationClient {
    const executeHomeAction = scopedHomeActionExecutor(scope);
    const executeDeclared = async <TValue>(
        actionId: HomeDomainActionIdV1,
        input: unknown,
        signal?: AbortSignal,
        approval?: Readonly<{
            onSucceeded?: (value: TValue) => void | Promise<void>;
            onFailed?: (code: string, failure?: ActionExecuteFailure) => void;
        }>,
    ): Promise<IdentityAdministrationActionResult<TValue>> => {
        const parsedInput = homeDomainActionInputSchemaV1(actionId).safeParse(input);
        if (!parsedInput.success) {
            return { ok: false, failure: { code: 'invalid_parameters', retryable: false } };
        }

        const outcome = await executeHomeAction(actionId, parsedInput.data, {
            surface: 'ui',
            authority: 'present_user',
            serverId: scope.serverId,
            ...(signal ? { signal } : {}),
        });
        const actionOutcome = classifyHomeActionOutcome(outcome);
        if (actionOutcome.kind === 'failed') {
            const code = homeDomainFailureCode(actionOutcome.failure);
            return {
                ok: false,
                failure: {
                    code,
                    retryable: resolveIdentityAdministrationFailureRetryable(actionOutcome.failure, code),
                    domainFailure: actionOutcome.failure,
                },
            };
        }

        if (actionOutcome.kind === 'approval_pending') {
            const continuation = createHomeActionApprovalContinuation<TValue, typeof actionId>({
                artifactId: actionOutcome.artifactId,
                actionId,
                scope,
                expectedInput: parsedInput.data,
                ...(signal ? { signal } : {}),
                onSucceeded: async (value) => await approval?.onSucceeded?.(value),
                ...(approval?.onFailed ? { onFailed: approval.onFailed } : {}),
            });
            options?.onApprovalPending?.(continuation);
            return {
                ok: false,
                approvalPending: true,
                artifactId: actionOutcome.artifactId,
                failure: { code: 'approval_pending', retryable: false },
            };
        }

        const parsedOutput = homeDomainActionOutputSchemaV1(actionId).safeParse(actionOutcome.result);
        if (!parsedOutput.success) {
            return { ok: false, failure: { code: 'invalid_action_output', retryable: false } };
        }
        return { ok: true, value: parsedOutput.data as TValue };
    };
    return Object.freeze({
        execute: async <TActionId extends TeamIdentityActionIdV1>(
            actionId: TActionId,
            input: TeamIdentityActionInput<TActionId>,
            options?: IdentityAdministrationExecuteOptions<TeamIdentityActionOutput<TActionId>>,
        ): Promise<IdentityAdministrationActionResult<TeamIdentityActionOutput<TActionId>>> => {
            return await executeDeclared<TeamIdentityActionOutput<TActionId>>(
                actionId,
                input,
                options?.signal,
                approvalCallbacks(options),
            );
        },
        executeDirectory: async <TActionId extends TeamDirectoryActionIdV1>(
            actionId: TActionId,
            input: TeamDirectoryActionInputMap[TActionId],
            options?: IdentityAdministrationExecuteOptions<TeamDirectoryActionOutputMap[TActionId]>,
        ): Promise<IdentityAdministrationActionResult<TeamDirectoryActionOutputMap[TActionId]>> => (
            await executeDeclared<TeamDirectoryActionOutputMap[TActionId]>(
                actionId,
                input,
                options?.signal,
                approvalCallbacks(options),
            )
        ),
        executeExternalGroupBinding: async <TActionId extends TeamExternalGroupBindingActionIdV1>(
            actionId: TActionId,
            input: TeamExternalGroupBindingActionInputMap[TActionId],
            options?: IdentityAdministrationExecuteOptions<TeamExternalGroupBindingActionOutputMap[TActionId]>,
        ): Promise<IdentityAdministrationActionResult<TeamExternalGroupBindingActionOutputMap[TActionId]>> => (
            await executeDeclared<TeamExternalGroupBindingActionOutputMap[TActionId]>(
                actionId,
                input,
                options?.signal,
                approvalCallbacks(options),
            )
        ),
    });
}
