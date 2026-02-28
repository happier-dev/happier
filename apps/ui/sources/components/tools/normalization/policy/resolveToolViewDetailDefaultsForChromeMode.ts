import type { ToolViewDetailLevel } from './resolveToolViewDetailLevel';

export type ToolTimelineChromeMode = 'cards' | 'activity_feed';

export type ToolViewDetailLevelSetting = ToolViewDetailLevel | 'default';
export type ToolViewExpandedDetailLevel = 'summary' | 'full';
export type ToolViewExpandedDetailLevelSetting = ToolViewExpandedDetailLevel | 'default';

export function resolveToolViewDetailLevelDefaultForChromeMode(params: {
    chromeMode: ToolTimelineChromeMode;
    setting: ToolViewDetailLevelSetting;
}): ToolViewDetailLevel {
    if (params.setting === 'default') {
        return params.chromeMode === 'activity_feed' ? 'compact' : 'summary';
    }
    return params.setting;
}

export function resolveToolViewExpandedDetailLevelDefaultForChromeMode(params: {
    chromeMode: ToolTimelineChromeMode;
    setting: ToolViewExpandedDetailLevelSetting;
}): ToolViewExpandedDetailLevel {
    if (params.setting === 'default') {
        return params.chromeMode === 'activity_feed' ? 'summary' : 'full';
    }
    return params.setting;
}
