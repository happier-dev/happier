export type ToolViewDetailLevel = 'title' | 'summary' | 'full';

export function resolveToolViewDetailLevel(params: {
    toolName: string;
    toolInput: unknown;
    detailLevelDefault: ToolViewDetailLevel;
    detailLevelDefaultLocalControl: ToolViewDetailLevel;
    detailLevelByToolName: Record<string, ToolViewDetailLevel> | null | undefined;
}): ToolViewDetailLevel {
    const override = params.detailLevelByToolName?.[params.toolName];
    if (override === 'title' || override === 'summary' || override === 'full') {
        return override;
    }

    const sessionMode = (params.toolInput as any)?._happy?.sessionMode;
    if (sessionMode === 'local_control') {
        return params.detailLevelDefaultLocalControl;
    }

    return params.detailLevelDefault;
}

