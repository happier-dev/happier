import * as React from 'react';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { EMPTY_INPUT_OPTIONS, type InputFieldOptionsState } from '@/components/sessions/actions/inputFieldOptionsStore';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { StoreDemand, StoreInstalledInput, StoreItemSummary, StoreListInput } from './storeKinds';
import { useInstalledScope } from './storeAccountAdmission';

export type StoreSoftwareTarget = Pick<StoreInstalledInput, 'scope' | 'machine'>;
export type StoreSoftwareItem = ActionFieldOption;
const SOFTWARE_FIELD = { path: 'software', optionsSourceId: 'machines.setup.software.available' } as const;

/**
 * Demand only. The Action input-options owner retains loading, exact selection and row identity. A target with an
 * Account and `machine: null` reads the inert offerings (what the Account's Software declares, with no Machine and no
 * support claim), which preset editing names items from and adds them with.
 */
export function useSoftwareOptions(target: StoreSoftwareTarget | null | undefined, demand: StoreDemand,
    values?: readonly ActionFieldOption['value'][], refreshKey?: string) {
    const admission = useInstalledScope({ scope: target?.scope ?? null, machine: target?.machine ?? null });
    const { scope, binding } = admission;
    const machine = target?.machine;
    const inert = !!target && machine === null;
    const admitted = !!scope && (inert || !!machine);
    const presence = useMachinePresenceSummary(admitted && !inert ? scope?.serverId : null,
        admitted && !inert ? machine?.machineId : null, admitted && !inert ? binding : null);
    const available = demand.presented && admitted && (inert || presence.reachability === 'reachable');
    const request = { field: SOFTWARE_FIELD, draftInput: inert ? {} : { homeId: machine?.serverIdentityId, machineId: machine?.machineId },
        ...(values === undefined ? {} : { values }) };
    const options = useInputFieldOptions({ requests: [request], enabled: available, serverId: scope?.serverId,
        accountLifetime: admitted ? binding : null, refreshKey });
    const reason = !admitted ? 'missing_option_dependency' : inert ? null : presence.reachability === 'unreachable' ? 'offline'
        : presence.reachability === 'unknown' ? 'unknown' : null;
    const state: InputFieldOptionsState = !demand.presented ? { status: 'ready', options: EMPTY_INPUT_OPTIONS }
        : reason ? { status: 'failed', options: EMPTY_INPUT_OPTIONS, errorCode: reason } : options.state(SOFTWARE_FIELD);
    return { state, refresh: options.retry, target: admitted ? target : null, accountLifetime: admitted ? binding : null };
}

export function softwareSummary(item: StoreSoftwareItem): StoreItemSummary<StoreSoftwareItem> {
    return { key: actionInputOptionValueKey(item.value), ref: item, title: item.label, description: item.description };
}

export function useSoftwareList(input: StoreListInput, demand: StoreDemand) {
    const native = useSoftwareOptions(input.softwareTarget, { presented: demand.presented && input.sourceIds === undefined }, undefined, input.refreshKey);
    const items = React.useMemo(() => native.state.options.filter(item =>
        `${item.label} ${item.description ?? ''}`.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase())),
    [native.state.options, input.query]);
    return { items, loading: native.state.status === 'loading', stale: native.state.status === 'failed', hasNextPage: false as const,
        error: native.state.errorCode ?? null, refresh: native.refresh };
}
export type StoreSoftwareList = ReturnType<typeof useSoftwareList>;
