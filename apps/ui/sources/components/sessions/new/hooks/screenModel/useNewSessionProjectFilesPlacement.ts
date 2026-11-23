import * as React from 'react';
import type { SessionPlacementSelectionV1, SessionProjectFilesSourceV1, SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export type NewSessionProjectFilesOutcome = Readonly<{
    placementKind: SessionPlacementSelectionV1['kind'] | null;
    source?: SessionProjectFilesSourceV1;
}> & (Readonly<{ origin: 'default' }> | Readonly<{ origin: 'override'; choice: SessionProjectFilesV1 }>);


type ManagedProjectPlacementMode = 'in_place' | 'copy';

const MANAGED_PROJECT_COPY_DEFAULT = { kind: 'copy_once' } as const satisfies SessionProjectFilesV1;

/** Project files is part of the current placement, never an independent preference. */
export function useNewSessionProjectFilesPlacement(input: Readonly<{
    draftKey: string;
    selectedPath?: string;
    executionTarget: SessionAuthoringDraft['executionTarget'];
    managedMachineSelection: Pick<ManagedMachineSelectionDraft, 'selection'> | null;
    hydratedPlacement?: SessionPlacementSelectionV1;
    projectFilesSource?: SessionProjectFilesSourceV1;
}>): Readonly<{
    sessionPlacement: SessionPlacementSelectionV1 | undefined;
    projectFilesOverride: SessionProjectFilesV1 | undefined;
    projectFilesOutcome: NewSessionProjectFilesOutcome;
    managedProjectPlacement?: Readonly<{
        workspace: Extract<SessionPlacementSelectionV1, { kind: 'in_place' }>['workspace'];
        selected: ManagedProjectPlacementMode;
        select: (mode: ManagedProjectPlacementMode) => void;
    }>;
    onProjectFilesChange: (value: SessionProjectFilesV1 | undefined) => void;
}> {
    const selectedPreset = input.managedMachineSelection?.selection.kind === 'preset'
        ? input.managedMachineSelection.selection : null;
    const machine = input.executionTarget?.kind === 'machine' ? input.executionTarget.target : null;
    const placement = React.useMemo<Exclude<SessionPlacementSelectionV1, { kind: 'in_place' }> | undefined>(() => selectedPreset
        ? { kind: 'preset', homeId: selectedPreset.homeId, presetId: selectedPreset.id }
        : input.managedMachineSelection ? { kind: 'managed' }
            : machine ? { kind: 'machine', target: machine } : undefined,
    [input.managedMachineSelection, machine, selectedPreset]);
    const hydrated = input.hydratedPlacement;
    const hydratedSource = hydrated?.kind === 'machine' ? hydrated.projectFilesSource : undefined;
    const hydratedManagedSource = hydratedSource && 'workspace' in hydratedSource ? hydratedSource : undefined;
    const workspace = hydrated?.kind === 'in_place' ? hydrated.workspace : hydratedManagedSource?.workspace;
    const managedProject = workspace && placement?.kind === 'machine' && input.selectedPath
        && areServerProfileIdentifiersEquivalent(placement.target.serverId, workspace.serverId)
        && placement.target.machineId === workspace.controller.machineId
        && normalizeWorkspaceRootPathV1(input.selectedPath) === normalizeWorkspaceRootPathV1(workspace.rootPath)
        ? workspace : undefined;
    const placementKey = placement?.kind === 'preset'
        ? JSON.stringify([input.draftKey, placement.kind, placement.homeId, placement.presetId])
        : placement?.kind === 'machine' ? JSON.stringify([input.draftKey, placement.kind, placement.target.serverId,
            placement.target.machineId, managedProject?.workspaceId, managedProject?.controller.installationId])
            : placement ? JSON.stringify([input.draftKey, placement.kind]) : null;
    const matchingHydrated = placement?.kind === 'preset' && hydrated?.kind === 'preset'
        ? placement.homeId === hydrated.homeId && placement.presetId === hydrated.presetId ? hydrated : undefined
        : placement?.kind === 'machine' && hydrated?.kind === 'machine'
            && placement.target.serverId === hydrated.target.serverId && placement.target.machineId === hydrated.target.machineId
            && (!hydratedManagedSource || managedProject)
            ? hydrated : placement?.kind === 'managed' && hydrated?.kind === 'managed' ? hydrated : undefined;
    const [edit, setEdit] = React.useState<Readonly<{
        key: string | null;
        value: SessionProjectFilesV1 | undefined;
        managedProjectMode?: ManagedProjectPlacementMode;
    }> | null>(null);
    const currentEdit = edit?.key === placementKey ? edit : undefined;
    const managedProjectMode = managedProject
        ? currentEdit?.managedProjectMode ?? (hydratedManagedSource ? 'copy' : 'in_place')
        : undefined;
    const inPlace = React.useMemo(() => managedProject && managedProjectMode === 'in_place'
        ? { kind: 'in_place' as const, workspace: managedProject } : undefined, [managedProject, managedProjectMode]);
    const currentChoice = currentEdit ? currentEdit.value : matchingHydrated?.projectFiles;
    const projectFilesOverride = inPlace ? undefined : currentChoice
        ?? (managedProjectMode === 'copy' ? MANAGED_PROJECT_COPY_DEFAULT : undefined);
    const onProjectFilesChange = React.useCallback((value: SessionProjectFilesV1 | undefined) => {
        setEdit({ key: placementKey, value, managedProjectMode });
    }, [managedProjectMode, placementKey]);
    const selectManagedProjectPlacement = React.useCallback((mode: ManagedProjectPlacementMode) => {
        if (mode === managedProjectMode) return;
        setEdit({ key: placementKey, value: undefined, managedProjectMode: mode });
    }, [managedProjectMode, placementKey]);
    const managedProjectPlacement = React.useMemo(() => managedProject && managedProjectMode ? {
        workspace: managedProject, selected: managedProjectMode, select: selectManagedProjectPlacement,
    } : undefined, [managedProject, managedProjectMode, selectManagedProjectPlacement]);
    const sessionPlacement = React.useMemo(() => {
        if (!placement || inPlace) return undefined;
        const source = managedProject ? { kind: 'managed' as const, workspace: managedProject }
            : input.projectFilesSource ?? (placement.kind === 'machine' ? undefined : matchingHydrated?.projectFilesSource);
        if (!matchingHydrated && !source && projectFilesOverride === undefined) return undefined;
        const { projectFiles: _previousChoice, projectFilesSource: _previousSource, ...base } = matchingHydrated ?? placement;
        return {
            ...base,
            ...(source ? { projectFilesSource: source } : {}),
            ...(projectFilesOverride ? { projectFiles: projectFilesOverride } : {}),
        };
    }, [inPlace, input.projectFilesSource, managedProject, matchingHydrated, placement, projectFilesOverride]);
    const projectFilesOutcome = React.useMemo<NewSessionProjectFilesOutcome>(() => ({
        placementKind: inPlace?.kind ?? placement?.kind ?? null,
        ...(sessionPlacement?.projectFilesSource ? { source: sessionPlacement.projectFilesSource } : {}),
        ...(projectFilesOverride === undefined ? { origin: 'default' as const }
            : { origin: 'override' as const, choice: projectFilesOverride }),
    }), [inPlace?.kind, placement?.kind, projectFilesOverride, sessionPlacement?.projectFilesSource]);
    return {
        sessionPlacement: inPlace ?? sessionPlacement, projectFilesOverride, projectFilesOutcome, onProjectFilesChange,
        managedProjectPlacement,
    };
}
