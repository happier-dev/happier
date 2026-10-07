import {
    LegacyLastUsedProfileSchema,
    LegacyRecentMachinePathsSchema,
    LegacyRememberedEngineSelectionsByScopeV1Schema,
    type RetainedRememberedEngineSelectionsByScopeV1,
} from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import {
    RememberedEngineSelectionsByScopeV1Schema,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import type { StoreGet, StoreSet } from './_shared';

export type AuthoringMemoryValues = Readonly<{
    recentMachinePaths: Array<{ machineId: string; path: string }>;
    lastUsedProfile: string | null;
    lastEngineSelectionsByScopeV1: RetainedRememberedEngineSelectionsByScopeV1;
}>;
export type AuthoringMemory = AuthoringMemoryValues & Readonly<{
    currentRememberedEngineSelectionsByScopeV1: RememberedEngineSelectionsByScopeV1;
}>;
export type AuthoringMemoryDomain = {
    authoringMemory: AuthoringMemory;
    applyAuthoringMemory: (delta: Partial<AuthoringMemoryValues>) => void;
    resetAuthoringMemory: () => void;
};

export function projectAuthoringMemory(values: AuthoringMemoryValues): AuthoringMemory {
    return {
        ...values,
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
                ? previous.recentMachinePaths : LegacyRecentMachinePathsSchema.parse(delta.recentMachinePaths);
            const lastUsedProfile = delta.lastUsedProfile === undefined
                ? previous.lastUsedProfile : LegacyLastUsedProfileSchema.parse(delta.lastUsedProfile);
            const lastEngineSelectionsByScopeV1 = delta.lastEngineSelectionsByScopeV1 === undefined
                ? previous.lastEngineSelectionsByScopeV1 : LegacyRememberedEngineSelectionsByScopeV1Schema.parse(delta.lastEngineSelectionsByScopeV1);
            const pathsUnchanged = areAccountSettingsJsonValuesEqual(previous.recentMachinePaths, recentMachinePaths);
            const selectionsUnchanged = areAccountSettingsJsonValuesEqual(previous.lastEngineSelectionsByScopeV1, lastEngineSelectionsByScopeV1);
            if (pathsUnchanged && selectionsUnchanged && previous.lastUsedProfile === lastUsedProfile) return state;
            const currentSelections = selectionsUnchanged
                ? previous.currentRememberedEngineSelectionsByScopeV1
                : RememberedEngineSelectionsByScopeV1Schema.parse(lastEngineSelectionsByScopeV1);
            return {
                ...state,
                authoringMemory: {
                    recentMachinePaths: pathsUnchanged ? previous.recentMachinePaths : recentMachinePaths,
                    lastUsedProfile,
                    lastEngineSelectionsByScopeV1: selectionsUnchanged ? previous.lastEngineSelectionsByScopeV1 : lastEngineSelectionsByScopeV1,
                    currentRememberedEngineSelectionsByScopeV1: areAccountSettingsJsonValuesEqual(previous.currentRememberedEngineSelectionsByScopeV1, currentSelections)
                        ? previous.currentRememberedEngineSelectionsByScopeV1
                        : currentSelections,
                },
            };
        }),
        resetAuthoringMemory: () => deps.set((state) => state.authoringMemory === authoringMemoryDefaults
            ? state : { ...state, authoringMemory: authoringMemoryDefaults }),
    };
}
