import * as React from 'react';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { MachineRecipeReferenceV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import type { MachineSetupAgentOffer } from '@/components/settings/machines/managed/machineSetupItems';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import type { ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { EMPTY_INPUT_OPTIONS, type InputFieldOptionsState } from '@/components/sessions/actions/inputFieldOptionsStore';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { StoreDemand, StoreInstalledInput, StoreItemSummary, StoreListInput } from './storeKinds';
import { useInstalledScope, type InstalledScopeAdmission } from './storeAccountAdmission';

export type StoreSoftwareTarget = Pick<StoreInstalledInput, 'scope' | 'machine'>;
export type StoreSoftwareItem = ActionFieldOption;
const SOFTWARE_FIELD = { path: 'software', optionsSourceId: 'machines.setup.software.available' } as const;
const RECIPE_FIELD = { path: 'recipes', optionsSourceId: 'machines.setup.recipes.available' } as const;

/**
 * Demand only. The Action input-options owner retains loading, exact selection and row identity. A target with an
 * Account and `machine: null` reads the inert offerings (what the Account's Software declares, with no Machine and no
 * support claim).
 */
export function useSoftwareOptions(target: StoreSoftwareTarget | null | undefined, demand: StoreDemand,
    values?: readonly ActionFieldOption['value'][], refreshKey?: string) {
    return useMachineSetupOptions(SOFTWARE_FIELD, target, demand, values, refreshKey);
}

export function useMachineSetupListingOption(target: StoreSoftwareTarget, demand: StoreDemand,
    value: ActionFieldOption['value'], refreshKey?: string) {
    const field = MachineRecipeReferenceV1Schema.safeParse(value).success ? RECIPE_FIELD : SOFTWARE_FIELD;
    return useMachineSetupOptions(field, target, demand, [value], refreshKey);
}

/** Attached recipe presentation uses Account declarations, independently of a Machine's support or presence. */
export function useMachineSetupRecipeOptions(target: StoreSoftwareTarget | null | undefined, demand: StoreDemand) {
    const declarationTarget = React.useMemo(() => target ? { scope: target.scope, machine: null } : null, [target?.scope]);
    const admission = useInstalledScope({ scope: declarationTarget?.scope ?? null, machine: null });
    return useAdmittedMachineSetupRecipeOptions(declarationTarget, demand, admission);
}

/** Inert catalog choices use the captured Account's declarations, without Machine probes or installation. */
export function useMachineSetupAgentOptions(target: StoreSoftwareTarget | null | undefined, demand: StoreDemand) {
    const { scope } = useInstalledScope({ scope: target?.scope ?? null, machine: null });
    const reader = usePluginAccountAvailabilityReader(scope, undefined, { enabled: demand.presented });
    const held = React.useMemo<{ current: readonly MachineSetupAgentOffer[] | null }>(() => ({ current: null }),
        [scope?.accountId, scope?.serverId]);
    const offers = React.useMemo(() => {
        if (!scope) return null;
        if (!demand.presented) return held.current;
        if (!reader || reader.readInstalledPlugins().kind !== 'available') return null;
        const entries = new Map<string, MachineSetupAgentOffer>(getResolvedAgentCatalogEntries({ enabledAgentIds: [] }).map(entry => [entry.qualifiedId, {
            agentId: entry.qualifiedId, title: entry.title, ...(entry.subtitle ? { description: entry.subtitle } : {}), icon: entry.iconName,
        } satisfies MachineSetupAgentOffer]));
        for (const selection of reader.readCurrentAccountExecutionDeclarations()) {
            for (const agent of selection.manifest.contributes?.agents ?? []) {
                const agentId = buildQualifiedPluginContributionKey({ pluginId: selection.manifest.id, localId: agent.id });
                if (!entries.has(agentId)) entries.set(agentId, { agentId, title: resolvePluginLocalizedStringV2Text(agent.title),
                    ...(agent.description ? { description: resolvePluginLocalizedStringV2Text(agent.description) } : {}) });
            }
        }
        return held.current = retainDeep(held.current ?? [], [...entries.values()]);
    }, [scope, reader, demand.presented, held]);
    return { offers };
}

/** Installed already admitted its Account; recipe names consume that same lifetime. */
export function useAdmittedMachineSetupRecipeOptions(target: StoreSoftwareTarget | null | undefined, demand: StoreDemand,
    admission: InstalledScopeAdmission) {
    return useAdmittedMachineSetupOptions(RECIPE_FIELD, target, demand, admission);
}

function useMachineSetupOptions(field: typeof SOFTWARE_FIELD | typeof RECIPE_FIELD,
    target: StoreSoftwareTarget | null | undefined, demand: StoreDemand,
    values?: readonly ActionFieldOption['value'][], refreshKey?: string) {
    const admission = useInstalledScope({ scope: target?.scope ?? null, machine: target?.machine ?? null });
    return useAdmittedMachineSetupOptions(field, target, demand, admission, values, refreshKey);
}

function useAdmittedMachineSetupOptions(field: typeof SOFTWARE_FIELD | typeof RECIPE_FIELD,
    target: StoreSoftwareTarget | null | undefined, demand: StoreDemand, admission: InstalledScopeAdmission,
    values?: readonly ActionFieldOption['value'][], refreshKey?: string) {
    const { scope, binding } = admission;
    const machine = target?.machine;
    const inert = !!target && machine === null;
    const admitted = !!scope && (inert || !!machine);
    const presence = useMachinePresenceSummary(admitted && !inert ? scope?.serverId : null,
        admitted && !inert ? machine?.machineId : null, admitted && !inert ? binding : null);
    // Inert offerings are the Account's declarations: they cannot be read before its availability has arrived.
    const accountDeclarations = usePluginAccountAvailabilityReader(inert ? scope : null, undefined, { enabled: inert && demand.presented });
    const declarations = React.useMemo(() => accountDeclarations?.readInstalledPlugins() ?? null, [accountDeclarations]);
    const awaitingDeclarations = inert && declarations?.kind === 'unavailable' && declarations.code === 'account_availability_not_loaded';
    const available = demand.presented && admitted && (inert ? !awaitingDeclarations : presence.reachability === 'reachable');
    const request = { field, draftInput: inert ? {} : { homeId: machine?.serverIdentityId, machineId: machine?.machineId },
        ...(values === undefined ? {} : { values }) };
    const options = useInputFieldOptions({ requests: [request], enabled: available, serverId: scope?.serverId,
        accountLifetime: admitted ? binding : null, refreshKey });
    const reason = !admitted ? 'missing_option_dependency' : inert ? null : presence.reachability === 'unreachable' ? 'offline'
        : presence.reachability === 'unknown' ? 'unknown' : null;
    const state: InputFieldOptionsState = !demand.presented ? { status: 'ready', options: EMPTY_INPUT_OPTIONS }
        : awaitingDeclarations ? { status: 'loading', options: EMPTY_INPUT_OPTIONS }
        : reason ? { status: 'failed', options: EMPTY_INPUT_OPTIONS, errorCode: reason } : options.state(field);
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
