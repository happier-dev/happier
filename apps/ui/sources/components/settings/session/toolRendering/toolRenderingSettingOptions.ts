import type {
    ToolViewDetailLevelSetting,
    ToolViewExpandedDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';

export type ToolViewDetailLevel = 'title' | 'compact' | 'summary' | 'full';

export const TOOL_DETAIL_LEVEL_OPTIONS = [
    {
        key: 'title',
        titleKey: 'settingsSession.toolDetailLevel.titleOnlyTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.titleOnlySubtitle',
    },
    {
        key: 'compact',
        titleKey: 'settingsSession.toolDetailLevel.compactTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.compactSubtitle',
    },
    {
        key: 'summary',
        titleKey: 'settingsSession.toolDetailLevel.summaryTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.summarySubtitle',
    },
    {
        key: 'full',
        titleKey: 'settingsSession.toolDetailLevel.fullTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.fullSubtitle',
    },
] as const satisfies ReadonlyArray<{
    key: ToolViewDetailLevel;
    titleKey:
        | 'settingsSession.toolDetailLevel.titleOnlyTitle'
        | 'settingsSession.toolDetailLevel.compactTitle'
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.compactSubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

export const TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS = [
    {
        key: 'default',
        titleKey: 'settingsSession.toolDetailLevel.defaultTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.defaultSubtitle',
    },
    ...TOOL_DETAIL_LEVEL_OPTIONS,
] as const satisfies ReadonlyArray<{
    key: ToolViewDetailLevel | 'default';
    titleKey:
        | 'settingsSession.toolDetailLevel.defaultTitle'
        | 'settingsSession.toolDetailLevel.titleOnlyTitle'
        | 'settingsSession.toolDetailLevel.compactTitle'
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.defaultSubtitle'
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.compactSubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

export const TOOL_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS = [
    {
        key: 'default',
        titleKey: 'settingsSession.toolDetailLevel.styleDefaultTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.styleDefaultSubtitle',
    },
    ...TOOL_DETAIL_LEVEL_OPTIONS,
] as const satisfies ReadonlyArray<{
    key: ToolViewDetailLevelSetting;
    titleKey:
        | 'settingsSession.toolDetailLevel.styleDefaultTitle'
        | 'settingsSession.toolDetailLevel.titleOnlyTitle'
        | 'settingsSession.toolDetailLevel.compactTitle'
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.styleDefaultSubtitle'
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.compactSubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

export const TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS = [
    {
        key: 'default',
        titleKey: 'settingsSession.toolDetailLevel.expandedStyleDefaultTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.expandedStyleDefaultSubtitle',
    },
    {
        key: 'summary',
        titleKey: 'settingsSession.toolDetailLevel.summaryTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.summarySubtitle',
    },
    {
        key: 'full',
        titleKey: 'settingsSession.toolDetailLevel.fullTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.fullSubtitle',
    },
] as const satisfies ReadonlyArray<{
    key: ToolViewExpandedDetailLevelSetting;
    titleKey:
        | 'settingsSession.toolDetailLevel.expandedStyleDefaultTitle'
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.expandedStyleDefaultSubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;
