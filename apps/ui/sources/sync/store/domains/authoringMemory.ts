import {
    LastUsedProfileSchema,
    RecentMachinePathsSchema,
    RememberedEngineSelectionsByScopeV1Schema as RetainedRememberedEngineSelectionsByScopeV1Schema,
    type RememberedEngineSelectionsByScopeV1 as RetainedRememberedEngineSelectionsByScopeV1,
} from '@happier-dev/protocol/account/authoringMemory';
import {
    RememberedEngineSelectionsByScopeV1Schema,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { StoreGet, StoreSet } from './_shared';
import { WorkflowProjectTargetsByDefinitionIdV1Schema, type WorkflowProjectTargetsByDefinitionIdV1 } from '@happier-dev/protocol/account/authoringMemory';

export type AuthoringMemoryValues = Readonly<{
    recentMachinePaths: Array<{ machineId: string; path: string }>;
    lastUsedProfile: string | null;
    lastEngineSelectionsByScopeV1: RetainedRememberedEngineSelectionsByScopeV1;
    workflowProjectTargetsByDefinitionId?: WorkflowProjectTargetsByDefinitionIdV1;
}>;
export type AuthoringMemory = AuthoringMemoryValues & Readonly<{
    currentRememberedEngineSelectionsByScopeV1: RememberedEngineSelectionsByScopeV1;
    workflowProjectTargetsByDefinitionId: WorkflowProjectTargetsByDefinitionIdV1;
}>;
export type AuthoringMemoryDomain = {
    authoringMemory: AuthoringMemory;
    applyAuthoringMemory: (delta: Partial<AuthoringMemoryValues>) => void;
    resetAuthoringMemory: () => void;
};

export function projectAuthoringMemory(values: AuthoringMemoryValues): AuthoringMemory {
    return {
        ...values,
        workflowProjectTargetsByDefinitionId: values.workflowProjectTargetsByDefinitionId ?? {},
        currentRememberedEngineSelectionsByScopeV1: RememberedEngineSelectionsByScopeV1Schema.parse(values.lastEngineSelectionsByScopeV1),
    };
}

export const authoringMemoryDefaults: AuthoringMemory = projectAuthoringMemory({
    recentMachinePaths: [], lastUsedProfile: null, lastEngineSelectionsByScopeV1: {},
});

/** Materializes the reserved rows only; the sync owner controls Account/Home lifetime and CAS. */
export function createAuthoringMemoryDomain<S extends AuthoringMemoryDomain>(deps: { set: StoreSet<S>; get: StoreGet<S> }): AuthoringMemoryDomain {
    return {
        authoringMemory: authoringMemoryDefaults,
        applyAuthoringMemory: (delta) => deps.set((state) => {
            const previous = state.authoringMemory;
            const recentMachinePaths = delta.recentMachinePaths === undefined
                ? previous.recentMachinePaths : RecentMachinePathsSchema.parse(delta.recentMachinePaths);
            const lastUsedProfile = delta.lastUsedProfile === undefined
                ? previous.lastUsedProfile : LastUsedProfileSchema.parse(delta.lastUsedProfile);
            const lastEngineSelectionsByScopeV1 = delta.lastEngineSelectionsByScopeV1 === undefined
                ? previous.lastEngineSelectionsByScopeV1 : RetainedRememberedEngineSelectionsByScopeV1Schema.parse(delta.lastEngineSelectionsByScopeV1);
            const pathsUnchanged = areAccountSettingsJsonValuesEqual(previous.recentMachinePaths, recentMachinePaths);
            const selectionsUnchanged = areAccountSettingsJsonValuesEqual(previous.lastEngineSelectionsByScopeV1, lastEngineSelectionsByScopeV1);
            const workflowProjects = delta.workflowProjectTargetsByDefinitionId === undefined ? previous.workflowProjectTargetsByDefinitionId
                : WorkflowProjectTargetsByDefinitionIdV1Schema.parse(delta.workflowProjectTargetsByDefinitionId);
            const projectsUnchanged = areAccountSettingsJsonValuesEqual(previous.workflowProjectTargetsByDefinitionId, workflowProjects);
            const reconciledProjects = projectsUnchanged ? previous.workflowProjectTargetsByDefinitionId
                : Object.fromEntries(Object.entries(workflowProjects).map(([id, target]) => [id,
                    areAccountSettingsJsonValuesEqual(previous.workflowProjectTargetsByDefinitionId[id], target)
                        ? previous.workflowProjectTargetsByDefinitionId[id]! : target] as const));
            if (pathsUnchanged && selectionsUnchanged && projectsUnchanged && previous.lastUsedProfile === lastUsedProfile) return state;
            const currentSelections = selectionsUnchanged
                ? previous.currentRememberedEngineSelectionsByScopeV1
                : RememberedEngineSelectionsByScopeV1Schema.parse(lastEngineSelectionsByScopeV1);
            return {
                ...state,
                authoringMemory: {
                    recentMachinePaths: pathsUnchanged ? previous.recentMachinePaths : recentMachinePaths.map(path =>
                        previous.recentMachinePaths.find(known => known.machineId === path.machineId && known.path === path.path) ?? path),
                    lastUsedProfile,
                    workflowProjectTargetsByDefinitionId: reconciledProjects,
                    lastEngineSelectionsByScopeV1: selectionsUnchanged ? previous.lastEngineSelectionsByScopeV1
                        : Object.fromEntries(Object.entries(lastEngineSelectionsByScopeV1).map(([scope, value]) => [scope,
                            areAccountSettingsJsonValuesEqual(previous.lastEngineSelectionsByScopeV1[scope], value)
                                ? previous.lastEngineSelectionsByScopeV1[scope]! : value])),
                    currentRememberedEngineSelectionsByScopeV1: areAccountSettingsJsonValuesEqual(previous.currentRememberedEngineSelectionsByScopeV1, currentSelections)
                        ? previous.currentRememberedEngineSelectionsByScopeV1
                        : Object.fromEntries(Object.entries(currentSelections).map(([scope, value]) => [scope,
                            areAccountSettingsJsonValuesEqual(previous.currentRememberedEngineSelectionsByScopeV1[scope], value)
                                ? previous.currentRememberedEngineSelectionsByScopeV1[scope]! : value])),
                },
            };
        }),
        resetAuthoringMemory: () => deps.set((state) => areAccountSettingsJsonValuesEqual(state.authoringMemory, authoringMemoryDefaults)
            ? state : { ...state, authoringMemory: authoringMemoryDefaults }),
    };
}
