import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    resolveToolViewExpandedDetailLevelDefaultForChromeMode,
    type ToolTimelineChromeMode,
    type ToolViewDetailLevelSetting,
    type ToolViewExpandedDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import {
    TOOL_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS,
    TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS,
} from '@/components/settings/session/toolRendering/toolRenderingSettingOptions';

type TranscriptGroupingMode = 'linear' | 'turns';
type TranscriptMotionPreset = 'off' | 'subtle' | 'full';
type ToolCallsGroupStrategy = 'consecutive_tools' | 'all_tools_in_turn';
type ToolTapAction = 'expand' | 'open';

function clampInt(value: number, bounds: Readonly<{ min: number; max: number }>): number {
    if (!Number.isFinite(value)) return bounds.min;
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

export const TranscriptSettingsView = React.memo(function TranscriptSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const popoverBoundaryRef = React.useRef<any>(null);

    const [transcriptGroupingMode, setTranscriptGroupingMode] = useSettingMutable('transcriptGroupingMode');
    const [transcriptGroupToolCalls, setTranscriptGroupToolCalls] = useSettingMutable('transcriptGroupToolCalls');
    const [transcriptTurnToolCallsGroupStrategy, setTranscriptTurnToolCallsGroupStrategy] = useSettingMutable('transcriptTurnToolCallsGroupStrategy');
    const [transcriptToolCallsCollapsedPreviewCount, setTranscriptToolCallsCollapsedPreviewCount] = useSettingMutable('transcriptToolCallsCollapsedPreviewCount');
    const [transcriptToolCallsGroupShowBackground, setTranscriptToolCallsGroupShowBackground] = useSettingMutable('transcriptToolCallsGroupShowBackground');

    const [sessionThinkingDisplayMode, setSessionThinkingDisplayMode] = useSettingMutable('sessionThinkingDisplayMode');
    const [sessionThinkingInlinePresentation, setSessionThinkingInlinePresentation] = useSettingMutable('sessionThinkingInlinePresentation');
    const [sessionThinkingInlineChrome, setSessionThinkingInlineChrome] = useSettingMutable('sessionThinkingInlineChrome');

    const [toolViewTimelineChromeMode, setToolViewTimelineChromeMode] = useSettingMutable('toolViewTimelineChromeMode');
    const [toolViewDetailLevelDefault, setToolViewDetailLevelDefault] = useSettingMutable('toolViewDetailLevelDefault');
    const [toolViewExpandedDetailLevelDefault, setToolViewExpandedDetailLevelDefault] = useSettingMutable('toolViewExpandedDetailLevelDefault');
    const [toolViewTapAction, setToolViewTapAction] = useSettingMutable('toolViewTapAction');
    const [toolViewShowDebugByDefault, setToolViewShowDebugByDefault] = useSettingMutable('toolViewShowDebugByDefault');

    const [toolViewTimelineFeedDefaultExpanded, setToolViewTimelineFeedDefaultExpanded] = useSettingMutable('toolViewTimelineFeedDefaultExpanded');

    const [transcriptMotionPreset, setTranscriptMotionPreset] = useSettingMutable('transcriptMotionPreset');

    const [transcriptScrollPinEnabled, setTranscriptScrollPinEnabled] = useSettingMutable('transcriptScrollPinEnabled');
    const [transcriptScrollJumpToBottomEnabled, setTranscriptScrollJumpToBottomEnabled] = useSettingMutable('transcriptScrollJumpToBottomEnabled');

    const [openGroupingMenu, setOpenGroupingMenu] = React.useState(false);
    const [openThinkingDisplayMenu, setOpenThinkingDisplayMenu] = React.useState(false);
    const [openToolChromeMenu, setOpenToolChromeMenu] = React.useState(false);
    const [openToolDetailMenu, setOpenToolDetailMenu] = React.useState<null | string>(null);
    const [openMotionMenu, setOpenMotionMenu] = React.useState(false);

    const normalizedGroupingMode: TranscriptGroupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const normalizedMotionPreset: TranscriptMotionPreset =
        transcriptMotionPreset === 'off' || transcriptMotionPreset === 'full' ? transcriptMotionPreset : 'subtle';

    const normalizedToolChromeMode: ToolTimelineChromeMode =
        toolViewTimelineChromeMode === 'activity_feed' ? 'activity_feed' : 'cards';

    const normalizedToolViewDetailLevelDefaultSetting: ToolViewDetailLevelSetting =
        toolViewDetailLevelDefault === 'default' ||
        toolViewDetailLevelDefault === 'title' ||
        toolViewDetailLevelDefault === 'compact' ||
        toolViewDetailLevelDefault === 'summary' ||
        toolViewDetailLevelDefault === 'full'
            ? toolViewDetailLevelDefault
            : 'default';

    const normalizedToolViewExpandedDetailLevelDefaultSetting: ToolViewExpandedDetailLevelSetting =
        toolViewExpandedDetailLevelDefault === 'default' ||
        toolViewExpandedDetailLevelDefault === 'summary' ||
        toolViewExpandedDetailLevelDefault === 'full'
            ? toolViewExpandedDetailLevelDefault
            : 'default';

    const resolvedDetailLevelDefaultLabel = resolveToolViewDetailLevelDefaultForChromeMode({
        chromeMode: normalizedToolChromeMode,
        setting: normalizedToolViewDetailLevelDefaultSetting,
    });
    const resolvedExpandedDetailLevelDefaultLabel = resolveToolViewExpandedDetailLevelDefaultForChromeMode({
        chromeMode: normalizedToolChromeMode,
        setting: normalizedToolViewExpandedDetailLevelDefaultSetting,
    });

    const normalizedStrategy: ToolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const groupingOptions: Array<{ key: TranscriptGroupingMode; title: string; subtitle: string }> = [
        {
            key: 'linear',
            title: t('settingsSession.transcript.layout.linearTitle'),
            subtitle: t('settingsSession.transcript.layout.linearSubtitle'),
        },
        {
            key: 'turns',
            title: t('settingsSession.transcript.layout.turnsTitle'),
            subtitle: t('settingsSession.transcript.layout.turnsSubtitle'),
        },
    ];

    const strategyOptions: Array<{ key: ToolCallsGroupStrategy; title: string; subtitle: string }> = [
        {
            key: 'consecutive_tools',
            title: t('settingsSession.transcript.advanced.toolCallsStrategy.consecutiveTitle'),
            subtitle: t('settingsSession.transcript.advanced.toolCallsStrategy.consecutiveSubtitle'),
        },
        {
            key: 'all_tools_in_turn',
            title: t('settingsSession.transcript.advanced.toolCallsStrategy.allToolsTitle'),
            subtitle: t('settingsSession.transcript.advanced.toolCallsStrategy.allToolsSubtitle'),
        },
    ];

    const normalizedCollapsedPreviewCount = clampInt(
        typeof transcriptToolCallsCollapsedPreviewCount === 'number'
            ? transcriptToolCallsCollapsedPreviewCount
            : 5,
        { min: 0, max: 15 },
    );

    const collapsedPreviewOptions: Array<{ key: number; title: string; subtitle: string }> = [
        {
            key: 0,
            title: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.offTitle'),
            subtitle: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.offSubtitle'),
        },
        ...Array.from({ length: 15 }, (_, i) => i + 1).map((count) => {
            if (count === 1) {
                return {
                    key: 1,
                    title: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.oneTitle'),
                    subtitle: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.oneSubtitle'),
                };
            }
            if (count === 2) {
                return {
                    key: 2,
                    title: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.twoTitle'),
                    subtitle: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.twoSubtitle'),
                };
            }
            if (count === 3) {
                return {
                    key: 3,
                    title: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.threeTitle'),
                    subtitle: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.threeSubtitle'),
                };
            }
            return {
                key: count,
                title: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.countTitle', { value: String(count) }),
                subtitle: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCount.countSubtitle', { value: String(count) }),
            };
        }),
    ];

    const motionOptions: Array<{ key: TranscriptMotionPreset; title: string; subtitle: string }> = [
        {
            key: 'off',
            title: t('settingsSession.transcript.motion.offTitle'),
            subtitle: t('settingsSession.transcript.motion.offSubtitle'),
        },
        {
            key: 'subtle',
            title: t('settingsSession.transcript.motion.subtleTitle'),
            subtitle: t('settingsSession.transcript.motion.subtleSubtitle'),
        },
        {
            key: 'full',
            title: t('settingsSession.transcript.motion.fullTitle'),
            subtitle: t('settingsSession.transcript.motion.fullSubtitle'),
        },
    ];

    const chromeModeOptions: Array<{ key: ToolTimelineChromeMode; title: string; subtitle: string }> = [
        {
            key: 'cards',
            title: t('settingsSession.toolRendering.timelineChrome.cardsTitle'),
            subtitle: t('settingsSession.toolRendering.timelineChrome.cardsSubtitle'),
        },
        {
            key: 'activity_feed',
            title: t('settingsSession.toolRendering.timelineChrome.activityFeedTitle'),
            subtitle: t('settingsSession.toolRendering.timelineChrome.activityFeedSubtitle'),
        },
    ];

    const tapActionOptions: Array<{ key: ToolTapAction; title: string; subtitle: string }> = [
        {
            key: 'expand',
            title: t('settingsSession.toolRendering.activityFeed.tapAction.expandTitle'),
            subtitle: t('settingsSession.toolRendering.activityFeed.tapAction.expandSubtitle'),
        },
        {
            key: 'open',
            title: t('settingsSession.toolRendering.activityFeed.tapAction.openTitle'),
            subtitle: t('settingsSession.toolRendering.activityFeed.tapAction.openSubtitle'),
        },
    ];

    const normalizedToolTapAction: ToolTapAction = toolViewTapAction === 'open' ? 'open' : 'expand';

    const advancedRoute = '/(app)/settings/session/transcript/advanced';
    const toolOverridesRoute = '/(app)/settings/session/tool-rendering';

    type ThinkingOptionId = 'inline_summary' | 'inline_full' | 'tool' | 'hidden';
    const normalizedThinkingSelectedId: ThinkingOptionId =
        sessionThinkingDisplayMode === 'tool'
            ? 'tool'
            : sessionThinkingDisplayMode === 'hidden'
                ? 'hidden'
                : sessionThinkingInlinePresentation === 'full'
                    ? 'inline_full'
                    : 'inline_summary';

    const thinkingDisplayOptions: Array<{ id: ThinkingOptionId; title: string; subtitle: string }> = [
        {
            id: 'inline_summary',
            title: t('settingsSession.thinking.displayMode.inlineSummaryTitle'),
            subtitle: t('settingsSession.thinking.displayMode.inlineSummarySubtitle'),
        },
        {
            id: 'inline_full',
            title: t('settingsSession.thinking.displayMode.inlineTitle'),
            subtitle: t('settingsSession.thinking.displayMode.inlineSubtitle'),
        },
        {
            id: 'tool',
            title: t('settingsSession.thinking.displayMode.toolTitle'),
            subtitle: t('settingsSession.thinking.displayMode.toolSubtitle'),
        },
        {
            id: 'hidden',
            title: t('settingsSession.thinking.displayMode.hiddenTitle'),
            subtitle: t('settingsSession.thinking.displayMode.hiddenSubtitle'),
        },
    ];

    const tToolDetail = t as (key: any) => string;

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.transcript.layoutTitle')} footer={t('settingsSession.transcript.layoutFooter')}>
                <DropdownMenu
                    open={openGroupingMenu}
                    onOpenChange={setOpenGroupingMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedGroupingMode as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.transcript.layoutPickerTitle'),
                        icon: <Ionicons name="chatbubble-ellipses-outline" size={29} color={theme.colors.accent.blue} />,
                        itemProps: { testID: 'settings-session-transcript-layout-picker' },
                    }}
                    items={groupingOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setTranscriptGroupingMode(id as any);
                        setOpenGroupingMenu(false);
                    }}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.thinking.title')} footer={t('settingsSession.thinking.footer')}>
                <DropdownMenu
                    open={openThinkingDisplayMenu}
                    onOpenChange={setOpenThinkingDisplayMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedThinkingSelectedId as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.thinking.displayModeTitle'),
                        icon: <Ionicons name="bulb-outline" size={29} color={theme.colors.accent.blue} />,
                    }}
                    items={thinkingDisplayOptions.map((opt) => ({
                        id: opt.id,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="bulb-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        const opt = String(id) as ThinkingOptionId;
                        switch (opt) {
                            case 'inline_summary':
                                setSessionThinkingDisplayMode('inline' as any);
                                setSessionThinkingInlinePresentation('summary' as any);
                                break;
                            case 'inline_full':
                                setSessionThinkingDisplayMode('inline' as any);
                                setSessionThinkingInlinePresentation('full' as any);
                                break;
                            case 'tool':
                                setSessionThinkingDisplayMode('tool' as any);
                                break;
                            case 'hidden':
                                setSessionThinkingDisplayMode('hidden' as any);
                                break;
                        }
                        setOpenThinkingDisplayMenu(false);
                    }}
                />

                {sessionThinkingDisplayMode === 'inline' ? (
                    <Item
                        title={t('settingsSession.thinking.inlineChromeTitle')}
                        subtitle={t('settingsSession.thinking.inlineChromeSubtitle')}
                        icon={<Ionicons name="albums-outline" size={29} color={theme.colors.textSecondary} />}
                        testID="settings-session-thinking-inline-chrome"
                        rightElement={
                            <Switch
                                value={sessionThinkingInlineChrome !== 'plain'}
                                onValueChange={(v) => setSessionThinkingInlineChrome((v ? 'card' : 'plain') as any)}
                            />
                        }
                        showChevron={false}
                        onPress={() => setSessionThinkingInlineChrome(((sessionThinkingInlineChrome !== 'plain') ? 'plain' : 'card') as any)}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.toolRendering.title')} footer={t('settingsSession.toolRendering.footer')}>
                <DropdownMenu
                    open={openToolChromeMenu}
                    onOpenChange={setOpenToolChromeMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedToolChromeMode as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.toolRendering.timelineChrome.title'),
                        icon: <Ionicons name="construct-outline" size={29} color={theme.colors.accent.blue} />,
                    }}
                    items={chromeModeOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="construct-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setToolViewTimelineChromeMode(id as any);
                        setOpenToolChromeMenu(false);
                    }}
                />

                {normalizedToolChromeMode === 'activity_feed' ? (
                    <>
                        <Item
                            title={t('settingsSession.transcript.toolCallsGroupTitle')}
                            subtitle={t('settingsSession.transcript.toolCallsGroupSubtitle')}
                            icon={<Ionicons name="layers-outline" size={29} color={theme.colors.accent.indigo} />}
                            testID="settings-session-transcript-tool-calls-group"
                            rightElement={
                                <Switch
                                    value={transcriptGroupToolCalls === true}
                                    onValueChange={(v) => setTranscriptGroupToolCalls(Boolean(v) as any)}
                                />
                            }
                            showChevron={false}
                            onPress={() => setTranscriptGroupToolCalls((transcriptGroupToolCalls !== true) as any)}
                        />

                        {transcriptGroupToolCalls === true ? (
                            <>
                                {normalizedGroupingMode === 'turns' ? (
                                    <DropdownMenu
                                        open={openToolDetailMenu === 'transcriptTurnToolCallsGroupStrategy'}
                                        onOpenChange={(next) => setOpenToolDetailMenu(next ? 'transcriptTurnToolCallsGroupStrategy' : null)}
                                        variant="selectable"
                                        search={false}
                                        selectedId={normalizedStrategy as any}
                                        showCategoryTitles={false}
                                        matchTriggerWidth={true}
                                        connectToTrigger={true}
                                        rowKind="item"
                                        popoverBoundaryRef={popoverBoundaryRef}
                                        itemTrigger={{
                                            title: t('settingsSession.transcript.advanced.toolCallsStrategyTitle'),
                                            icon: <Ionicons name="git-branch-outline" size={29} color={theme.colors.textSecondary} />,
                                        }}
                                        items={strategyOptions.map((opt) => ({
                                            id: opt.key,
                                            title: opt.title,
                                            subtitle: opt.subtitle,
                                            icon: (
                                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                    <Ionicons name="git-branch-outline" size={22} color={theme.colors.textSecondary} />
                                                </View>
                                            ),
                                        }))}
                                        onSelect={(id) => {
                                            setTranscriptTurnToolCallsGroupStrategy(id as any);
                                            setOpenToolDetailMenu(null);
                                        }}
                                    />
                                ) : null}

                                <DropdownMenu
                                    open={openToolDetailMenu === 'transcriptToolCallsCollapsedPreviewCount'}
                                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'transcriptToolCallsCollapsedPreviewCount' : null)}
                                    variant="selectable"
                                    search={false}
                                    selectedId={String(normalizedCollapsedPreviewCount)}
                                    showCategoryTitles={false}
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    rowKind="item"
                                    popoverBoundaryRef={popoverBoundaryRef}
                                    itemTrigger={{
                                        title: t('settingsSession.transcript.advanced.toolCallsCollapsedPreviewCountTitle'),
                                        icon: <Ionicons name="eye-outline" size={29} color={theme.colors.textSecondary} />,
                                    }}
                                    items={collapsedPreviewOptions.map((opt) => ({
                                        id: String(opt.key),
                                        title: opt.title,
                                        subtitle: opt.subtitle,
                                        icon: (
                                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                                <Ionicons name="eye-outline" size={22} color={theme.colors.textSecondary} />
                                            </View>
                                        ),
                                    }))}
                                    onSelect={(id) => {
                                        const parsed = Number(id);
                                        if (!Number.isFinite(parsed)) return;
                                        setTranscriptToolCallsCollapsedPreviewCount(clampInt(parsed, { min: 0, max: 15 }) as any);
                                        setOpenToolDetailMenu(null);
                                    }}
                                />

                                <Item
                                    title={t('settingsSession.transcript.toolCallsGroupBackgroundTitle')}
                                    subtitle={t('settingsSession.transcript.toolCallsGroupBackgroundSubtitle')}
                                    icon={<Ionicons name="albums-outline" size={29} color={theme.colors.textSecondary} />}
                                    testID="settings-session-transcript-tool-calls-group-background"
                                    rightElement={
                                        <Switch
                                            value={transcriptToolCallsGroupShowBackground === true}
                                            onValueChange={(v) => setTranscriptToolCallsGroupShowBackground(Boolean(v) as any)}
                                        />
                                    }
                                    showChevron={false}
                                    onPress={() => setTranscriptToolCallsGroupShowBackground((transcriptToolCallsGroupShowBackground !== true) as any)}
                                />
                            </>
                        ) : null}
                    </>
                ) : null}

                <DropdownMenu
                    open={openToolDetailMenu === 'toolViewDetailLevelDefault'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewDetailLevelDefault' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedToolViewDetailLevelDefaultSetting as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.toolRendering.defaultToolDetailLevelTitle'),
                        icon: <Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />,
                        subtitle: (() => {
                            const key = TOOL_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.find((opt) => opt.key === normalizedToolViewDetailLevelDefaultSetting)?.titleKey;
                            return key ? tToolDetail(key) : String(resolvedDetailLevelDefaultLabel);
                        })(),
                    }}
                    items={TOOL_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.map((opt) => ({
                        id: opt.key,
                        title: tToolDetail(opt.titleKey),
                        subtitle: tToolDetail(opt.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="list-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setToolViewDetailLevelDefault(id as any);
                        setOpenToolDetailMenu(null);
                    }}
                />

                <DropdownMenu
                    open={openToolDetailMenu === 'toolViewExpandedDetailLevelDefault'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewExpandedDetailLevelDefault' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedToolViewExpandedDetailLevelDefaultSetting as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.toolRendering.expandedToolDetailLevelTitle'),
                        icon: <Ionicons name="expand-outline" size={29} color={theme.colors.textSecondary} />,
                        subtitle: (() => {
                            const key = TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.find((opt) => opt.key === normalizedToolViewExpandedDetailLevelDefaultSetting)?.titleKey;
                            return key ? tToolDetail(key as any) : String(resolvedExpandedDetailLevelDefaultLabel);
                        })(),
                    }}
                    items={TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.map((opt) => ({
                        id: opt.key,
                        title: tToolDetail(opt.titleKey),
                        subtitle: tToolDetail(opt.subtitleKey),
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="expand-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setToolViewExpandedDetailLevelDefault(id as any);
                        setOpenToolDetailMenu(null);
                    }}
                />

                <DropdownMenu
                    open={openToolDetailMenu === 'toolViewTapAction'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewTapAction' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedToolTapAction as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.toolRendering.cardTapActionTitle'),
                        icon: <Ionicons name="hand-left-outline" size={29} color={theme.colors.textSecondary} />,
                    }}
                    items={tapActionOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="hand-left-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setToolViewTapAction(id as any);
                        setOpenToolDetailMenu(null);
                    }}
                />

                {normalizedToolChromeMode === 'activity_feed' ? (
                    <>
                        <Item
                            title={t('settingsSession.toolRendering.activityFeed.defaultExpandedTitle')}
                            subtitle={t('settingsSession.toolRendering.activityFeed.defaultExpandedSubtitle')}
                            icon={<Ionicons name="chevron-down-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={
                                <Switch
                                    value={toolViewTimelineFeedDefaultExpanded === true}
                                    onValueChange={(v) => setToolViewTimelineFeedDefaultExpanded(Boolean(v) as any)}
                                />
                            }
                            showChevron={false}
                            onPress={() => setToolViewTimelineFeedDefaultExpanded((toolViewTimelineFeedDefaultExpanded !== true) as any)}
                        />
                    </>
                ) : null}

                <Item
                    title={t('settingsSession.toolRendering.showDebugByDefaultTitle')}
                    subtitle={t('settingsSession.toolRendering.showDebugByDefaultSubtitle')}
                    icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={toolViewShowDebugByDefault} onValueChange={setToolViewShowDebugByDefault} />}
                    showChevron={false}
                    onPress={() => setToolViewShowDebugByDefault(!toolViewShowDebugByDefault)}
                />

                <Item
                    title={t('settingsSession.toolDetailOverrides.title')}
                    subtitle={t('settingsSession.toolDetailOverrides.entrySubtitle')}
                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push(toolOverridesRoute)}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.transcript.motionTitle')} footer={t('settingsSession.transcript.motionFooter')}>
                <DropdownMenu
                    open={openMotionMenu}
                    onOpenChange={setOpenMotionMenu}
                    variant="selectable"
                    search={false}
                    selectedId={normalizedMotionPreset as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: t('settingsSession.transcript.motionPickerTitle'),
                        icon: <Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />,
                    }}
                    items={motionOptions.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
                        icon: (
                            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="sparkles-outline" size={22} color={theme.colors.textSecondary} />
                            </View>
                        ),
                    }))}
                    onSelect={(id) => {
                        setTranscriptMotionPreset(id as any);
                        setOpenMotionMenu(false);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advancedMotionTitle')}
                    subtitle={t('settingsSession.transcript.advancedMotionSubtitle')}
                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push(advancedRoute)}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.transcript.scrollTitle')} footer={t('settingsSession.transcript.scrollFooter')}>
                <Item
                    title={t('settingsSession.transcript.scrollPinTitle')}
                    subtitle={t('settingsSession.transcript.scrollPinSubtitle')}
                    icon={<Ionicons name="arrow-down-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={
                        <Switch
                            value={transcriptScrollPinEnabled === true}
                            onValueChange={(v) => setTranscriptScrollPinEnabled(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptScrollPinEnabled((transcriptScrollPinEnabled !== true) as any)}
                />

                <Item
                    title={t('settingsSession.transcript.jumpToBottomTitle')}
                    subtitle={t('settingsSession.transcript.jumpToBottomSubtitle')}
                    icon={<Ionicons name="chevron-down-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={
                        <Switch
                            value={transcriptScrollJumpToBottomEnabled === true}
                            onValueChange={(v) => setTranscriptScrollJumpToBottomEnabled(Boolean(v) as any)}
                            disabled={transcriptScrollPinEnabled !== true}
                        />
                    }
                    showChevron={false}
                    onPress={() => {
                        if (transcriptScrollPinEnabled !== true) return;
                        setTranscriptScrollJumpToBottomEnabled((transcriptScrollJumpToBottomEnabled !== true) as any);
                    }}
                />

                <Item
                    title={t('settingsSession.transcript.advancedScrollTitle')}
                    subtitle={t('settingsSession.transcript.advancedScrollSubtitle')}
                    icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push(advancedRoute)}
                />
            </ItemGroup>

            <ItemGroup>
                <Item
                    title={t('settingsSession.transcript.advancedTitle')}
                    subtitle={t('settingsSession.transcript.advancedSubtitle')}
                    icon={<Ionicons name="speedometer-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => router.push(advancedRoute)}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default TranscriptSettingsView;
