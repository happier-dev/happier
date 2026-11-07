import * as React from 'react';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineRecipeSelectionV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachinePublishedDaemonStateV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { useMachineListForServerSelection } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';
import { useInstalledMachines } from './storeInstalled';
import type { InstalledScopeAdmission } from './storeAccountAdmission';

type RecipeInstallation = Readonly<{ machineId: string; observation: NonNullable<MachinePublishedDaemonStateV1['setup']>['recipes'][number] | null }>;
type SoftwareGroup = { subject: 'recipe'; native: MachineRecipeSelectionV1; installations: RecipeInstallation[] }
    | { subject: 'toolchain'; native: NonNullable<MachineSetupV1['toolchain']>; installations: Array<Readonly<{ machineId: string }>> };
export type InstalledSoftwareRow = Readonly<{ kind: 'software'; key: string; scope: ServerAccountScope }> & (
    Readonly<{ subject: 'recipe'; native: MachineRecipeSelectionV1; installations: readonly RecipeInstallation[] }>
    | Readonly<{ subject: 'toolchain'; native: NonNullable<MachineSetupV1['toolchain']>; installations: readonly Readonly<{ machineId: string }>[] }>
);
type NativeReason = NonNullable<InstalledScopeAdmission['failure']>
    | NonNullable<ReturnType<typeof useInstalledMachines>['failure']>
    | NonNullable<ReturnType<typeof useInstalledMachines>['snapshot']>;
export type InstalledSoftwareResult = InstalledFamilyResult<InstalledSoftwareRow, NativeReason, never>;
const EMPTY_ROWS: readonly InstalledSoftwareRow[] = Object.freeze([]);
const EMPTY_GROUPS: Readonly<{ rows: readonly InstalledSoftwareRow[]; missing: boolean }> = Object.freeze({ rows: EMPTY_ROWS, missing: false });

/** Recorded desired copies and their revision-matched compact observations, never a native census. */
export function useInstalledSoftware(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledSoftwareResult {
    const held = useInstalledMachines(input, demand, admitted.scope, !input.projectKey);
    const scope = admitted.scope;
    const projecting = demand.presented && !!scope && !input.projectKey;
    // Unchanged Software groups keep their row identity when another group's setup changes.
    const lastGroups = React.useRef(EMPTY_GROUPS);
    const selectGroups = React.useMemo(() => {
        return (records: readonly Machine[]): Readonly<{ rows: readonly InstalledSoftwareRow[]; missing: boolean }> => {
            if (!projecting || !scope) return EMPTY_GROUPS;
            const visible = new Set(held.machineIds);
            const groups = new Map<string, SoftwareGroup>();
            let missing = false;
            for (const machine of records) {
                if (!visible.has(machine.id)) continue;
                if (!machine.metadata || machine.availability?.kind !== 'available'
                    || machine.access && machine.access.accessState !== 'ready') { missing = true; continue; }
                const desired = machine.metadata.setup;
                const nativeState: MachinePublishedDaemonStateV1 | null = machine.daemonState;
                const observation = desired && nativeState?.setup?.desiredRevision === desired.revision ? nativeState.setup : null;
                const placed = new Set<string>();
                for (const source of desired?.sources ?? []) {
                    for (const item of source.setup.items ?? []) {
                        if (item.kind !== 'softwareRecipe') continue;
                        const key = serverAccountScopedResourceKey(scope, 'software', 'recipe', actionInputOptionValueKey(item.selection));
                        if (placed.has(key)) continue;
                        placed.add(key);
                        const installation = { machineId: machine.id, observation: observation?.recipes.find(recipe => recipe.ref.pluginId === item.selection.ref.pluginId
                            && recipe.ref.recipeId === item.selection.ref.recipeId && recipe.ref.revision === item.selection.ref.revision) ?? null };
                        const group = groups.get(key);
                        if (group?.subject === 'recipe') group.installations.push(installation);
                        else groups.set(key, { subject: 'recipe', native: item.selection, installations: [installation] });
                    }
                    if (source.setup.toolchain) {
                        const key = serverAccountScopedResourceKey(scope, 'software', 'toolchain', actionInputOptionValueKey(source.setup.toolchain));
                        if (placed.has(key)) continue;
                        placed.add(key);
                        const group = groups.get(key);
                        if (group?.subject === 'toolchain') group.installations.push({ machineId: machine.id });
                        else groups.set(key, { subject: 'toolchain', native: source.setup.toolchain, installations: [{ machineId: machine.id }] });
                    }
                }
            }
            const last = lastGroups.current;
            const previous = new Map(last.rows.map(row => [row.key, row]));
            const rows = [...groups].map(([key, group]): InstalledSoftwareRow => {
                const retained = previous.get(key);
                if (retained?.subject === group.subject && retained.installations.length === group.installations.length
                    && retained.installations.every((installation, index) => installation.machineId === group.installations[index]!.machineId
                        && (!('observation' in installation) || group.subject === 'recipe'
                            && installation.observation === group.installations[index]!.observation))) return retained;
                return { ...group, kind: 'software', key, scope };
            });
            const retainedRows = rows.length === last.rows.length && rows.every((row, index) => row === last.rows[index]) ? last.rows : rows;
            if (retainedRows !== last.rows || missing !== last.missing) lastGroups.current = { rows: retainedRows, missing };
            return lastGroups.current;
        };
    }, [held.machineIds, projecting, scope]);
    const setupDemand = React.useMemo(() => ({
        machineIds: projecting ? held.machineIds : [],
        fields: [{ section: 'metadata', field: 'setup' }, { section: 'daemonState', field: 'setup' }] as const,
    }), [held.machineIds, projecting]);
    const groups = useMachineListForServerSelection(scope?.serverId ?? '', selectGroups, setupDemand);
    return React.useMemo<InstalledSoftwareResult>(() => {
        if (!scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        if (!demand.presented) return { rows: EMPTY_ROWS, coverage: 'loading' };
        const snapshot = held.snapshot;
        if (!snapshot) return { rows: EMPTY_ROWS, coverage: 'loading' };
        if (snapshot.kind !== 'resolved') return { rows: EMPTY_ROWS, coverage: { unavailable: snapshot } };
        // Setup is Machine-owned, with no per-Project membership claim.
        if (input.projectKey) return { rows: EMPTY_ROWS, coverage: 'available' };
        const incomplete = groups.missing || snapshot.settled !== true || snapshot.observation !== 'live';
        return { rows: groups.rows, coverage: incomplete ? { partial: snapshot } : 'available' };
    }, [scope, admitted.coverage, held.failure, held.snapshot, groups, demand.presented, input.projectKey]);
}
