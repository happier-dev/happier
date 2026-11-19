import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useMachineDisplayNamesById, useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    isMachineAdministrationCandidateExplicitlySelectable,
    machineAdministrationTargetsEqual,
    resolveMachineAdministrationTargetState,
    readMachineAdministrationTargetRouteParams,
    type MachineAdministrationTargetRouteParamsV1,
    type MachineAdministrationCandidateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { areMachineDisplaySemanticsEqual } from '@/sync/domains/machines/machineDisplayRenderable';
import { t } from '@/text';
import { describeMachineLockedReason, getMachineSentenceName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { presentMachineAdministrationTargetState } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { PROVIDER_DECLARATION_CONTEXT_SECTIONS } from '@/providers/catalog/accountProviderDeclarations';

function sameCatalogCandidate(left: MachineAdministrationCandidateV1, right: MachineAdministrationCandidateV1): boolean {
    return left.target.machineId === right.target.machineId
        && left.target.serverIdentityId === right.target.serverIdentityId
        && left.displayName === right.displayName
        && left.displayNameParts?.name === right.displayNameParts?.name
        && left.displayNameParts?.hint === right.displayNameParts?.hint
        && left.serverLabel === right.serverLabel
        && left.availability === right.availability
        && left.observation === right.observation
        && left.replacementTarget?.machineId === right.replacementTarget?.machineId;
}

/**
 * The Agents catalog reads, of each machine: its identity and labels, whether it is available, its
 * replacement, its published agent inventory and platform (the display semantics), and the selected
 * target and its state. It does not read heartbeat clocks (`updatedAt`/`activeAt`, whose presence owner
 * is separate) or any field outside the display record (daemon state versions and the like). A machine
 * write that changes none of what is read keeps the previous selection, so the catalog and every row
 * built from it stay as they are. Operations resolve their target fresh at call time, so retaining the
 * selection retains no execution authority.
 */
export function retainCatalogTargetSelection(
    previous: MachineAdministrationTargetSelectionV1 | undefined,
    next: MachineAdministrationTargetSelectionV1,
): MachineAdministrationTargetSelectionV1 {
    if (previous === undefined || previous === next) return next;
    const same = previous.pickerRows.length === next.pickerRows.length
        && previous.pickerRows.every((row, index) => {
            const other = next.pickerRows[index]!;
            return row === other || (row.serverId === other.serverId && row.serverName === other.serverName
                && sameCatalogCandidate(row.candidate, other.candidate)
                && areMachineDisplaySemanticsEqual(row.machine, other.machine));
        })
        && sameCatalogState(previous.state, next.state)
        && machineAdministrationTargetsEqualOrBothNull(previous.selectedTarget, next.selectedTarget)
        && previous.selectedTargetServerMatchesActiveAccount === next.selectedTargetServerMatchesActiveAccount
        && previous.canExecute === next.canExecute
        && previous.changeIntent === next.changeIntent;
    return same ? previous : next;
}

function sameCatalogState(left: MachineAdministrationTargetSelectionV1['state'], right: MachineAdministrationTargetSelectionV1['state']): boolean {
    if (left === right) return true;
    if (left.kind !== right.kind) return false;
    if (left.kind === 'unselected' && right.kind === 'unselected') {
        return left.candidates.length === right.candidates.length
            && left.candidates.every((candidate, index) => sameCatalogCandidate(candidate, right.candidates[index]!));
    }
    if (left.kind === 'unselected' || right.kind === 'unselected') return false;
    const leftCandidate = 'machine' in left ? left.machine : left.snapshot;
    const rightCandidate = 'machine' in right ? right.machine : right.snapshot;
    return machineAdministrationTargetsEqual(left.target, right.target)
        && (leftCandidate === null || rightCandidate === null ? leftCandidate === rightCandidate : sameCatalogCandidate(leftCandidate, rightCandidate))
        && (left.kind !== 'missing' || (right.kind === 'missing' && left.inventoryKnown === right.inventoryKnown && left.inventoryStatus === right.inventoryStatus))
        && (left.kind !== 'replaced' || (right.kind === 'replaced' && left.replacementTarget?.machineId === right.replacementTarget?.machineId));
}

function machineAdministrationTargetsEqualOrBothNull(
    left: MachineAdministrationTargetSelectionV1['selectedTarget'],
    right: MachineAdministrationTargetSelectionV1['selectedTarget'],
): boolean {
    return left === null || right === null ? left === right : machineAdministrationTargetsEqual(left, right);
}

/**
 * The machine the Agents pages manage. Agents show a machine's last known state while it is away,
 * so an offline machine stays choosable; automatic selection still takes only a sole live one.
 */
export function useAgentsAdministrationTargetSelection(
    route?: MachineAdministrationTargetRouteParamsV1,
    rows: 'choices' | 'selected' = 'choices',
): MachineAdministrationTargetSelectionV1 {
    const initialTarget = React.useMemo(() => route ? readMachineAdministrationTargetRouteParams(route) : null,
        [route?.machineId, route?.serverIdentityId]);
    return useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents, {
        explicitSelection: 'lastKnown',
        rows,
        ...(route ? { initialTarget } : {}),
    });
}

/** How the Agents machine picker presents a candidate: offline machines stay choosable. */
export function resolveAgentsMachineCandidateAvailability(candidate: MachineAdministrationCandidateV1): Readonly<{
    detail: string;
    selectable: boolean;
}> {
    const selectable = isMachineAdministrationCandidateExplicitlySelectable(candidate, 'lastKnown');
    if (candidate.availability === 'online' && candidate.observation === 'live') {
        return { detail: t('settingsProviders.detail.machineOnline'), selectable };
    }
    if (candidate.availability === 'online' || candidate.availability === 'offline') {
        return { detail: t('settingsAgents.offline.pickerDetail'), selectable };
    }
    const presentation = presentMachineAdministrationTargetState(resolveMachineAdministrationTargetState({
        storedTarget: candidate.target, candidates: [candidate],
    }));
    return { detail: presentation.detail ?? presentation.title, selectable };
}

/**
 * The selected machine as the Agents pages address it: live when it can run operations, otherwise
 * the last known scope whose cached projection is still worth showing.
 */
export function useAgentsMachineScope(
    targetSelection: MachineAdministrationTargetSelectionV1,
    rows: 'choices' | 'selected' = 'choices',
) {
    const executionTarget = React.useMemo(() => {
        const selectedTarget = targetSelection.selectedTarget;
        const resolvedTarget = targetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [targetSelection]);
    const selectedRow = React.useMemo(() => {
        const selectedTarget = targetSelection.selectedTarget;
        return selectedTarget
            ? targetSelection.pickerRows.find((row) => machineAdministrationTargetsEqual(row.candidate.target, selectedTarget)) ?? null
            : null;
    }, [targetSelection.pickerRows, targetSelection.selectedTarget]);
    const machineId = executionTarget?.machine.id ?? selectedRow?.machine.id ?? null;
    const serverId = executionTarget?.serverId ?? selectedRow?.serverId ?? null;
    const machine = executionTarget?.machine ?? selectedRow?.machine ?? null;
    // Named as the picker chip names it: same-name machines of one Home carry their disambiguator.
    // The label only appears in copy ("On {machine}", "Install on {machine}"), so a machine whose name
    // is still loading reads "this machine" rather than its placeholder title.
    const nameIds = React.useMemo(() => rows === 'selected' && machineId ? [machineId] : [], [machineId, rows]);
    const names = useMachineDisplayNamesById(nameIds, { serverId: serverId ?? undefined, presented: rows === 'selected' });
    const displayName = rows === 'selected' || !serverId || !machine ? names[machineId ?? '']
        : resolveMachineDisplayNames(targetSelection.pickerRows.filter(row => row.serverId === serverId).map(row => row.machine))
            .get(machine.id);
    const machineLabel = machine ? getMachineSentenceName(machine, displayName) : null;
    return {
        executionTarget,
        /** Presence comes from the canonical target state, not execution admission. */
        offline: targetSelection.state.kind === 'offline',
        projectionScope: machineId && serverId ? { machineId, serverId } : null,
        machineLabel,
        machineLockedReason: describeMachineLockedReason(machine),
    } as const;
}

export type AgentAdministrationCatalog = Readonly<{
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: ReturnType<typeof useAgentsMachineScope>['executionTarget'];
    projectionScope: ReturnType<typeof useAgentsMachineScope>['projectionScope'];
    machineOnline: boolean;
    machineLabel: ReturnType<typeof useAgentsMachineScope>['machineLabel'];
    projectionCurrent: boolean;
    declarationProjection?: PluginProjectionV2 | null;
    agentEntries: ReturnType<typeof getResolvedAgentCatalogEntries>;
}>;

/**
 * The Agents collection as the selected administration machine projects it: the canonical target
 * selection, its fresh execution target, the daemon projection phase and the resolved catalog
 * entries. The collection rail and the index page read the same owner so they cannot disagree
 * about which agents exist on the machine. An offline machine keeps its last known projection.
 */
export function useAgentAdministrationCatalog(options?: Readonly<{
    /** `false`: read the machine's cached projection only, never load it (a summary elsewhere). */
    loadProjection?: boolean;
    /** Read the selected Machine for a summary that has no chooser. */
    targetRows?: 'selected';
}>): AgentAdministrationCatalog {
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const retainedSelection = React.useRef<MachineAdministrationTargetSelectionV1 | undefined>(undefined);
    const liveSelection = useAgentsAdministrationTargetSelection(undefined, options?.targetRows);
    const targetSelection = retainCatalogTargetSelection(retainedSelection.current, liveSelection);
    retainedSelection.current = targetSelection;
    const scope = useAgentsMachineScope(targetSelection, options?.targetRows);
    const { snapshot: acpCatalog } = useAcpCatalogForServer(scope.projectionScope?.serverId
        ?? (targetSelection.selectedTarget === null || targetSelection.selectedTargetServerMatchesActiveAccount
            ? undefined : null));
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: scope.projectionScope?.machineId ?? null,
        serverId: scope.projectionScope?.serverId ?? null,
        enabled: scope.projectionScope !== null,
        load: options?.loadProjection !== false && scope.executionTarget !== null,
        // Agent entries plus the provider declaration context its consumers build.
        sections: PROVIDER_DECLARATION_CONTEXT_SECTIONS,
    });
    // Same-scope inputs survive refresh and error: they are inert metadata, and every daemon
    // operation stays gated on a live execution target.
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;
    const agentEntries = React.useMemo(() => getResolvedAgentCatalogEntries({
        enabledAgentIds: [],
        backendEnabledByTargetKey,
        acpCatalogSnapshot: !acpCatalog?.stale ? acpCatalog?.catalog : undefined,
        mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    }), [acpCatalog, backendEnabledByTargetKey, daemonMergedProjectionInputs]);

    // One object per distinct catalog content, so a re-render that changed none of its parts
    // does not hand its consumers a new catalog.
    const { executionTarget, projectionScope, machineLabel } = scope;
    const declarationProjection = daemonMergedProjectionInputs?.pluginProjectionV2 ?? null;
    const projectionCurrent = daemonMergedProjection.phase === 'ready';
    return React.useMemo((): AgentAdministrationCatalog => ({
        targetSelection,
        executionTarget,
        projectionScope,
        machineOnline: executionTarget !== null,
        machineLabel,
        projectionCurrent,
        // Declarations describe choices, not execution authority. The projection owner already
        // fences Account/target changes and retains same-scope metadata while a refresh settles.
        declarationProjection,
        agentEntries,
    }), [targetSelection, executionTarget, projectionScope, machineLabel, projectionCurrent, declarationProjection, agentEntries]);
}
