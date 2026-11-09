import * as React from 'react';
import type { MachineProvisionerCheckResultV1, MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createManagedProvisionerClient, type ManagedProvisionerReadResult } from './managedProvisionerClient';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { refreshManagedProvisionerAvailability } from './managedProvisionerAvailability';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
const EMPTY_PROVISIONERS: MachineProvisionersListResultV1['provisioners'] = [];
type ProvisionerChecks = Readonly<Record<string, MachinePresetCollectionSettledResult<MachineProvisionerCheckResultV1>>>;
const EMPTY_CHECKS: ProvisionerChecks = Object.freeze({});
type ProvisionerPresentation = Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    binding: ServerCredentialAccountScopeBinding | null; accountId: string | null; requestKey: string;
    provisioners: MachineProvisionersListResultV1['provisioners']; checks: ProvisionerChecks;
    error: string | null; loading: boolean;
    settled: Readonly<{ binding: ServerCredentialAccountScopeBinding; requestKey: string }> | null;
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
    // Account declarations arrive through sync independently of this mounted
    // catalog. Consume their publication so a cold read recovers without Retry.
    const accountReader = usePluginAccountAvailabilityReader(binding?.scope ?? null,
        parseQualifiedPluginContributionKey(contributionKey)?.pluginId, { enabled });
    const requestKey = JSON.stringify([homeId, controller, contributionKey]);
    const lifetime = captureActiveServerAccountScopeLifetime();
    // Controller resolution may still be pending on remount. As on a mounted
    // controller change, keep this Home's last cards while the new request answers.
    const presentationKey = JSON.stringify([serverId, homeId, contributionKey]);
    const retained = lifetime?.isCurrent() ? presentations.get(lifetime)?.get(presentationKey) : undefined;
    const [state, setState] = React.useState<ProvisionerPresentation>(() => retained ?? {
        lifetime, binding: null, accountId: null, requestKey: '', provisioners: EMPTY_PROVISIONERS, checks: EMPTY_CHECKS, error: null, loading: false, settled: null,
    });
    React.useEffect(() => {
        if (!lifetime?.isCurrent() || state.lifetime !== lifetime || state.requestKey !== requestKey || !state.accountId) return;
        const entries = presentations.get(lifetime) ?? new Map<string, ProvisionerPresentation>();
        entries.set(presentationKey, state);
        presentations.set(lifetime, entries);
    }, [lifetime, presentationKey, requestKey, state]);
    const setChecks = React.useCallback((update: React.SetStateAction<ProvisionerChecks>) => setState(current => retainShallow(current, { ...current,
        checks: retainDeep(current.checks, typeof update === 'function' ? update(current.checks) : update),
    })), []);
    // Presence projections may recreate equivalent controller objects. Only the semantic
    // request key changes demand; the ref supplies that render's typed inputs to the effect.
    const controllerRef = React.useRef(controller);
    controllerRef.current = controller;
    const [refreshRevision, refreshCatalog] = React.useReducer(value => value + 1, 0);
    const refresh = React.useCallback(() => {
        if (binding && homeId) {
            // Publish the read lifecycle with the demand, even when the answer
            // retains the same catalog objects through structural sharing.
            setState(current => retainShallow(current, { ...current, loading: true }));
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
            return retainShallow(current, { lifetime, binding, accountId: binding.accountId, requestKey,
                provisioners: keepPresentation ? current.provisioners : EMPTY_PROVISIONERS,
                checks: keepPresentation ? current.checks : EMPTY_CHECKS,
                settled: keepPresentation ? current.settled : null,
                error: keepPresentation ? current.error : null, loading: true });
        });
        const publish = (result: ManagedProvisionerReadResult<MachineProvisionersListResultV1>,
            accountResult?: ManagedProvisionerReadResult<MachineProvisionersListResultV1>) => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setState(current => {
                if (current.binding !== binding || current.requestKey !== requestKey) return current;
                const settled = retainShallow(current.settled ?? undefined, { binding, requestKey });
                if (result.kind === 'failed') return retainShallow(current, { ...current, settled, loading: false, error: result.code });
                const provisioners = [...result.value.provisioners];
                const seen = new Set(provisioners.map(entry => buildQualifiedPluginContributionKey(entry.contribution)));
                // The selected daemon owns its installed catalog and OS filtering. Account creation
                // offers are also available when that installation has no copy of their declaration.
                const accountEntries = accountResult?.kind === 'succeeded' ? accountResult.value.provisioners
                    : accountResult?.kind === 'failed' ? current.provisioners : EMPTY_PROVISIONERS;
                for (const entry of accountEntries) {
                    const key = buildQualifiedPluginContributionKey(entry.contribution);
                    if (entry.acquireExecutionTarget !== 'account' || seen.has(key)) continue;
                    seen.add(key);
                    provisioners.push(entry);
                }
                return retainShallow(current, { ...current, settled, loading: false,
                    provisioners: retainDeep(current.provisioners, provisioners),
                    error: accountResult?.kind === 'failed' ? accountResult.code : null });
            });
        };
        const read = (namedController?: ManagedControllerV1) => client.read('machines.provisioners.list', {
            homeId, ...(namedController ? { controller: namedController } : {}), ...(contribution ? { contribution } : {}),
        }, { signal: abort.signal, onApprovalPending: registration => approvalRef.current?.(registration) })
            .catch(() => ({ kind: 'failed' as const, code: 'unavailable' }));
        const selectedRead = read(selectedController);
        const accountRead = selectedController && !contribution ? read() : undefined;
        void selectedRead.then(async result => {
            // A failed controller read settles immediately with its retained cards, as before.
            publish(result, result.kind === 'succeeded' ? await accountRead : undefined);
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [enabled, binding, client, homeId, requestKey, contributionKey, refreshRevision, lifetime, accountReader]);
    const boundAccountId = binding?.isCurrent() ? binding.accountId : resolution.kind === 'bound' ? resolution.scope.accountId : null;
    const sameAccount = state.lifetime === lifetime && (boundAccountId !== null ? state.accountId === boundAccountId
        : resolution.kind === 'resolving' && lifetime?.isCurrent() === true && retained === state);
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
        // Read demand and initial presentation are separate: an equal revalidation
        // still refreshes native checks without withdrawing this Account's answer.
        reading: enabled && binding && !homeId ? false : visible.loading,
        loading: enabled && binding && !homeId ? false : visible.loading && (!sameAccount || state.settled === null),
        current: enabled && sameAccount && homeId !== null && binding?.isCurrent() === true
            && state.settled?.binding === binding && state.settled.requestKey === requestKey && state.error === null,
        refresh };
}
