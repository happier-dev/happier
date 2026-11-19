import { selectProjectSourceTeamMoveApiTokensV1 } from '@happier-dev/deployments';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, AccountApiTokensListActionOutputV1Schema,
    AccountApiTokensServerErrorV1Schema, type AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';

export type ProjectSourceTeamTokenAccount = Pick<LazyActionAccountContext, 'request' | 'assertCurrent'> & Readonly<{
    accountLifetime: Pick<LazyActionAccountContext['accountLifetime'], 'scope'>;
}>;

/** The existing token owner supplies complete non-secret summaries for one reviewed Move. */
export async function readProjectSourceTeamApiTokens(input: Readonly<{
    account: ProjectSourceTeamTokenAccount; environmentIds: readonly string[]; context: ActionExecutorContext;
}>): Promise<Readonly<{ kind: 'ready'; tokens: AccountApiTokenSummaryV1[] }> | ActionExecuteFailure> {
    const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    const { account, context } = input;
    try {
        context.signal?.throwIfAborted();
        account.assertCurrent();
        if (input.environmentIds.length === 0) return { kind: 'ready', tokens: [] };
        const response = await requestHomeDomain({
            scope: account.accountLifetime.scope, path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
            input: { includeChildren: true }, schema: AccountApiTokensListActionOutputV1Schema, effect: 'read', signal: context.signal,
            requestAuthority: { request: account.request, assertCurrent: account.assertCurrent },
            errorSchema: { safeParse: value => {
                const error = AccountApiTokensServerErrorV1Schema.safeParse({ error: value });
                return error.success ? { success: true, data: error.data.error } : { success: false };
            } },
        });
        context.signal?.throwIfAborted();
        account.assertCurrent();
        if (!response.ok) return fail(homeDomainFailureCode(response.failure));
        return { kind: 'ready', tokens: selectProjectSourceTeamMoveApiTokensV1(response.value.tokens, input.environmentIds) };
    } catch (error) {
        if (context.signal?.aborted) return fail('cancelled');
        if (error instanceof Error && 'code' in error && error.code === 'action_account_scope_changed') {
            return fail('action_account_scope_changed');
        }
        return fail('home_unreachable');
    }
}
