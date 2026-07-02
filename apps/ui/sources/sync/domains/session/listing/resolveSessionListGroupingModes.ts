export type SessionListGroupingMode = 'project' | 'date';
export type SessionListSectionMode = 'activity' | 'single';

type SessionListGroupingModeParams = Readonly<{
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: SessionListGroupingMode;
    inactiveGroupingV1?: SessionListGroupingMode;
    sectionModeV1?: SessionListSectionMode;
}>;

export function resolveSessionListGroupingModes(params: SessionListGroupingModeParams): Readonly<{
    activeGrouping: SessionListGroupingMode;
    inactiveGrouping: SessionListGroupingMode;
    sectionMode: SessionListSectionMode;
}> {
    return {
        activeGrouping: params.activeGroupingV1 ?? 'project',
        inactiveGrouping: params.inactiveGroupingV1 ?? (params.groupInactiveSessionsByProject ? 'project' : 'date'),
        sectionMode: params.sectionModeV1 === 'single' ? 'single' : 'activity',
    };
}

export function usesProjectGroupingInSessionList(params: SessionListGroupingModeParams): boolean {
    const groupingModes = resolveSessionListGroupingModes(params);
    if (groupingModes.sectionMode === 'single') {
        return groupingModes.activeGrouping === 'project';
    }
    return groupingModes.activeGrouping === 'project' || groupingModes.inactiveGrouping === 'project';
}
