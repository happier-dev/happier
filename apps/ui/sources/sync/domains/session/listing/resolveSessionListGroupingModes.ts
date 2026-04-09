export type SessionListGroupingMode = 'project' | 'date';

type SessionListGroupingModeParams = Readonly<{
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: SessionListGroupingMode;
    inactiveGroupingV1?: SessionListGroupingMode;
}>;

export function resolveSessionListGroupingModes(params: SessionListGroupingModeParams): Readonly<{
    activeGrouping: SessionListGroupingMode;
    inactiveGrouping: SessionListGroupingMode;
}> {
    return {
        activeGrouping: params.activeGroupingV1 ?? 'project',
        inactiveGrouping: params.inactiveGroupingV1 ?? (params.groupInactiveSessionsByProject ? 'project' : 'date'),
    };
}

export function usesProjectGroupingInSessionList(params: SessionListGroupingModeParams): boolean {
    const groupingModes = resolveSessionListGroupingModes(params);
    return groupingModes.activeGrouping === 'project' || groupingModes.inactiveGrouping === 'project';
}
