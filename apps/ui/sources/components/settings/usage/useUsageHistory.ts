import * as React from 'react';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { USAGE_HISTORY_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import type { UsageHistoryReadInput, UsageHistoryReadState } from '@happier-dev/protocol/usage/usageSessionEvidence';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { captureUiUsageQueryAccountContext, getUiUsageHistoryState, subscribeUiUsageHistory } from '@/sync/api/account/usageQueryResource';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { UsageWidgetQueryIdentity } from './useUsageWidgetResource';

export type UsageHistoryModel = Readonly<{
    state: UsageHistoryReadState | null;
    notRead: number;
    readNow(): Promise<ActionExecuteResult>;
    cancel(): Promise<ActionExecuteResult>;
}>;

/** Passive progress subscription; only the shared Action can admit or cancel a read. */
export function useUsageHistory(input: Readonly<{
    credentials: AuthCredentials | null;
    query: UsageWidgetQueryIdentity | null;
    active?: boolean;
}>): UsageHistoryModel {
    const presented = useLayoutPresentationActive() && input.active !== false;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const context = React.useMemo(() => input.credentials && input.query && lifetime?.isCurrent()
        && areServerAccountScopesEqual(input.query.authority, lifetime.scope)
        ? captureUiUsageQueryAccountContext(input.credentials) : null,
    [input.credentials, lifetime, input.query?.authority.serverId, input.query?.authority.accountId]);
    const key = input.query ? getUsageQueryKey(input.query.query) : null;
    const query = React.useMemo(() => input.query ? normalizeUsageQuery(input.query.query) : null, [key]);
    const execution = useMountedActionExecution(input.query?.authority);
    const subscribe = React.useCallback((listener: () => void) => context && query && presented
        ? subscribeUiUsageHistory(context, query, listener) : () => {}, [context, query, presented]);
    const getSnapshot = React.useCallback(() => context && query && context.accountLifetime.isCurrent()
        ? getUiUsageHistoryState(context, query) : null, [context, query]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const invoke = React.useCallback((operation: UsageHistoryReadInput['operation']): Promise<ActionExecuteResult> => {
        if (!context || !query) return Promise.resolve({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
        return execution.execute(USAGE_HISTORY_ACTION_IDS.read, { query, operation });
    }, [context, query, execution.execute]);
    const readNow = React.useCallback(() => invoke('read'), [invoke]);
    const cancel = React.useCallback(() => invoke('cancel'), [invoke]);
    return React.useMemo(() => ({ state, notRead: state?.progress.notRead ?? 0, readNow, cancel }), [state, readNow, cancel]);
}
