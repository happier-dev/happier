import * as React from 'react';

import { readSessionFollowRuleInputs, type SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { isAccountFollowConfigurationChangeRelevant } from './sessionFollowAccountChange';

type RuleInput = Readonly<{ serverId: string; accountId: string; credentialKey?: string }>;
const ruleInputs = createSharedSubscriptionStore<RuleInput, SessionFollowRulesReadResult | null,
    SessionFollowRulesReadResult, typeof readSessionFollowRuleInputs>({
    emptyState: null,
    createState: () => null,
    normalizeInput: input => input,
    storeKey: input => JSON.stringify([input.serverId, input.accountId, input.credentialKey ?? null]),
    defaultSnapshotClient: readSessionFollowRuleInputs,
    refresh: ({ input, snapshotClient, signal }) => snapshotClient(input.serverId, signal, { expectedAccountId: input.accountId }),
    applySnapshot: (_previous, snapshot) => snapshot,
    subscribeRecovery: (input, recover) => subscribeHomeAccountChange(event => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, input.serverId)
            && isAccountFollowConfigurationChangeRelevant(event)) recover(true);
    }, { reconnect: { readNotCurrent: (): boolean => ruleInputs.getState(input)?.status !== 'ready' } }),
});

/** One demanded private census per captured Home/Account credential, released with its last consumer. */
export function useSessionFollowRules(serverId: string | null, enabled: boolean) {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const currentScope = enabled ? selectActiveServerAccountScopeForServer(activeLifetime?.scope ?? null, serverId) : null;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(enabled && !currentScope ? serverId : null);
    const lifetime = currentScope ? activeLifetime : binding;
    const accountId = currentScope?.accountId ?? binding?.accountId;
    const capturedServerId = lifetime?.scope.serverId;
    const credentialKey = binding?.credentialKey;
    const input = React.useMemo<RuleInput | null>(() => enabled && capturedServerId && accountId
        ? { serverId: capturedServerId, accountId, ...(credentialKey ? { credentialKey } : {}) } : null,
    [enabled, capturedServerId, accountId, credentialKey]);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!input || !lifetime?.isCurrent()) return () => {};
        const unsubscribe = ruleInputs.subscribe(input, notify);
        const retirement = lifetime.onRetire(() => { unsubscribe(); notify(); });
        return () => { retirement.dispose(); unsubscribe(); };
    }, [input, lifetime]);
    const getSnapshot = React.useCallback(() => input && lifetime?.isCurrent() ? ruleInputs.getState(input) : null, [input, lifetime]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const refresh = React.useCallback(async () => {
        if (!input || !lifetime?.isCurrent()) return null;
        ruleInputs.invalidate(input);
        await ruleInputs.read(input);
        return lifetime.isCurrent() ? ruleInputs.getState(input) : null;
    }, [input, lifetime]);
    return { snapshot, lifetime, accountId, refresh,
        loading: enabled && Boolean(serverId) && (resolution.kind === 'resolving' || Boolean(lifetime?.isCurrent() && !snapshot)) };
}

export type SessionFollowRulesController = ReturnType<typeof useSessionFollowRules>;
