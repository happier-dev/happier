import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { AutomationApiError, mutateAutomationOccurrence } from '@/sync/api/automations/apiAutomations';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

/** Occurrence controls share Action approval and the incumbent bounded Run publication owner. */
export function createUiOccurrenceAction(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['automationOccurrenceAction']> {
    return async ({ actionId, input, context }) => withActionAccountRequestSignal(account, context.signal, async signal => {
        account.assertCurrent();
        signal?.throwIfAborted();
        const transport = { ...account, request: (path: string, init?: RequestInit, options?: Parameters<typeof account.request>[2]) => {
            account.assertCurrent();
            signal?.throwIfAborted();
            return account.request(path, { ...init, signal }, options);
        } };
        try {
            const run = await mutateAutomationOccurrence(account.credentials, actionId, input, transport);
            account.assertCurrent();
            signal?.throwIfAborted();
            if (areServerAccountScopesEqual(account.accountLifetime.scope, getActiveServerAccountScope())) {
                storage.getState().upsertAutomationRun(run);
            }
            return { run };
        } catch (error) {
            if (error instanceof AutomationApiError) return { ok: false, errorCode: error.code ?? 'automation_api_request_failed', error: error.message };
            throw error;
        }
    });
}
