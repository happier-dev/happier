import * as React from 'react';
import type { MachineProvisionerCheckResultV1, MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createManagedProvisionerClient } from './managedProvisionerClient';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { refreshManagedProvisionerAvailability } from './managedProvisionerAvailability';
const EMPTY_PROVISIONERS: MachineProvisionersListResultV1['provisioners'] = [];
type ProvisionerChecks = Readonly<Record<string, MachinePresetCollectionSettledResult<MachineProvisionerCheckResultV1>>>;
const EMPTY_CHECKS: ProvisionerChecks = Object.freeze({});
type ProvisionerPresentation = Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    binding: ServerCredentialAccountScopeBinding | null; accountId: string | null; requestKey: string;
    provisioners: MachineProvisionersListResultV1['provisioners']; checks: ProvisionerChecks;
    error: string | null; loading: boolean;
}>;
// Like managed inventory, retain only presentation under the existing Account
// lifetime. Unmount still cancels reads; this grants no execution authority.
const presentations = new WeakMap<ServerAccountScopeLifetime, Map<string, ProvisionerPresentation>>();

/** Demand belongs to the mounted Create surface, and all data retires with its exact Home credential. */
export function useManagedProvisioners(serverId: string, onApprovalPending?: (registration: ActionApprovalRegistration) => void,
    controller?: ManagedControllerV1, demand?: Readonly<{ enabled?: boolean; contributionKey?: string }>) {
    const enabled = demand?.enabled !== false;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = getServerProfileById(serverId)?.serverIdentityId?.trim() || null;
    const contributionKey = demand?.contributionKey;
    const requestKey = JSON.stringify([homeId, controller, contributionKey]);
    const lifetime = captureActiveServerAccountScopeLifetime();
    // Controller resolution may still be pending on remount. As on a mounted
    // controller change, keep this Home's last cards while the new request answers.
    const presentationKey = JSON.stringify([serverId, homeId, contributionKey]);
    const retained = lifetime?.isCurrent() ? presentations.get(lifetime)?.get(presentationKey) : undefined;
    const [state, setState] = React.useState<ProvisionerPresentation>(() => retained ?? {
        lifetime, binding: null, accountId: null, requestKey: '', provisioners: EMPTY_PROVISIONERS, checks: EMPTY_CHECKS, error: null, loading: false,
    });
    React.useEffect(() => {
        if (!lifetime?.isCurrent() || state.lifetime !== lifetime || state.requestKey !== requestKey || !state.accountId) return;
        const entries = presentations.get(lifetime) ?? new Map<string, ProvisionerPresentation>();
        entries.set(presentationKey, state);
        presentations.set(lifetime, entries);
    }, [lifetime, presentationKey, requestKey, state]);
    const setChecks = React.useCallback((update: React.SetStateAction<ProvisionerChecks>) => setState(current => ({ ...current,
        checks: typeof update === 'function' ? update(current.checks) : update,
    })), []);
    // Presence projections may recreate equivalent controller objects. Only the semantic
    // request key changes demand; the ref supplies that render's typed inputs to the effect.
    const controllerRef = React.useRef(controller);
    controllerRef.current = controller;
    const [refreshRevision, refreshCatalog] = React.useReducer(value => value + 1, 0);
    const refresh = React.useCallback(() => {
        if (binding && homeId) {
            const contribution = parseQualifiedPluginContributionKey(contributionKey);
            refreshManagedProvisionerAvailability(binding, { homeId, ...(controller ? { controller } : {}),
                ...(contribution ? { contribution } : {}) });
            if (controller) refreshManagedProvisionerAvailability(binding, { homeId, ...(contribution ? { contribution } : {}) });
        }
        refreshCatalog();
    }, [binding, homeId, contributionKey, controller]);
    const approvalRef = React.useRef(onApprovalPending);
    approvalRef.current = onApprovalPending;
    const client = React.useMemo(() => binding && homeId ? createManagedProvisionerClient(binding.scope, homeId) : null, [binding, homeId]);
    React.useEffect(() => {
        const selectedController = controllerRef.current;
        const contribution = parseQualifiedPluginContributionKey(contributionKey);
        if (!enabled || !binding || !client || !homeId) return;
        const abort = new AbortController();
        // A profile refresh retires the binding and replaces it for the same Account: the read stops and the last
        // answer stays until the replacement's read answers. Another Account never sees it.
        const retirement = binding.onRetire(() => abort.abort());
        setState(current => {
            const keepPresentation = current.lifetime === lifetime && current.accountId === binding.accountId;
            return { lifetime, binding, accountId: binding.accountId, requestKey,
                provisioners: keepPresentation ? current.provisioners : EMPTY_PROVISIONERS,
                checks: keepPresentation ? current.checks : EMPTY_CHECKS, error: null, loading: true };
        });
        const publish = (result: { kind: 'succeeded'; provisioners: MachineProvisionersListResultV1['provisioners'] } | { kind: 'failed'; code: string }) => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setState(current => current.binding !== binding || current.requestKey !== requestKey ? current : {
                ...current, loading: false,
                provisioners: result.kind === 'succeeded' ? result.provisioners : current.provisioners,
                error: result.kind === 'failed' ? result.code : null,
            });
        };
        void client.read('machines.provisioners.list', { homeId, ...(selectedController ? { controller: selectedController } : {}),
            ...(contribution ? { contribution } : {}) },
            { signal: abort.signal, onApprovalPending: registration => approvalRef.current?.(registration) }).then(result => {
            publish(result.kind === 'succeeded' ? { kind: 'succeeded', provisioners: result.value.provisioners }
                : { kind: 'failed', code: result.code });
        }, () => {
            publish({ kind: 'failed', code: 'unavailable' });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [enabled, binding, client, homeId, requestKey, contributionKey, refreshRevision, lifetime]);
    const boundAccountId = binding?.isCurrent() ? binding.accountId : resolution.kind === 'bound' ? resolution.scope.accountId : null;
    const sameAccount = state.lifetime === lifetime && (boundAccountId !== null ? state.accountId === boundAccountId
        : resolution.kind === 'resolving' && lifetime?.isCurrent() && retained === state);
    // The last answer of this Account stays while a re-read runs: a new controller, or a refreshed credential binding.
    const visible = !enabled ? { provisioners: EMPTY_PROVISIONERS, error: null, loading: false }
        : sameAccount && binding?.isCurrent() && state.binding === binding && state.requestKey === requestKey ? state
        : sameAccount ? { provisioners: state.provisioners, error: null, loading: true } : {
        provisioners: [], error: resolution.kind === 'resolving' || resolution.kind === 'bound' ? null : resolution.kind,
        loading: resolution.kind === 'resolving' || resolution.kind === 'bound',
    };
    return { binding, resolution, homeId, client, provisioners: visible.provisioners,
        checks: enabled && sameAccount ? state.checks : EMPTY_CHECKS, setChecks,
        error: enabled && binding && !homeId ? 'unsupported_action' : visible.error,
        loading: enabled && binding && !homeId ? false : visible.loading, refresh };
}
