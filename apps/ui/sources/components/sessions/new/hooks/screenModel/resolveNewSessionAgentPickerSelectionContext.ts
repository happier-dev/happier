import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

type ResolveNewSessionAgentPickerSelectionContextParams = Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
}>;

export type NewSessionAgentPickerSelectionContext = Readonly<{
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
    selectableBackendEntries: readonly ResolvedBackendCatalogEntry[];
}>;

export function resolveNewSessionAgentPickerSelectionContext(
    params: ResolveNewSessionAgentPickerSelectionContextParams,
): NewSessionAgentPickerSelectionContext {
    const profileForAgentSelection = !params.useProfiles || params.selectedProfileId === null
        ? null
        : params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId);

    const compatibleBackendEntries = profileForAgentSelection
        ? params.getCompatibleProfileBackendEntries(profileForAgentSelection)
        : params.resolvedBackendEntries;

    const compatibleBackendTargetKeys = new Set(compatibleBackendEntries.map((entry) => entry.backendTargetKey));

    const selectableBackendEntries = params.resolvedBackendEntries.filter((entry) => (
        params.isBackendEntrySelectable(entry)
        && (
            !profileForAgentSelection
            || compatibleBackendTargetKeys.has(entry.backendTargetKey)
        )
    ));

    return {
        profileForAgentSelection,
        compatibleBackendTargetKeys,
        selectableBackendEntries,
    };
}
