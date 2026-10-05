import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AccountSettings } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';

import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    type ToolTimelineChromeMode,
    type ToolViewDetailLevelSetting,
    type ToolViewExpandedDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import {
    TOOL_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS,
    TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS,
} from '@/components/settings/session/toolRendering/toolRenderingSettingOptions';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import {
    normalizeTranscriptMotionPreset,
    type TranscriptMotionPreset,
} from '@/components/sessions/transcript/motion/TranscriptMotionContext';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingRow, SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { TRANSCRIPT_SETTINGS } from '@/components/settings/session/transcriptSettings';
import { ThinkingDisplayPreview, ToolStylePreview, TranscriptLayoutPreview } from '@/components/settings/session/SessionSettingPreviews';
import {
    resolveThinkingDisplayChoice, resolveThinkingDisplayChoiceDelta, type ThinkingDisplayChoice,
} from '@/components/settings/session/thinkingDisplayChoice';
import { useApplySettings } from '@/sync/store/settingsWriters';

type TranscriptGroupingMode = 'linear' | 'turns';
type ToolCallsGroupStrategy = 'consecutive_tools' | 'all_tools_in_turn';
type ToolTapAction = 'expand' | 'open';
type TranscriptBulkCopyFormat = 'markdown_labeled' | 'plain';
type TranscriptMessageTimestampDisplayMode = AccountSettings['transcriptMessageTimestampDisplayMode'];

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
    const [transcriptMessageTimestampDisplayMode, setTranscriptMessageTimestampDisplayMode] = useSettingMutable('transcriptMessageTimestampDisplayMode');
    const [transcriptMessageSelectionEnabled, setTranscriptMessageSelectionEnabled] = useSettingMutable('transcriptMessageSelectionEnabled');
    const [transcriptMessageCopyActionEnabled, setTranscriptMessageCopyActionEnabled] = useSettingMutable('transcriptMessageCopyActionEnabled');
    const [transcriptMessageForkActionEnabled, setTranscriptMessageForkActionEnabled] = useSettingMutable('transcriptMessageForkActionEnabled');
    const [transcriptMessageRollbackActionEnabled, setTranscriptMessageRollbackActionEnabled] = useSettingMutable('transcriptMessageRollbackActionEnabled');
    const [transcriptMessagePinActionEnabled, setTranscriptMessagePinActionEnabled] = useSettingMutable('transcriptMessagePinActionEnabled');
    const [transcriptMessageSavePromptActionEnabled, setTranscriptMessageSavePromptActionEnabled] = useSettingMutable('transcriptMessageSavePromptActionEnabled');
    const [transcriptMessageMakeRepeatableActionEnabled, setTranscriptMessageMakeRepeatableActionEnabled] = useSettingMutable('transcriptMessageMakeRepeatableActionEnabled');
    const [transcriptMessagePluginActionsEnabled, setTranscriptMessagePluginActionsEnabled] = useSettingMutable('transcriptMessagePluginActionsEnabled');
    const [transcriptMessageSendToSessionEnabled, setTranscriptMessageSendToSessionEnabled] = useSettingMutable('transcriptMessageSendToSessionEnabled');
    const [transcriptMessageSendToSessionTemplate, setTranscriptMessageSendToSessionTemplate] = useSettingMutable('transcriptMessageSendToSessionTemplate');
    const [transcriptBulkCopyFormat, setTranscriptBulkCopyFormat] = useSettingMutable('transcriptBulkCopyFormat');

    const [sessionThinkingDisplayMode] = useSettingMutable('sessionThinkingDisplayMode');
    const [sessionThinkingInlinePresentation] = useSettingMutable('sessionThinkingInlinePresentation');
    const applySettings = useApplySettings();
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

    const [openTimestampMenu, setOpenTimestampMenu] = React.useState(false);
    const [openToolDetailMenu, setOpenToolDetailMenu] = React.useState<null | string>(null);

    const normalizedGroupingMode: TranscriptGroupingMode = transcriptGroupingMode === 'turns' ? 'turns' : 'linear';
    const normalizedMotionPreset = normalizeTranscriptMotionPreset(transcriptMotionPreset);

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

    const normalizedStrategy: ToolCallsGroupStrategy =
        transcriptTurnToolCallsGroupStrategy === 'all_tools_in_turn' ? 'all_tools_in_turn' : 'consecutive_tools';

    const normalizedTimestampDisplayMode: TranscriptMessageTimestampDisplayMode =
        transcriptMessageTimestampDisplayMode === 'hover_web_always_mobile' ||
        transcriptMessageTimestampDisplayMode === 'always' ||
        transcriptMessageTimestampDisplayMode === 'never'
            ? transcriptMessageTimestampDisplayMode
            : 'hover_web_hidden_mobile';

    const timestampDisplayOptions: Array<{ key: TranscriptMessageTimestampDisplayMode; title: string; subtitle: string }> = [
        {
            key: 'hover_web_hidden_mobile',
            title: t('settingsSession.transcript.messageTimestamps.hoverWebHiddenMobileTitle'),
            subtitle: t('settingsSession.transcript.messageTimestamps.hoverWebHiddenMobileSubtitle'),
        },
        {
            key: 'hover_web_always_mobile',
            title: t('settingsSession.transcript.messageTimestamps.hoverWebAlwaysMobileTitle'),
            subtitle: t('settingsSession.transcript.messageTimestamps.hoverWebAlwaysMobileSubtitle'),
        },
        {
            key: 'always',
            title: t('settingsSession.transcript.messageTimestamps.alwaysTitle'),
            subtitle: t('settingsSession.transcript.messageTimestamps.alwaysSubtitle'),
        },
        {
            key: 'never',
            title: t('settingsSession.transcript.messageTimestamps.neverTitle'),
            subtitle: t('settingsSession.transcript.messageTimestamps.neverSubtitle'),
        },
    ];

    const normalizedBulkCopyFormat: TranscriptBulkCopyFormat = transcriptBulkCopyFormat === 'plain' ? 'plain' : 'markdown_labeled';
    const normalizedCollapsedPreviewCount = resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCount);

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

    const normalizedToolTapAction: ToolTapAction = toolViewTapAction === 'open' ? 'open' : 'expand';

    const advancedRoute = '/(app)/settings/session/transcript/advanced';
    const toolOverridesRoute = '/(app)/settings/session/tool-rendering';

    const normalizedThinkingSelectedId = resolveThinkingDisplayChoice({ sessionThinkingDisplayMode, sessionThinkingInlinePresentation });
    // One write for the whole choice: the two stored fields never land in different revisions.
    const selectThinkingDisplay = (option: ThinkingDisplayChoice) => applySettings(resolveThinkingDisplayChoiceDelta(option));

    const thinkingDisplayOptions: Array<{ id: ThinkingDisplayChoice; title: string; subtitle: string }> = [
        { id: 'inline_summary', title: t('settingsSessionPages.transcript.thinkingSummary'), subtitle: t('settingsSession.thinking.displayMode.inlineSummarySubtitle') },
        { id: 'inline_full', title: t('settingsSessionPages.transcript.thinkingFull'), subtitle: t('settingsSession.thinking.displayMode.inlineSubtitle') },
        { id: 'tool', title: t('settingsSession.thinking.displayMode.toolTitle'), subtitle: t('settingsSession.thinking.displayMode.toolSubtitle') },
        { id: 'hidden', title: t('settingsSession.thinking.displayMode.hiddenTitle'), subtitle: t('settingsSession.thinking.displayMode.hiddenSubtitle') },
    ];
    const selectedThinkingDescription = thinkingDisplayOptions.find((option) => option.id === normalizedThinkingSelectedId)?.subtitle;

    const tToolDetail = t as (key: any) => string;
    const templateValue = typeof transcriptMessageSendToSessionTemplate === 'string' ? transcriptMessageSendToSessionTemplate : '{{MESSAGES}}';
    const templateMissingPlaceholder = typeof transcriptMessageSendToSessionTemplate === 'string'
        && !transcriptMessageSendToSessionTemplate.includes('{{MESSAGES}}');

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsSessionPages.transcript.pageDescription')} />
            <ItemGroup title={t('settingsSession.transcript.layoutTitle')} description={t('settingsSession.transcript.layoutFooter')}>
                <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.layoutPicker}>
                    <Item
                        testID="settings-session-transcript-layout-picker"
                        title={t(TRANSCRIPT_SETTINGS.settings.layoutPicker.titleKey)}
                        subtitle={normalizedGroupingMode === 'turns'
                            ? t('settingsSession.transcript.layout.turnsSubtitle')
                            : t('settingsSession.transcript.layout.linearSubtitle')}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={(
                            <SelectionTiles<TranscriptGroupingMode>
                                variant="visual"
                                accessibilityLabel={t(TRANSCRIPT_SETTINGS.settings.layoutPicker.titleKey)}
                                testIdPrefix="settings-session-transcript-layout"
                                value={normalizedGroupingMode}
                                onChange={(next) => { if (next) setTranscriptGroupingMode(next as any); }}
                                options={[
                                    { id: 'linear', title: t('settingsSession.transcript.layout.linearTitle'), preview: <TranscriptLayoutPreview layout="linear" /> },
                                    { id: 'turns', title: t('settingsSession.transcript.layout.turnsTitle'), preview: <TranscriptLayoutPreview layout="turns" /> },
                                ]}
                            />
                        )}
                    />
                </SettingAnchor>

                <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.messageTimestamps}>
                    <DropdownMenu
                        open={openTimestampMenu}
                        onOpenChange={setOpenTimestampMenu}
                        variant="selectable"
                        search={false}
                        selectedId={normalizedTimestampDisplayMode}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t(TRANSCRIPT_SETTINGS.settings.messageTimestamps.titleKey),
                            itemProps: { testID: 'settings-session-transcript-message-timestamps' },
                        }}
                        items={timestampDisplayOptions.map((opt) => ({ id: opt.key, title: opt.title, subtitle: opt.subtitle }))}
                        onSelect={(id) => {
                            setTranscriptMessageTimestampDisplayMode(id as TranscriptMessageTimestampDisplayMode);
                            setOpenTimestampMenu(false);
                        }}
                    />
                </SettingAnchor>
            </ItemGroup>

            <SettingSection section={TRANSCRIPT_SETTINGS.sectionRefs.thinking}>
                <ItemGroup title={t('settingsSession.thinking.title')} description={t('settingsSession.thinking.footer')}>
                    <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.displayMode}>
                        <Item
                            testID="settings-session-thinking-display"
                            title={t(TRANSCRIPT_SETTINGS.settings.displayMode.titleKey)}
                            subtitle={selectedThinkingDescription}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={(
                                <SelectionTiles<ThinkingDisplayChoice>
                                    variant="visual"
                                    accessibilityLabel={t(TRANSCRIPT_SETTINGS.settings.displayMode.titleKey)}
                                    testIdPrefix="settings-session-thinking-display"
                                    value={normalizedThinkingSelectedId}
                                    onChange={(next) => { if (next) selectThinkingDisplay(next); }}
                                    options={thinkingDisplayOptions.map((option) => ({
                                        id: option.id,
                                        title: option.title,
                                        preview: <ThinkingDisplayPreview mode={option.id} inlineChrome={sessionThinkingInlineChrome === 'plain' ? 'plain' : 'card'} />,
                                    }))}
                                />
                            )}
                        />
                    </SettingAnchor>

                    {sessionThinkingDisplayMode === 'inline' ? (
                        <SettingRow
                            setting={TRANSCRIPT_SETTINGS.settings.inlineChrome}
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
            </SettingSection>

            <SettingSection section={TRANSCRIPT_SETTINGS.sectionRefs.toolRendering}>
                <ItemGroup title={t('settingsSessionPages.transcript.toolsSection')} description={t('settingsSession.toolRendering.footer')}>
                    <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.timelineChrome}>
                        <Item
                            testID="settings-session-tool-style"
                            title={t(TRANSCRIPT_SETTINGS.settings.timelineChrome.titleKey)}
                            subtitle={normalizedToolChromeMode === 'activity_feed'
                                ? t('settingsSession.toolRendering.timelineChrome.activityFeedSubtitle')
                                : t('settingsSession.toolRendering.timelineChrome.cardsSubtitle')}
                            accessoryLayout="stacked"
                            showChevron={false}
                            rightElement={(
                                <SelectionTiles<ToolTimelineChromeMode>
                                    variant="visual"
                                    accessibilityLabel={t(TRANSCRIPT_SETTINGS.settings.timelineChrome.titleKey)}
                                    testIdPrefix="settings-session-tool-style"
                                    value={normalizedToolChromeMode}
                                    onChange={(next) => { if (next) setToolViewTimelineChromeMode(next as any); }}
                                    options={[
                                        { id: 'cards', title: t('settingsSession.toolRendering.timelineChrome.cardsTitle'), preview: <ToolStylePreview style="cards" /> },
                                        { id: 'activity_feed', title: t('settingsSession.toolRendering.timelineChrome.activityFeedTitle'), preview: <ToolStylePreview style="activity_feed" /> },
                                    ]}
                                />
                            )}
                        />
                    </SettingAnchor>

                    {normalizedToolChromeMode === 'activity_feed' ? (
                        <SettingRow
                            setting={TRANSCRIPT_SETTINGS.settings.toolCallsGroup}
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
                    ) : null}

                    {normalizedToolChromeMode === 'activity_feed' && transcriptGroupToolCalls === true && normalizedGroupingMode === 'turns' ? (
                        <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.toolCallsStrategy}>
                            <SegmentedChoiceItem<ToolCallsGroupStrategy>
                                subtitleLines={0}
                                testID="settings-session-transcript-tool-calls-strategy"
                                testIDPrefix="settings-session-transcript-tool-calls-strategy"
                                title={t(TRANSCRIPT_SETTINGS.settings.toolCallsStrategy.titleKey)}
                                options={[
                                    { id: 'consecutive_tools', label: t('settingsSessionPages.transcript.strategyConsecutive'), description: t('settingsSession.transcript.advanced.toolCallsStrategy.consecutiveSubtitle') },
                                    { id: 'all_tools_in_turn', label: t('settingsSessionPages.transcript.strategyWholeTurn'), description: t('settingsSession.transcript.advanced.toolCallsStrategy.allToolsSubtitle') },
                                ]}
                                value={normalizedStrategy}
                                onChange={(next) => setTranscriptTurnToolCallsGroupStrategy(next as any)}
                            />
                        </SettingAnchor>
                    ) : null}

                    {normalizedToolChromeMode === 'activity_feed' && transcriptGroupToolCalls === true ? (
                        <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.toolCallsCollapsedPreviewCount}>
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
                                    title: t(TRANSCRIPT_SETTINGS.settings.toolCallsCollapsedPreviewCount.titleKey),
                                }}
                                items={collapsedPreviewOptions.map((opt) => ({ id: String(opt.key), title: opt.title, subtitle: opt.subtitle }))}
                                onSelect={(id) => {
                                    const parsed = Number(id);
                                    if (!Number.isFinite(parsed)) return;
                                    setTranscriptToolCallsCollapsedPreviewCount(clampInt(parsed, { min: 0, max: 15 }) as any);
                                    setOpenToolDetailMenu(null);
                                }}
                            />
                        </SettingAnchor>
                    ) : null}

                    {normalizedToolChromeMode === 'activity_feed' && transcriptGroupToolCalls === true ? (
                        <SettingRow
                            setting={TRANSCRIPT_SETTINGS.settings.toolCallsGroupBackground}
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
                    ) : null}

                    <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.defaultToolDetailLevel}>
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
                                title: t(TRANSCRIPT_SETTINGS.settings.defaultToolDetailLevel.titleKey),
                                itemProps: { testID: 'settings-session-tool-detail-default' },
                            }}
                            items={TOOL_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.map((opt) => ({
                                id: opt.key,
                                title: opt.key === 'default' ? tToolDetail('settingsSession.toolDetailLevel.defaultTitle') : tToolDetail(opt.titleKey),
                                subtitle: tToolDetail(opt.subtitleKey),
                            }))}
                            onSelect={(id) => {
                                setToolViewDetailLevelDefault(id as any);
                                setOpenToolDetailMenu(null);
                            }}
                        />
                    </SettingAnchor>

                    <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.expandedToolDetailLevel}>
                        <SegmentedChoiceItem<ToolViewExpandedDetailLevelSetting>
                            subtitleLines={0}
                            testID="settings-session-tool-detail-expanded"
                            testIDPrefix="settings-session-tool-detail-expanded"
                            title={t(TRANSCRIPT_SETTINGS.settings.expandedToolDetailLevel.titleKey)}
                            options={TOOL_EXPANDED_DETAIL_LEVEL_WITH_STYLE_DEFAULT_OPTIONS.map((opt) => ({
                                id: opt.key,
                                label: opt.key === 'default' ? tToolDetail('settingsSession.toolDetailLevel.defaultTitle') : tToolDetail(opt.titleKey),
                                description: tToolDetail(opt.subtitleKey),
                            }))}
                            value={normalizedToolViewExpandedDetailLevelDefaultSetting}
                            onChange={(next) => setToolViewExpandedDetailLevelDefault(next as any)}
                        />
                    </SettingAnchor>

                    <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.cardTapAction}>
                        <SegmentedChoiceItem<ToolTapAction>
                            subtitleLines={0}
                            testID="settings-session-tool-tap-action"
                            testIDPrefix="settings-session-tool-tap-action"
                            title={t(TRANSCRIPT_SETTINGS.settings.cardTapAction.titleKey)}
                            options={[
                                { id: 'expand', label: t('settingsSession.toolRendering.activityFeed.tapAction.expandTitle'), description: t('settingsSession.toolRendering.activityFeed.tapAction.expandSubtitle') },
                                { id: 'open', label: t('settingsSession.toolRendering.activityFeed.tapAction.openTitle'), description: t('settingsSession.toolRendering.activityFeed.tapAction.openSubtitle') },
                            ]}
                            value={normalizedToolTapAction}
                            onChange={(next) => setToolViewTapAction(next as any)}
                        />
                    </SettingAnchor>

                    {normalizedToolChromeMode === 'activity_feed' ? (
                        <SettingRow
                            setting={TRANSCRIPT_SETTINGS.settings.defaultExpanded}
                            rightElement={
                                <Switch
                                    value={toolViewTimelineFeedDefaultExpanded === true}
                                    onValueChange={(v) => setToolViewTimelineFeedDefaultExpanded(Boolean(v) as any)}
                                />
                            }
                            showChevron={false}
                            onPress={() => setToolViewTimelineFeedDefaultExpanded((toolViewTimelineFeedDefaultExpanded !== true) as any)}
                        />
                    ) : null}

                    <SettingRow
                        setting={TRANSCRIPT_SETTINGS.settings.showDebugByDefault}
                        rightElement={<Switch value={toolViewShowDebugByDefault} onValueChange={setToolViewShowDebugByDefault} />}
                        showChevron={false}
                        onPress={() => setToolViewShowDebugByDefault(!toolViewShowDebugByDefault)}
                    />

                    <SettingRow
                        icon={<Icon name="sliders-horizontal" />}
                        setting={TRANSCRIPT_SETTINGS.settings.toolDetailOverrides}
                        onPress={() => router.push(toolOverridesRoute)}
                    />
                </ItemGroup>
            </SettingSection>

            <ItemGroup title={t('settingsSession.transcript.messageActions.groupTitle')} description={t('settingsSession.transcript.messageActions.groupFooter')}>
                <SettingRow testID="settings-transcript-copy-enabled" setting={TRANSCRIPT_SETTINGS.settings.copyEnabled}
                    rightElement={<Switch value={transcriptMessageCopyActionEnabled !== false} onValueChange={setTranscriptMessageCopyActionEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessageCopyActionEnabled(transcriptMessageCopyActionEnabled === false)} />
                <SettingRow testID="settings-transcript-fork-enabled" setting={TRANSCRIPT_SETTINGS.settings.forkEnabled}
                    rightElement={<Switch value={transcriptMessageForkActionEnabled !== false} onValueChange={setTranscriptMessageForkActionEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessageForkActionEnabled(transcriptMessageForkActionEnabled === false)} />
                <SettingRow testID="settings-transcript-rollback-enabled" setting={TRANSCRIPT_SETTINGS.settings.rollbackEnabled}
                    rightElement={<Switch value={transcriptMessageRollbackActionEnabled !== false} onValueChange={setTranscriptMessageRollbackActionEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessageRollbackActionEnabled(transcriptMessageRollbackActionEnabled === false)} />
                <SettingRow testID="settings-transcript-pin-enabled" setting={TRANSCRIPT_SETTINGS.settings.pinEnabled}
                    rightElement={<Switch value={transcriptMessagePinActionEnabled !== false} onValueChange={setTranscriptMessagePinActionEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessagePinActionEnabled(transcriptMessagePinActionEnabled === false)} />
                <SettingRow testID="settings-transcript-savePrompt-enabled" setting={TRANSCRIPT_SETTINGS.settings.savePromptEnabled}
                    rightElement={<Switch value={transcriptMessageSavePromptActionEnabled !== false} onValueChange={setTranscriptMessageSavePromptActionEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessageSavePromptActionEnabled(transcriptMessageSavePromptActionEnabled === false)} />
                <SettingRow testID="settings-transcript-plugins-enabled" setting={TRANSCRIPT_SETTINGS.settings.pluginsEnabled}
                    rightElement={<Switch value={transcriptMessagePluginActionsEnabled !== false} onValueChange={setTranscriptMessagePluginActionsEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessagePluginActionsEnabled(transcriptMessagePluginActionsEnabled === false)} />
                <SettingRow testID="settings-transcript-makeRepeatable-enabled" setting={TRANSCRIPT_SETTINGS.settings.makeRepeatableEnabled}
                    rightElement={<Switch value={transcriptMessageMakeRepeatableActionEnabled !== false} onValueChange={setTranscriptMessageMakeRepeatableActionEnabled} />}
                    showChevron={false} onPress={() => setTranscriptMessageMakeRepeatableActionEnabled(transcriptMessageMakeRepeatableActionEnabled === false)} />
                <SettingRow
                    testID="settings-session-transcript-message-selection-enabled"
                    setting={TRANSCRIPT_SETTINGS.settings.selectionEnabled}
                    rightElement={<Switch value={transcriptMessageSelectionEnabled === true} onValueChange={setTranscriptMessageSelectionEnabled} />}
                    showChevron={false}
                    onPress={() => setTranscriptMessageSelectionEnabled(!(transcriptMessageSelectionEnabled === true))}
                />
                <SettingRow
                    testID="settings-session-transcript-message-send-to-session-enabled"
                    setting={TRANSCRIPT_SETTINGS.settings.sendToSessionEnabled}
                    rightElement={<Switch value={transcriptMessageSendToSessionEnabled === true} onValueChange={setTranscriptMessageSendToSessionEnabled} />}
                    showChevron={false}
                    onPress={() => setTranscriptMessageSendToSessionEnabled(!(transcriptMessageSendToSessionEnabled === true))}
                />
                <SettingRow
                    testID="settings-session-transcript-message-send-template-field"
                    setting={TRANSCRIPT_SETTINGS.settings.sendToSessionTemplate}
                    subtitle={t('settingsSession.transcript.messageActions.template.subtitle')}
                    subtitleLines={0}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <View style={{ gap: 6 }}>
                            <FieldTextInput
                                testID="settings-session-transcript-message-send-template-input"
                                accessibilityLabel={t('settingsSession.transcript.messageActions.template.title')}
                                value={templateValue}
                                onChangeText={setTranscriptMessageSendToSessionTemplate}
                                placeholder={t('settingsSession.transcript.messageActions.template.placeholder')}
                                multiline
                                monospace
                            />
                            {templateMissingPlaceholder ? (
                                <Text style={[styles.templateTip, { color: theme.colors.state.warning.foreground }]}>
                                    {t('settingsSession.transcript.messageActions.template.warningMissingPlaceholder')}
                                </Text>
                            ) : null}
                        </View>
                    )}
                />
                <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.bulkCopyFormat}>
                    <SegmentedChoiceItem<TranscriptBulkCopyFormat>
                        subtitleLines={0}
                        testID="settings-session-transcript-bulk-copy-format"
                        testIDPrefix="settings-session-transcript-bulk-copy-format"
                        title={t(TRANSCRIPT_SETTINGS.settings.bulkCopyFormat.titleKey)}
                        options={[
                            { id: 'markdown_labeled', label: t('settingsSessionPages.transcript.copyMarkdown'), description: t('settingsSessionPages.transcript.copyMarkdownDescription') },
                            { id: 'plain', label: t('settingsSession.transcript.messageActions.bulkCopyFormat.plain'), description: t('settingsSessionPages.transcript.copyPlainDescription') },
                        ]}
                        value={normalizedBulkCopyFormat}
                        onChange={setTranscriptBulkCopyFormat}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup title={t('settingsSession.transcript.motionTitle')} description={t('settingsSession.transcript.motionFooter')}>
                <SettingAnchor setting={TRANSCRIPT_SETTINGS.settings.motionPicker}>
                    <SegmentedChoiceItem<TranscriptMotionPreset>
                        subtitleLines={0}
                        testID="settings-session-transcript-motion"
                        testIDPrefix="settings-session-transcript-motion"
                        title={t(TRANSCRIPT_SETTINGS.settings.motionPicker.titleKey)}
                        options={[
                            { id: 'off', label: t('settingsSession.transcript.motion.offTitle'), description: t('settingsSession.transcript.motion.offSubtitle') },
                            { id: 'subtle', label: t('settingsSessionPages.transcript.motionSubtle'), description: t('settingsSession.transcript.motion.subtleSubtitle') },
                            { id: 'full', label: t('settingsSession.transcript.motion.fullTitle'), description: t('settingsSession.transcript.motion.fullSubtitle') },
                        ]}
                        value={normalizedMotionPreset}
                        onChange={setTranscriptMotionPreset}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup title={t('settingsSession.transcript.scrollTitle')} description={t('settingsSession.transcript.scrollFooter')}>
                <SettingRow
                    setting={TRANSCRIPT_SETTINGS.settings.scrollPin}
                    rightElement={
                        <Switch
                            value={transcriptScrollPinEnabled === true}
                            onValueChange={(v) => setTranscriptScrollPinEnabled(Boolean(v) as any)}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTranscriptScrollPinEnabled((transcriptScrollPinEnabled !== true) as any)}
                />

                <SettingRow
                    setting={TRANSCRIPT_SETTINGS.settings.jumpToBottom}
                    disabled={transcriptScrollPinEnabled !== true}
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
            </ItemGroup>

            <ItemGroup title={t('settingsSession.advanced.title')}>
                <SettingRow
                    icon={<Icon name="speedometer" />}
                    setting={TRANSCRIPT_SETTINGS.settings.advanced}
                    testID="settings-session-transcript-advanced"
                    onPress={() => router.push(advancedRoute)}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create({
    templateTip: {
        ...Typography.default('regular'),
        fontSize: 12,
        lineHeight: 16,
    },
});

export default TranscriptSettingsView;
