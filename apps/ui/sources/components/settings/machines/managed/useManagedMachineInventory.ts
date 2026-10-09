import * as React from 'react';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';

const execute = createFrontDoorActionExecute();
const EMPTY_ROWS: readonly ManagedMachineV1[] = [];

export type ManagedMachineInventoryEntry = Readonly<{
    accountId: string;
    managedId?: string;
    machines: readonly ManagedMachineV1[];
    status: 'loading' | 'ready' | 'error' | 'unsupported' | 'denied' | 'missing';
    errorCode?: string;
    asOf?: number;
    approval?: ActionApprovalRegistration;
}>;

/** A demanded projection of the canonical server inventory, with no persisted UI resource state. */
export function useManagedMachineInventory(serverIds: readonly string[], managedId?: string,
    executeAction: ReturnType<typeof createFrontDoorActionExecute> = execute) {
    const idsKey = JSON.stringify([...new Set(serverIds.map(id => resolveServerProfileScopeIdForIdentifier(id) || id))].sort());
    const requestedIdsKey = JSON.stringify(serverIds);
    const ids = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    const accountScopes = useServerCredentialAccountScopeStates(ids);
    const bindings = React.useMemo(() => new Map([...accountScopes].flatMap(([serverId, state]) => state.binding ? [[serverId, state.binding] as const] : [])), [accountScopes]);
    const [entries, setEntries] = React.useState<Readonly<Record<string, ManagedMachineInventoryEntry>>>({});
    const [refreshRevision, refresh] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => subscribeHomeAccountChange(event => {
        if (ids.includes(resolveServerProfileScopeIdForIdentifier(event.serverId) || event.serverId)) refresh();
    }), [ids]);

    React.useEffect(() => {
        const requests: AbortController[] = [];
        const retirements: Array<{ dispose(): void }> = [];
        for (const serverId of ids) {
            const binding = bindings.get(serverId);
            if (!binding?.isCurrent()) continue;
            const homeId = getServerProfileById(serverId)?.serverIdentityId;
            if (!homeId) continue;
            const cancellation = new AbortController();
            requests.push(cancellation);
            retirements.push(binding.onRetire(() => cancellation.abort()));
            setEntries(previous => {
                const current = previous[serverId];
                const sameTarget = current?.accountId === binding.accountId && current.managedId === managedId;
                return { ...previous, [serverId]: { accountId: binding.accountId, managedId,
                    machines: sameTarget ? current.machines : EMPTY_ROWS,
                    ...(sameTarget && current.asOf !== undefined ? { asOf: current.asOf } : {}), status: 'loading' } };
            });
            void (async () => {
                try {
                    type ReadResult = Readonly<{ kind: 'succeeded'; machines: ManagedMachineV1[] }> | Readonly<{ kind: 'failed'; code: string }>;
                    const actionId = managedId ? 'machines.managed.get' : 'machines.managed.list';
                    const input = managedId ? { homeId, managedId } : { homeId };
                    const result = await awaitActionApprovalResult<ManagedMachineV1[], ReadResult>({
                        signal: cancellation.signal,
                        execute: async callbacks => {
                            const outcome = classifyHomeActionOutcome(await executeAction(actionId, input, { surface: 'ui', serverId,
                                expectedAccountId: binding.accountId, signal: cancellation.signal }));
                            if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
                            if (outcome.kind === 'approval_pending') {
                                const approval = createActionApprovalContinuation<ManagedMachineV1 | { machines: ManagedMachineV1[] }, typeof actionId>({
                                    artifactId: outcome.artifactId, actionId, scope: binding.scope, expectedInput: input,
                                    signal: cancellation.signal,
                                    onSucceeded: value => callbacks.onApprovalSucceeded('machines' in value ? value.machines : [value]),
                                    onFailed: callbacks.onApprovalFailed,
                                });
                                if (binding.isCurrent() && !cancellation.signal.aborted) setEntries(previous => ({ ...previous,
                                    [serverId]: { ...previous[serverId]!, approval } }));
                                return { approvalPending: true };
                            }
                            const machines = managedId
                                ? [ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(outcome.result)]
                                : ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(outcome.result).machines;
                            return { kind: 'succeeded', machines };
                        },
                        succeeded: machines => ({ kind: 'succeeded', machines }), failed: code => ({ kind: 'failed', code }),
                        aborted: () => ({ kind: 'failed', code: 'aborted' }),
                    });
                    if (!binding.isCurrent() || cancellation.signal.aborted) return;
                    if (result.kind === 'failed') {
                        const code = result.code;
                        const denied = code === 'permission_denied' || code === 'not_authenticated' || code === 'action_account_scope_changed';
                        const status = denied ? 'denied' : code === 'managed_not_found' ? 'missing' : code === 'unsupported_action' ? 'unsupported' : 'error';
                        setEntries(previous => {
                            const { approval: _approval, ...entry } = previous[serverId]!;
                            return { ...previous, [serverId]: { ...entry, status, errorCode: code,
                                ...(status === 'denied' || status === 'missing' ? { machines: EMPTY_ROWS, asOf: undefined } : {}) } };
                        });
                        return;
                    }
                    const machines = result.machines;
                    if (machines.some(machine => machine.homeId !== homeId || (managedId && machine.id !== managedId))) throw new Error('managed_response_invalid');
                    setEntries(previous => {
                        const current = previous[serverId];
                        return { ...previous, [serverId]: { accountId: binding.accountId, managedId, status: 'ready', asOf: Date.now(),
                            machines: current?.accountId === binding.accountId && sameStrictJsonValue(current.machines, machines) ? current.machines : machines } };
                    });
                } catch {
                    if (!binding.isCurrent() || cancellation.signal.aborted) return;
                    setEntries(previous => {
                        const { approval: _approval, ...entry } = previous[serverId]!;
                        return { ...previous, [serverId]: { ...entry, status: 'error', errorCode: 'managed_request_failed' } };
                    });
                }
            })();
        }
        return () => { requests.forEach(request => request.abort()); retirements.forEach(retirement => retirement.dispose()); };
    }, [bindings, ids, managedId, refreshRevision, executeAction]);

    const currentEntries = React.useMemo(() => {
        const result: Record<string, ManagedMachineInventoryEntry> = {};
        for (const serverId of ids) {
            const binding = bindings.get(serverId);
            const entry = entries[serverId];
            if (binding?.isCurrent() && entry?.accountId === binding.accountId && entry.managedId === managedId) result[serverId] = entry;
        }
        return result;
    }, [bindings, entries, ids, managedId]);

    const machinesByServerId = React.useMemo(() => Object.fromEntries((JSON.parse(requestedIdsKey) as string[]).map(serverId => [serverId,
        currentEntries[resolveServerProfileScopeIdForIdentifier(serverId) || serverId]?.machines ?? EMPTY_ROWS,
    ])), [currentEntries, requestedIdsKey]);
    const machinesByEnrolledMachineIdByServerId = React.useMemo(() => Object.fromEntries<Readonly<Record<string, ManagedMachineV1>>>(
        Object.entries(machinesByServerId).map(([serverId, machines]) => [serverId, Object.fromEntries<ManagedMachineV1>(
            machines.flatMap(machine => machine.enrolledMachineId ? [[machine.enrolledMachineId, machine]] : []),
        )]),
    ), [machinesByServerId]);

    const loading = ids.some(serverId => getServerProfileById(serverId)?.serverIdentityId
        && ((!accountScopes.has(serverId) || accountScopes.get(serverId)?.resolution.kind === 'resolving')
            || (bindings.has(serverId) && (!currentEntries[serverId] || currentEntries[serverId]?.status === 'loading'))));
    return { entries: currentEntries, machinesByServerId, machinesByEnrolledMachineIdByServerId, refresh, bindings, accountScopes, loading };
}
