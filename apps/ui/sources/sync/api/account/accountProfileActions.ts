import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storageStore';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { parseToken } from '@/utils/auth/parseToken';
import { HappyError } from '@/utils/errors/errors';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

/** A mounted author retains the original save through the shared approval continuation. */
type AccountProfileActionId = 'account.name.set' | 'account.username.set' | 'account.username.check' | 'account.username.release';

export type AccountProfileActionExecution = Readonly<{
    execute: (actionId: AccountProfileActionId, input: unknown) => Promise<ActionExecuteResult>;
}>;

/** Capture one UI save lifetime, including retries; HTTP remains below the Action executor. */
export function captureAccountProfileAction(
    credentials: AuthCredentials,
    actionId: AccountProfileActionId,
    options: Readonly<{ staleScopeError: string; failureMessage: string; invalidResponseMessage: string }>,
    mounted?: AccountProfileActionExecution,
): Readonly<{ scope: ServerAccountScope; assertCurrent: () => void; execute: (input: unknown) => Promise<unknown> }> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new HappyError(options.staleScopeError, false);
    const accountId = parseToken(credentials.token);
    const snapshot = getActiveServerSnapshot();
    const assertCurrent = () => {
        const current = getActiveServerSnapshot();
        if (!lifetime.isCurrent() || lifetime.scope.accountId !== accountId
            || current.serverId !== snapshot.serverId || current.generation !== snapshot.generation
            || lifetime.scope.serverId !== snapshot.serverId || getStorage().getState().profile.id !== accountId) {
            throw new HappyError(options.staleScopeError, false);
        }
    };
    assertCurrent();
    return {
        scope: lifetime.scope,
        assertCurrent,
        async execute(input: unknown): Promise<unknown> {
            assertCurrent();
            const execution = await (mounted ? mounted.execute(actionId, input)
                : scopedHomeActionExecutor(lifetime.scope)(actionId, input, {
                    surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId, expectedAccountId: accountId,
                }));
            assertCurrent();
            if (!execution.ok) {
                const failure = homeDomainFailureFromActionFailure(execution);
                const message = failure.httpStatus === 200 ? options.invalidResponseMessage
                    : failure.code ?? (failure.httpStatus === undefined ? execution.error : options.failureMessage);
                const kind = failure.code === 'username-disabled' || failure.code === 'friends-disabled' ? 'config' : 'server';
                throw new HappyError(message, failure.retryable, {
                    status: failure.httpStatus, kind, code: execution.errorCode, details: execution.details,
                });
            }
            requireActionSuccess(execution);
            return execution.result;
        },
    };
}
