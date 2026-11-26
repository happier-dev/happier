import type { ToolViewDetailLevel } from './resolveToolViewDetailLevel';

export type ToolTimelineChromeMode = 'cards' | 'activity_feed';

export type ToolViewDetailLevelSetting = ToolViewDetailLevel | 'default';
export type ToolViewExpandedDetailLevel = 'summary' | 'full';
export type ToolViewExpandedDetailLevelSetting = ToolViewExpandedDetailLevel | 'default';

/**
 * Tools whose body is itself a progressive disclosure: closed they read as one line, opened they read as
 * their summary (which keeps its own disclosures), in every chrome. The details page still opens `full`.
 * Applies only while the person's global setting is `default`; per-tool overrides are read by the caller first.
 */
const TOOL_DETAIL_DEFAULTS: Readonly<Record<string, Readonly<{ collapsed: ToolViewDetailLevel; expanded: ToolViewExpandedDetailLevel }>>> = {
    Script: { collapsed: 'compact', expanded: 'summary' },
};

export function resolveToolViewDetailLevelDefaultForChromeMode(params: {
    chromeMode: ToolTimelineChromeMode;
    setting: ToolViewDetailLevelSetting;
    toolName?: string;
}): ToolViewDetailLevel {
    if (params.setting === 'default') {
        const toolDefaults = params.toolName ? TOOL_DETAIL_DEFAULTS[params.toolName] : undefined;
        if (toolDefaults) return toolDefaults.collapsed;
        return params.chromeMode === 'activity_feed' ? 'compact' : 'summary';
    }
    return params.setting;
}

export function resolveToolViewExpandedDetailLevelDefaultForChromeMode(params: {
    chromeMode: ToolTimelineChromeMode;
    setting: ToolViewExpandedDetailLevelSetting;
    toolName?: string;
}): ToolViewExpandedDetailLevel {
    if (params.setting === 'default') {
        const toolDefaults = params.toolName ? TOOL_DETAIL_DEFAULTS[params.toolName] : undefined;
        if (toolDefaults) return toolDefaults.expanded;
        return params.chromeMode === 'activity_feed' ? 'summary' : 'full';
    }
    return params.setting;
}
