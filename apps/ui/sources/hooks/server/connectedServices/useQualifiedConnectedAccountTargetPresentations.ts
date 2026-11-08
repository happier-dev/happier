import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';

import { useConnectedAccountIdentityPrivacy, type ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { Profile } from '@/sync/domains/profiles/profile';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplyProfile } from '@/sync/engine/account/syncAccount';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { presentQualifiedConnectedAccountTarget, type QualifiedConnectedAccountTargetPresentation, type QualifiedConnectedAccountPresentationAccount } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from './useConnectedMetadataCatalog';

export type QualifiedConnectedAccountPresentationTarget = Readonly<{
    /** Caller-owned row identity, not a visible account or purpose label. */
    key: string;
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    serviceTitle?: string | null;
}>;

type ProfilePresentationSource = Pick<Profile, 'connectedAccountsV4' | 'connectedAccountGroupsV4'>;
type ReadState = Readonly<{
    scopeKey: string;
    source: ProfilePresentationSource | null;
    loading: boolean;
    error: string | null;
}>;

/** Display only: an Account inventory never grants permission for a credential purpose. */
export function useQualifiedConnectedAccountTargetPresentations(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    targets: readonly QualifiedConnectedAccountPresentationTarget[];
}>): Readonly<{
    presentationsByKey: Readonly<Record<string, QualifiedConnectedAccountTargetPresentation>>;
    /** Exact captured Account facts for consumers presenting several historical targets together. */
    accounts: readonly QualifiedConnectedAccountPresentationAccount[];
    labelsByKey: Readonly<Record<string, string | undefined>>;
    presentIdentity: ConnectedAccountIdentityPresenter;
    loading: boolean;
    /** The names come from a read profile of this Account (kept while a refresh runs). */
    resolved: boolean;
    error: string | null;
}> {
    const { binding, targets } = input;
    const { present } = useConnectedAccountIdentityPrivacy();
    const scopeKey = JSON.stringify([binding?.serverId, binding?.accountId, binding?.revision]);
    const hasTargets = targets.length > 0;
    // Sync and update-account already publish these display facts. Reading a
    // matching Profile must not wait on a second Account request per route.
    const syncedSource = storage(useShallow(state => binding && hasTargets
        && state.profileScope?.accountId === binding.accountId
        && areServerProfileIdentifiersEquivalent(state.profileScope.serverId, binding.serverId)
        && state.profile.id === binding.accountId
        ? { connectedAccountsV4: state.profile.connectedAccountsV4, connectedAccountGroupsV4: state.profile.connectedAccountGroupsV4 }
        : null), { profileScope: true, profile: ['id', 'connectedAccountsV4', 'connectedAccountGroupsV4'] });
    const labelsByKey = useConnectedMetadataCatalog(binding?.isCurrent() && hasTargets ? binding.scope : null, selectConnectedMetadataLabels);
    const [state, setState] = React.useState<ReadState>({ scopeKey: '', source: null, loading: false, error: null });
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!binding || !hasTargets || syncedSource) return;
        return subscribeHomeAccountChange(event => {
            if (binding.isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId)) refresh();
        }, { reconnect: { readNotCurrent: () => stateRef.current.source === null || stateRef.current.error !== null } });
    }, [binding, hasTargets, syncedSource]);
    React.useEffect(() => {
        if (!binding?.isCurrent() || !hasTargets) return;
        const abort = new AbortController();
        const current = () => !abort.signal.aborted && binding.isCurrent();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ scopeKey, source: null, loading: false, error: 'action_account_scope_changed' });
        });
        // Other Homes still need the captured read; the focused Profile is
        // usable only for its exact Account and Home, never ambient fallback.
        if (syncedSource) return () => { abort.abort(); retirement.dispose(); };
        // A same-lifetime refresh keeps display-only facts; retirement still withdraws them immediately.
        setState(current => ({ scopeKey, source: current.scopeKey === scopeKey ? current.source : null, loading: true, error: null }));
        void (async () => {
            const account = await captureLazyActionAccountContext(binding.serverId, abort.signal);
            try {
                if (!current() || account.accountId !== binding.accountId) throw new Error('action_account_scope_changed');
                const projection: { profile: Profile | null } = { profile: null };
                await fetchAndApplyProfile({ credentials: account.credentials, request: account.request,
                    shouldContinue: current, applyProfile: value => { projection.profile = value; } });
                account.assertCurrent();
                if (!current()) return;
                const capturedProfile = projection.profile;
                if (!capturedProfile || capturedProfile.id !== binding.accountId) throw new Error('qualified_account_profile_unavailable');
                setState({ scopeKey, source: capturedProfile, loading: false, error: null });
            } finally { account.dispose(); }
        })().catch(() => {
            if (current()) setState({ scopeKey, source: null, loading: false, error: 'qualified_account_profile_unavailable' });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, scopeKey, hasTargets, revision, syncedSource]);
    const visible = binding?.isCurrent() && hasTargets && state.scopeKey === scopeKey ? state : null;
    const loading = Boolean(binding?.isCurrent() && hasTargets && !syncedSource && (!visible || visible.loading));
    const source = binding?.isCurrent() && hasTargets ? syncedSource ?? visible?.source : null;
    const presentationsByKey = React.useMemo(() => Object.fromEntries(targets.map(({ key, target, serviceTitle }) => [key,
        presentQualifiedConnectedAccountTarget({ target, serviceTitle,
            accounts: source?.connectedAccountsV4 ?? [], groups: source?.connectedAccountGroupsV4 ?? [],
            labelsByKey, sourceNegotiation: loading ? 'indeterminate' : 'advertised-v4', presentIdentity: present }),
    ])), [targets, source, labelsByKey, loading, present]);
    return { presentationsByKey, accounts: source?.connectedAccountsV4 ?? [], labelsByKey, presentIdentity: present,
        loading, resolved: Boolean(source), error: syncedSource && binding?.isCurrent() ? null : visible?.error ?? null };
}
