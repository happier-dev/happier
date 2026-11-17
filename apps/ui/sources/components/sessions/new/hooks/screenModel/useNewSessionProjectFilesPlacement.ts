import * as React from 'react';
import type { SessionPlacementSelectionV1, SessionProjectFilesSourceV1, SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';

export type NewSessionProjectFilesOutcome = Readonly<{
    placementKind: SessionPlacementSelectionV1['kind'] | null;
    source?: SessionProjectFilesSourceV1;
}> & (Readonly<{ origin: 'default' }> | Readonly<{ origin: 'override'; choice: SessionProjectFilesV1 }>);

export type NewSessionProjectFilesFieldKey = 'folder' | 'included' | 'repository' | 'branch' | 'gitAccount' | 'conflict';
const COPY_FIELDS = ['folder', 'included'] as const satisfies readonly NewSessionProjectFilesFieldKey[];
const CLONE_FIELDS = ['repository', 'branch', 'gitAccount'] as const satisfies readonly NewSessionProjectFilesFieldKey[];
const TWO_WAY_FIELDS = ['folder', 'conflict', 'included'] as const satisfies readonly NewSessionProjectFilesFieldKey[];

/** Project files is part of the current placement, never an independent preference. */
export function useNewSessionProjectFilesPlacement(input: Readonly<{
    draftKey: string;
    executionTarget: SessionAuthoringDraft['executionTarget'];
    managedMachineSelection: Pick<ManagedMachineSelectionDraft, 'selection'> | null;
    hydratedPlacement?: SessionPlacementSelectionV1;
    projectFilesSource?: SessionProjectFilesSourceV1;
}>): Readonly<{
    sessionPlacement: SessionPlacementSelectionV1 | undefined;
    projectFilesOverride: SessionProjectFilesV1 | undefined;
    projectFilesOutcome: NewSessionProjectFilesOutcome;
    projectFilesFieldKeys: readonly NewSessionProjectFilesFieldKey[] | undefined;
    /** The existing Editable-copy mode owns conflict review; this is not an authored policy. */
    projectFilesConflictMode: Extract<SessionProjectFilesV1, { kind: 'sync' }>['mode'] | undefined;
    onProjectFilesChange: (value: SessionProjectFilesV1 | undefined) => void;
}> {
    const selectedPreset = input.managedMachineSelection?.selection.kind === 'preset'
        ? input.managedMachineSelection.selection : null;
    const machine = input.executionTarget?.kind === 'machine' ? input.executionTarget.target : null;
    const placement = React.useMemo<SessionPlacementSelectionV1 | undefined>(() => selectedPreset
        ? { kind: 'preset', homeId: selectedPreset.homeId, presetId: selectedPreset.id }
        : input.managedMachineSelection ? { kind: 'managed' }
            : machine ? { kind: 'machine', target: machine } : undefined,
    [input.managedMachineSelection, machine, selectedPreset]);
    const placementKey = placement?.kind === 'preset'
        ? JSON.stringify([input.draftKey, placement.kind, placement.homeId, placement.presetId])
        : placement?.kind === 'machine' ? JSON.stringify([input.draftKey, placement.kind, placement.target.serverId, placement.target.machineId])
            : placement ? JSON.stringify([input.draftKey, placement.kind]) : null;
    const hydrated = input.hydratedPlacement;
    const matchingHydrated = placement?.kind === 'preset' && hydrated?.kind === 'preset'
        ? placement.homeId === hydrated.homeId && placement.presetId === hydrated.presetId ? hydrated : undefined
        : placement?.kind === 'machine' && hydrated?.kind === 'machine'
            && placement.target.serverId === hydrated.target.serverId && placement.target.machineId === hydrated.target.machineId
            ? hydrated : placement?.kind === 'managed' && hydrated?.kind === 'managed' ? hydrated : undefined;
    const [edit, setEdit] = React.useState<Readonly<{ key: string | null; value: SessionProjectFilesV1 | undefined }> | null>(null);
    const projectFilesOverride = edit?.key === placementKey ? edit.value : matchingHydrated?.projectFiles;
    const onProjectFilesChange = React.useCallback((value: SessionProjectFilesV1 | undefined) => {
        setEdit({ key: placementKey, value });
    }, [placementKey]);
    const sessionPlacement = React.useMemo(() => {
        if (!placement) return undefined;
        const source = input.projectFilesSource ?? (placement.kind === 'machine' ? undefined : matchingHydrated?.projectFilesSource);
        const base = { ...(matchingHydrated ?? placement), ...(source ? { projectFilesSource: source } : {}) };
        if (projectFilesOverride === undefined) {
            if (!matchingHydrated && !source) return undefined;
            const { projectFiles: _previous, ...rest } = base;
            return rest;
        }
        return { ...base, projectFiles: projectFilesOverride };
    }, [input.projectFilesSource, matchingHydrated, placement, projectFilesOverride]);
    const projectFilesOutcome = React.useMemo<NewSessionProjectFilesOutcome>(() => ({
        placementKind: placement?.kind ?? null,
        ...(sessionPlacement?.projectFilesSource ? { source: sessionPlacement.projectFilesSource } : {}),
        ...(projectFilesOverride === undefined ? { origin: 'default' as const }
            : { origin: 'override' as const, choice: projectFilesOverride }),
    }), [placement?.kind, projectFilesOverride, sessionPlacement?.projectFilesSource]);
    const projectFilesConflictMode = projectFilesOverride?.kind === 'sync' && projectFilesOverride.mode === 'keep_both_in_sync'
        ? projectFilesOverride.mode : undefined;
    const projectFilesFieldKeys = projectFilesOverride === undefined ? undefined
        : projectFilesOverride.kind === 'git_clone' ? CLONE_FIELDS : projectFilesConflictMode ? TWO_WAY_FIELDS : COPY_FIELDS;
    return { sessionPlacement, projectFilesOverride, projectFilesOutcome, projectFilesFieldKeys, projectFilesConflictMode, onProjectFilesChange };
}
