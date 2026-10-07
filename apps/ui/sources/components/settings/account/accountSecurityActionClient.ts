import { AccountEmailChangeRequestResponseV1Schema, AccountPasswordMutationResponseV1Schema, AccountSecurityGetResponseV1Schema, AccountTerminalPresentUserPolicySetResponseV1Schema, type AccountTerminalPresentUserPolicySetResponseV1, type AccountEmailChangeRequestResponseV1, type AccountPasswordMutationResponseV1, type AccountPasswordChangeRequestV1, type AccountPasswordEnrollRequestV1, type AccountPasswordRemoveRequestV1, type AccountSecurityGetResponseV1 } from '@happier-dev/protocol/auth/accountSecurity';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { TerminalPresentUserPolicy } from '@happier-dev/protocol/actions/invocationAuthority';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { serverFetch } from '@/sync/http/client';
import { requestAccountPasswordEnrollmentEmail } from '@/sync/api/auth/accountSecurity';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

type AccountSecurityExecute = ReturnType<typeof createFrontDoorActionExecute>;
export type AccountSecurityActionId =
    | 'account.security.get'
    | 'account.password.enroll'
    | 'account.password.change'
    | 'account.password.remove'
    | 'account.email.change.request'
    | 'account.security.terminalPresentUser.set';

export type AccountSecurityActionClient = Readonly<{
    read(signal?: AbortSignal): Promise<AccountSecurityGetResponseV1>;
    enrollPlainPassword(input: Extract<AccountPasswordEnrollRequestV1, Readonly<{ kind: 'plain' }>>, signal?: AbortSignal): Promise<AccountPasswordMutationResponseV1>;
    enrollE2eePassword(input: Extract<AccountPasswordEnrollRequestV1, Readonly<{ kind: 'e2ee' }>>, signal?: AbortSignal): Promise<AccountPasswordMutationResponseV1>;
    requestPasswordEnrollmentEmail(input: Readonly<{ email: string }>, signal?: AbortSignal): Promise<void>;
    changePlainPassword(input: Readonly<{
        expectedCredentialRevision: number;
        currentPassword: string;
        newPassword: string;
    }>, signal?: AbortSignal): Promise<AccountPasswordMutationResponseV1>;
    changeE2eePassword(input: Extract<AccountPasswordChangeRequestV1, Readonly<{ kind: 'e2ee' }>>, signal?: AbortSignal): Promise<AccountPasswordMutationResponseV1>;
    removePlainPassword(input: Readonly<{
        expectedCredentialRevision: number;
        currentPassword: string;
    }>, signal?: AbortSignal): Promise<AccountPasswordMutationResponseV1>;
    removeE2eePassword(input: Extract<AccountPasswordRemoveRequestV1, Readonly<{ kind: 'e2ee' }>>, signal?: AbortSignal): Promise<AccountPasswordMutationResponseV1>;
    requestEmailChange(input: Readonly<{ email: string }>, signal?: AbortSignal): Promise<AccountEmailChangeRequestResponseV1>;
    /** Whether the CLI and daemon may approve requests and change account settings (plan 01 R-CLI). */
    setTerminalPresentUserPolicy(policy: TerminalPresentUserPolicy, signal?: AbortSignal): Promise<AccountTerminalPresentUserPolicySetResponseV1>;
}>;

function actionFailure(result: Extract<ActionExecuteResult, Readonly<{ ok: false }>>): HappyError {
    const code = result.errorCode || result.error || 'unavailable';
    return new HappyError(result.error || 'Account security request failed', true, {
        kind: 'auth',
        code,
    });
}

function readDeferredApproval(value: unknown): Readonly<{
    artifactId: string;
    actionId: string;
}> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Readonly<{
        kind?: unknown;
        artifactId?: unknown;
        actionId?: unknown;
    }>;
    return candidate.kind === 'approval_request_created'
        && typeof candidate.artifactId === 'string'
        && candidate.artifactId.length > 0
        && typeof candidate.actionId === 'string'
        && candidate.actionId.length > 0
            ? { artifactId: candidate.artifactId, actionId: candidate.actionId }
            : null;
}

/**
 * A deferred Account Security mutation is still one submitted Action. The
 * approval Artifact owns its durable lifecycle; this error only carries its
 * exact identity to the mounted shared continuation host instead of discarding
 * it as a generic failure and tempting the UI to submit the mutation again.
 */
export class AccountSecurityActionApprovalPendingError extends HappyError {
    readonly name = 'AccountSecurityActionApprovalPendingError';

    constructor(
        public readonly artifactId: string,
        public readonly actionId: AccountSecurityActionId,
    ) {
        super('account_security_action_approval_pending', false, {
            kind: 'auth',
            code: 'approval_pending',
        });
        Object.setPrototypeOf(this, AccountSecurityActionApprovalPendingError.prototype);
    }
}

export function createAccountSecurityActionClient(dependencies: Readonly<{
    execute?: AccountSecurityExecute;
    requestEnrollmentEmail?: (
        input: Readonly<{ email: string }>,
        signal?: AbortSignal,
    ) => Promise<void>;
    resolveServerId?: () => string;
}> = {}): AccountSecurityActionClient {
    const execute = dependencies.execute ?? createFrontDoorActionExecute();
    const resolveServerId = dependencies.resolveServerId ?? (() => getActiveServerSnapshot().serverId);
    const requestEnrollmentEmail = dependencies.requestEnrollmentEmail
        ?? (async (input: Readonly<{ email: string }>, signal?: AbortSignal) => {
            await requestAccountPasswordEnrollmentEmail(serverFetch, input, signal);
        });

    const run = async <T>(
        actionId: AccountSecurityActionId,
        input: unknown,
        schema: Readonly<{ parse(value: unknown): T }>,
        signal?: AbortSignal,
    ): Promise<T> => {
        const result = await execute(actionId, input, {
            surface: 'ui',
            authority: 'present_user',
            actionCaller: { kind: 'host' },
            serverId: resolveServerId(),
            ...(signal ? { signal } : {}),
        });
        if (!result.ok) throw actionFailure(result);
        const deferredApproval = readDeferredApproval(result.result);
        if (deferredApproval) {
            if (deferredApproval.actionId !== actionId) {
                throw new HappyError('Account security approval result did not match the requested Action', false, {
                    kind: 'auth',
                    code: 'invalid_action_output',
                });
            }
            throw new AccountSecurityActionApprovalPendingError(
                deferredApproval.artifactId,
                actionId,
            );
        }
        return schema.parse(result.result);
    };

    return Object.freeze({
        read: async (signal) => await run('account.security.get', {}, AccountSecurityGetResponseV1Schema, signal),
        enrollPlainPassword: async (input, signal) => await run(
            'account.password.enroll', input, AccountPasswordMutationResponseV1Schema, signal,
        ),
        enrollE2eePassword: async (input, signal) => await run(
            'account.password.enroll', input, AccountPasswordMutationResponseV1Schema, signal,
        ),
        requestPasswordEnrollmentEmail: async (input, signal) => {
            await requestEnrollmentEmail(input, signal);
        },
        changePlainPassword: async (input, signal) => await run('account.password.change', {
            v: 1,
            kind: 'plain',
            ...input,
        }, AccountPasswordMutationResponseV1Schema, signal),
        changeE2eePassword: async (input, signal) => await run(
            'account.password.change', input, AccountPasswordMutationResponseV1Schema, signal,
        ),
        removePlainPassword: async (input, signal) => await run('account.password.remove', {
            v: 1,
            kind: 'plain',
            ...input,
        }, AccountPasswordMutationResponseV1Schema, signal),
        removeE2eePassword: async (input, signal) => await run(
            'account.password.remove', input, AccountPasswordMutationResponseV1Schema, signal,
        ),
        requestEmailChange: async (input, signal) => await run('account.email.change.request', {
            v: 1,
            ...input,
        }, AccountEmailChangeRequestResponseV1Schema, signal),
        setTerminalPresentUserPolicy: async (policy, signal) => await run(
            'account.security.terminalPresentUser.set', { policy }, AccountTerminalPresentUserPolicySetResponseV1Schema, signal,
        ),
    });
}
