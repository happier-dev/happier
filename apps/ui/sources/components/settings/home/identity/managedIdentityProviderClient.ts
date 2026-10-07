import type { z } from 'zod';
import { homeDomainActionInputSchemaV1, homeDomainActionOutputSchemaV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { type ManagedIdentityProviderActionIdV1, ManagedIdentityProviderCreateInputV1Schema, ManagedIdentityProviderLifecycleInputV1Schema, ManagedIdentityProviderRemovePreflightInputV1Schema, ManagedIdentityProviderRemovePreflightResultV1Schema, ManagedIdentityProviderRemoveResultV1Schema, ManagedIdentityProviderSecretReplaceInputV1Schema, ManagedIdentityProviderTestConsumeInputV1Schema, ManagedIdentityProviderTestConsumeResultV1Schema, ManagedIdentityProviderTestStartInputV1Schema, ManagedIdentityProviderTestStartResultV1Schema, ManagedIdentityProvidersListInputV1Schema, ManagedIdentityProvidersListResultV1Schema, ManagedIdentityProviderUpdateInputV1Schema, ManagedIdentityProviderV1Schema, ManagedOidcIdentityProviderV1Schema } from '@happier-dev/protocol/identity/providers';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { resolveApprovalSettledReadFailure, resolveIdentityAdministrationFailureRetryable } from '@/components/settings/identity/identityAdministrationFailure';
import {
    awaitActionApprovalResult,
    createHomeActionApprovalContinuation,
    type ActionApprovalContinuation,
    type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';

type ManagedIdentityProviderActionInputMap = Readonly<{
    'identity.providers.list': z.infer<typeof ManagedIdentityProvidersListInputV1Schema>;
    'identity.providers.create': z.infer<typeof ManagedIdentityProviderCreateInputV1Schema>;
    'identity.providers.update': z.infer<typeof ManagedIdentityProviderUpdateInputV1Schema>;
    'identity.providers.secret.replace': z.infer<typeof ManagedIdentityProviderSecretReplaceInputV1Schema>;
    'identity.providers.validate': z.infer<typeof ManagedIdentityProviderLifecycleInputV1Schema>;
    'identity.providers.test.start': z.infer<typeof ManagedIdentityProviderTestStartInputV1Schema>;
    'identity.providers.test.consume': z.infer<typeof ManagedIdentityProviderTestConsumeInputV1Schema>;
    'identity.providers.enable': z.infer<typeof ManagedIdentityProviderLifecycleInputV1Schema>;
    'identity.providers.disable': z.infer<typeof ManagedIdentityProviderLifecycleInputV1Schema>;
    'identity.providers.remove.preview': z.infer<typeof ManagedIdentityProviderRemovePreflightInputV1Schema>;
    'identity.providers.remove': z.infer<typeof ManagedIdentityProviderRemovePreflightInputV1Schema>;
}>;

type ManagedIdentityProviderActionOutputMap = Readonly<{
    'identity.providers.list': z.infer<typeof ManagedIdentityProvidersListResultV1Schema>;
    'identity.providers.create': z.infer<typeof ManagedOidcIdentityProviderV1Schema>;
    'identity.providers.update': z.infer<typeof ManagedOidcIdentityProviderV1Schema>;
    'identity.providers.secret.replace': z.infer<typeof ManagedOidcIdentityProviderV1Schema>;
    'identity.providers.validate': z.infer<typeof ManagedOidcIdentityProviderV1Schema>;
    'identity.providers.test.start': z.infer<typeof ManagedIdentityProviderTestStartResultV1Schema>;
    'identity.providers.test.consume': z.infer<typeof ManagedIdentityProviderTestConsumeResultV1Schema>;
    'identity.providers.enable': z.infer<typeof ManagedIdentityProviderV1Schema>;
    'identity.providers.disable': z.infer<typeof ManagedIdentityProviderV1Schema>;
    'identity.providers.remove.preview': z.infer<typeof ManagedIdentityProviderRemovePreflightResultV1Schema>;
    'identity.providers.remove': z.infer<typeof ManagedIdentityProviderRemoveResultV1Schema>;
}>;

export type ManagedIdentityProviderActionOutput<TActionId extends ManagedIdentityProviderActionIdV1> =
    ManagedIdentityProviderActionOutputMap[TActionId];

export type ManagedIdentityProviderActionResult<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string; approval: ActionApprovalContinuation }>
    | Readonly<{ kind: 'failed'; failure: Readonly<{ code: string; retryable: boolean }> }>;

export type ManagedIdentityProviderExecuteOptions<TValue> = Readonly<{
    signal?: AbortSignal;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
    onApprovalSucceeded?: (value: TValue) => void | Promise<void>;
    onApprovalFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>;

export type ManagedIdentityProviderSettledResult<TValue> = Exclude<
    ManagedIdentityProviderActionResult<TValue>,
    Readonly<{ kind: 'approval_pending' }>
>;

export type ManagedIdentityProviderClient = Readonly<{
    execute: <TActionId extends ManagedIdentityProviderActionIdV1>(
        actionId: TActionId,
        input: ManagedIdentityProviderActionInputMap[TActionId],
        options?: ManagedIdentityProviderExecuteOptions<ManagedIdentityProviderActionOutputMap[TActionId]>,
    ) => Promise<ManagedIdentityProviderActionResult<ManagedIdentityProviderActionOutputMap[TActionId]>>;
}>;

export function createManagedIdentityProviderClient(scope: ServerAccountScope): ManagedIdentityProviderClient {
    const executeHomeAction = scopedHomeActionExecutor(scope);
    return Object.freeze({
        execute: async <TActionId extends ManagedIdentityProviderActionIdV1>(
            actionId: TActionId,
            input: ManagedIdentityProviderActionInputMap[TActionId],
            options?: ManagedIdentityProviderExecuteOptions<ManagedIdentityProviderActionOutputMap[TActionId]>,
        ): Promise<ManagedIdentityProviderActionResult<ManagedIdentityProviderActionOutputMap[TActionId]>> => {
            const parsedInput = homeDomainActionInputSchemaV1(actionId).safeParse(input);
            if (!parsedInput.success) {
                return { kind: 'failed', failure: { code: 'invalid_parameters', retryable: false } };
            }
            const actionResult = await executeHomeAction(actionId, parsedInput.data, {
                surface: 'ui',
                authority: 'present_user',
                serverId: scope.serverId,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const outcome = classifyHomeActionOutcome(actionResult);
            if (outcome.kind === 'failed') {
                const code = homeDomainFailureCode(outcome.failure);
                return {
                    kind: 'failed',
                    failure: {
                        code,
                        retryable: resolveIdentityAdministrationFailureRetryable(outcome.failure, code),
                    },
                };
            }
            if (outcome.kind === 'approval_pending') {
                const approval = createHomeActionApprovalContinuation<ManagedIdentityProviderActionOutputMap[TActionId], TActionId>({
                    artifactId: outcome.artifactId,
                    actionId,
                    scope,
                    expectedInput: parsedInput.data,
                    ...(options?.signal ? { signal: options.signal } : {}),
                    onSucceeded: async (value) => await options?.onApprovalSucceeded?.(value),
                    onFailed: options?.onApprovalFailed,
                });
                options?.onApprovalPending?.(approval);
                return {
                    ...outcome,
                    approval,
                };
            }
            const parsedOutput = homeDomainActionOutputSchemaV1(actionId).safeParse(outcome.result);
            if (!parsedOutput.success) {
                return { kind: 'failed', failure: { code: 'invalid_action_output', retryable: false } };
            }
            return {
                kind: 'succeeded',
                value: parsedOutput.data as ManagedIdentityProviderActionOutputMap[TActionId],
            };
        },
    });
}

/**
 * Join immediate and approval-deferred reads without issuing the read again.
 * The shared approval owner supplies once-only settlement and abort fencing;
 * this adapter only maps the managed-provider result envelope.
 * Callers name `TValue` (or pass an already typed reader): contextually typing
 * the `options` lambda parameter would otherwise fix it to `unknown`.
 */
export function executeManagedIdentityProviderRead<TValue>(
    execute: (options: ManagedIdentityProviderExecuteOptions<TValue>) => Promise<ManagedIdentityProviderActionResult<TValue>>,
    options: Readonly<{
        signal?: AbortSignal;
        onApprovalPending?: (registration: ActionApprovalRegistration) => void;
    }> = {},
): Promise<ManagedIdentityProviderSettledResult<TValue>> {
    return awaitActionApprovalResult<TValue, ManagedIdentityProviderSettledResult<TValue>>({
        execute: async (callbacks) => {
            const result = await execute({
                ...callbacks,
                ...(options.onApprovalPending ? { onApprovalPending: options.onApprovalPending } : {}),
            });
            return result.kind === 'approval_pending' ? { approvalPending: true } : result;
        },
        succeeded: (value) => ({ kind: 'succeeded', value }),
        failed: (code, actionFailure) => {
            const failure = resolveApprovalSettledReadFailure(code, actionFailure);
            return { kind: 'failed', failure: { code: failure.code, retryable: failure.retryable } };
        },
        aborted: () => ({ kind: 'failed', failure: { code: 'aborted', retryable: false } }),
        ...(options.signal ? { signal: options.signal } : {}),
    });
}
