import * as React from 'react';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';

import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { Profile } from '@/sync/domains/profiles/profile';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplyProfile } from '@/sync/engine/account/syncAccount';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { presentQualifiedConnectedAccountTarget, type QualifiedConnectedAccountTargetPresentation } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from './useConnectedMetadataCatalog';

export type QualifiedConnectedAccountPresentationTarget = Readonly<{
    /** Caller-owned row identity, not a visible account or purpose label. */
    key: string;
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    serviceTitle?: string | null;
}>;

type ProfilePresentationSource = Readonly<{
    profile: Profile;
}>;
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
    loading: boolean;
    error: string | null;
}> {
    const { binding, targets } = input;
    const { present } = useConnectedAccountIdentityPrivacy();
    const scopeKey = JSON.stringify([binding?.serverId, binding?.accountId, binding?.revision]);
    const hasTargets = targets.length > 0;
    const labelsByKey = useConnectedMetadataCatalog(binding?.isCurrent() && hasTargets ? binding.scope : null, selectConnectedMetadataLabels);
    const [state, setState] = React.useState<ReadState>({ scopeKey: '', source: null, loading: false, error: null });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!binding || !hasTargets) return;
        return subscribeHomeAccountChange(event => {
            if (binding.isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId)) refresh();
        });
    }, [binding, hasTargets]);
    React.useEffect(() => {
        if (!binding?.isCurrent() || !hasTargets) return;
        const abort = new AbortController();
        const current = () => !abort.signal.aborted && binding.isCurrent();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ scopeKey, source: null, loading: false, error: 'action_account_scope_changed' });
        });
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
                setState({ scopeKey, source: { profile: capturedProfile }, loading: false, error: null });
            } finally { account.dispose(); }
        })().catch(() => {
            if (current()) setState({ scopeKey, source: null, loading: false, error: 'qualified_account_profile_unavailable' });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, scopeKey, hasTargets, revision]);
    const visible = binding?.isCurrent() && hasTargets && state.scopeKey === scopeKey ? state : null;
    const loading = Boolean(binding?.isCurrent() && hasTargets && (!visible || visible.loading));
    const source = visible?.source;
    const presentationsByKey = React.useMemo(() => Object.fromEntries(targets.map(({ key, target, serviceTitle }) => [key,
        presentQualifiedConnectedAccountTarget({ target, serviceTitle,
            accounts: source?.profile.connectedAccountsV4 ?? [], groups: source?.profile.connectedAccountGroupsV4 ?? [],
            labelsByKey, sourceNegotiation: loading ? 'indeterminate' : 'advertised-v4', presentIdentity: present }),
    ])), [targets, source, labelsByKey, loading, present]);
    return { presentationsByKey, loading, error: visible?.error ?? null };
}
