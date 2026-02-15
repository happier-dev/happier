import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, TextInput, Platform } from 'react-native';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { BusySteerSendPolicy, MessageSendMode } from '@/sync/domains/session/control/submitMode';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getPermissionApplyTimingSubtitleKey } from './sessionI18n';
import { ExecutionRunsGuidanceSettingsGroup } from '@/components/settings/session/ExecutionRunsGuidanceSettingsGroup';
import { ActionsSettingsGroup } from '@/components/settings/actions/ActionsSettingsGroup';

type ToolViewDetailLevel = 'title' | 'summary' | 'full';
type ToolDetailLevelTranslationKey =
    | 'settingsSession.toolDetailLevel.defaultTitle'
    | 'settingsSession.toolDetailLevel.defaultSubtitle'
    | 'settingsSession.toolDetailLevel.titleOnlyTitle'
    | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
    | 'settingsSession.toolDetailLevel.summaryTitle'
    | 'settingsSession.toolDetailLevel.summarySubtitle'
    | 'settingsSession.toolDetailLevel.fullTitle'
    | 'settingsSession.toolDetailLevel.fullSubtitle';

const TOOL_DETAIL_LEVEL_OPTIONS = [
    {
        key: 'title',
        titleKey: 'settingsSession.toolDetailLevel.titleOnlyTitle',
        subtitleKey: 'settingsSession.toolDetailLevel.titleOnlySubtitle',
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
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

const TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS = [
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
        | 'settingsSession.toolDetailLevel.summaryTitle'
        | 'settingsSession.toolDetailLevel.fullTitle';
    subtitleKey:
        | 'settingsSession.toolDetailLevel.defaultSubtitle'
        | 'settingsSession.toolDetailLevel.titleOnlySubtitle'
        | 'settingsSession.toolDetailLevel.summarySubtitle'
        | 'settingsSession.toolDetailLevel.fullSubtitle';
}>;

const TOOL_OVERRIDE_KEYS: Array<{ toolName: string; title: string }> = [
    { toolName: 'Bash', title: 'Bash' },
    { toolName: 'Read', title: 'Read' },
    { toolName: 'Write', title: 'Write' },
    { toolName: 'Edit', title: 'Edit' },
    { toolName: 'MultiEdit', title: 'MultiEdit' },
    { toolName: 'Glob', title: 'Glob' },
    { toolName: 'Grep', title: 'Grep' },
    { toolName: 'LS', title: 'LS' },
    { toolName: 'CodeSearch', title: 'CodeSearch' },
    { toolName: 'TodoWrite', title: 'TodoWrite' },
    { toolName: 'TodoRead', title: 'TodoRead' },
    { toolName: 'WebFetch', title: 'WebFetch' },
    { toolName: 'WebSearch', title: 'WebSearch' },
    { toolName: 'Task', title: 'Task' },
    { toolName: 'Patch', title: 'Patch' },
    { toolName: 'Diff', title: 'Diff' },
    { toolName: 'Reasoning', title: 'Reasoning' },
    { toolName: 'ExitPlanMode', title: 'ExitPlanMode' },
    { toolName: 'AskUserQuestion', title: 'AskUserQuestion' },
    { toolName: 'change_title', title: 'change_title' },
];

export default React.memo(function SessionSettingsScreen() {
    const { theme } = useUnistyles();
    const popoverBoundaryRef = React.useRef<any>(null);

    const [useTmux, setUseTmux] = useSettingMutable('sessionUseTmux');
    const [tmuxSessionName, setTmuxSessionName] = useSettingMutable('sessionTmuxSessionName');
    const [tmuxIsolated, setTmuxIsolated] = useSettingMutable('sessionTmuxIsolated');
    const [tmuxTmpDir, setTmuxTmpDir] = useSettingMutable('sessionTmuxTmpDir');

    const [messageSendMode, setMessageSendMode] = useSettingMutable('sessionMessageSendMode');
    const [busySteerSendPolicy, setBusySteerSendPolicy] = useSettingMutable('sessionBusySteerSendPolicy');

    const [toolViewDetailLevelDefault, setToolViewDetailLevelDefault] = useSettingMutable('toolViewDetailLevelDefault');
    const [toolViewDetailLevelDefaultLocalControl, setToolViewDetailLevelDefaultLocalControl] = useSettingMutable('toolViewDetailLevelDefaultLocalControl');
    const [toolViewDetailLevelByToolName, setToolViewDetailLevelByToolName] = useSettingMutable('toolViewDetailLevelByToolName');
    const [toolViewShowDebugByDefault, setToolViewShowDebugByDefault] = useSettingMutable('toolViewShowDebugByDefault');
    const [terminalConnectLegacySecretExportEnabled, setTerminalConnectLegacySecretExportEnabled] = useSettingMutable('terminalConnectLegacySecretExportEnabled');

    const enabledAgentIds = useEnabledAgentIds();

    const [defaultPermissionByAgent, setDefaultPermissionByAgent] = useSettingMutable('sessionDefaultPermissionModeByAgent');
    const [permissionModeApplyTiming, setPermissionModeApplyTiming] = useSettingMutable('sessionPermissionModeApplyTiming');
    const [sessionReplayEnabled, setSessionReplayEnabled] = useSettingMutable('sessionReplayEnabled');
    const [sessionReplayStrategy, setSessionReplayStrategy] = useSettingMutable('sessionReplayStrategy');
    const [sessionReplayRecentMessagesCount, setSessionReplayRecentMessagesCount] = useSettingMutable('sessionReplayRecentMessagesCount');
    const [executionRunsGuidanceEnabled, setExecutionRunsGuidanceEnabled] = useSettingMutable('executionRunsGuidanceEnabled');
    const [executionRunsGuidanceMaxChars, setExecutionRunsGuidanceMaxChars] = useSettingMutable('executionRunsGuidanceMaxChars');
    const [executionRunsGuidanceEntries, setExecutionRunsGuidanceEntries] = useSettingMutable('executionRunsGuidanceEntries');
    const [actionsSettingsV1, setActionsSettingsV1] = useSettingMutable('actionsSettingsV1');
    const getDefaultPermission = React.useCallback((agent: AgentId): PermissionMode => {
        const raw = (defaultPermissionByAgent as any)?.[agent] as PermissionMode | undefined;
        return (raw ?? 'default') as PermissionMode;
    }, [defaultPermissionByAgent]);
    const setDefaultPermission = React.useCallback((agent: AgentId, mode: PermissionMode) => {
        setDefaultPermissionByAgent({
            ...(defaultPermissionByAgent ?? {}),
            [agent]: mode,
        } as any);
    }, [defaultPermissionByAgent, setDefaultPermissionByAgent]);

    const [openProvider, setOpenProvider] = React.useState<null | AgentId>(null);
    const [openToolDetailMenu, setOpenToolDetailMenu] = React.useState<null | string>(null);
    const tToolDetail = t as (key: ToolDetailLevelTranslationKey) => string;
    const [openReplayMenu, setOpenReplayMenu] = React.useState<boolean>(false);

    const options: Array<{ key: MessageSendMode; title: string; subtitle: string }> = [
        {
            key: 'agent_queue',
            title: t('settingsSession.messageSending.queueInAgentTitle'),
            subtitle: t('settingsSession.messageSending.queueInAgentSubtitle'),
        },
        {
            key: 'interrupt',
            title: t('settingsSession.messageSending.interruptTitle'),
            subtitle: t('settingsSession.messageSending.interruptSubtitle'),
        },
        {
            key: 'server_pending',
            title: t('settingsSession.messageSending.pendingTitle'),
            subtitle: t('settingsSession.messageSending.pendingSubtitle'),
        },
    ];

    const busySteerOptions: Array<{ key: BusySteerSendPolicy; title: string; subtitle: string }> = [
        {
            key: 'steer_immediately',
            title: t('settingsSession.messageSending.busySteerPolicy.steerImmediatelyTitle'),
            subtitle: t('settingsSession.messageSending.busySteerPolicy.steerImmediatelySubtitle'),
        },
        {
            key: 'server_pending',
            title: t('settingsSession.messageSending.busySteerPolicy.queueForReviewTitle'),
            subtitle: t('settingsSession.messageSending.busySteerPolicy.queueForReviewSubtitle'),
        },
    ];

    const replayStrategyOptions: Array<{ key: 'recent_messages' | 'summary_plus_recent'; title: string; subtitle: string }> = [
        {
            key: 'recent_messages',
            title: t('settingsSession.replayResume.strategy.recentTitle'),
            subtitle: t('settingsSession.replayResume.strategy.recentSubtitle'),
        },
        {
            key: 'summary_plus_recent',
            title: t('settingsSession.replayResume.strategy.summaryRecentTitle'),
            subtitle: t('settingsSession.replayResume.strategy.summaryRecentSubtitle'),
        },
    ];

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.messageSending.title')} footer={t('settingsSession.messageSending.footer')}>
                {options.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons name="send-outline" size={29} color="#007AFF" />}
                        rightElement={messageSendMode === option.key ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                        onPress={() => setMessageSendMode(option.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {messageSendMode === 'agent_queue' || messageSendMode === 'server_pending' ? (
                <ItemGroup
                    title={t('settingsSession.messageSending.busySteerPolicyTitle')}
                    footer={t('settingsSession.messageSending.busySteerPolicyFooter')}
                >
                    {busySteerOptions.map((option) => (
                        <Item
                            key={option.key}
                            title={option.title}
                            subtitle={option.subtitle}
                            icon={<Ionicons name="git-branch-outline" size={29} color="#007AFF" />}
                            rightElement={busySteerSendPolicy === option.key ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                            onPress={() => setBusySteerSendPolicy(option.key)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('settingsSession.toolRendering.title')}
                footer={t('settingsSession.toolRendering.footer')}
            >
                <DropdownMenu
                    open={openToolDetailMenu === 'toolViewDetailLevelDefault'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewDetailLevelDefault' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={toolViewDetailLevelDefault as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <Item
                            title={t('settingsSession.toolRendering.defaultToolDetailLevelTitle')}
                            subtitle={
                                (() => {
                                    const key = TOOL_DETAIL_LEVEL_OPTIONS.find((opt) => opt.key === toolViewDetailLevelDefault)?.titleKey;
                                    return key ? tToolDetail(key) : String(toolViewDetailLevelDefault);
                                })()
                            }
                            icon={<Ionicons name="construct-outline" size={29} color="#007AFF" />}
                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                            onPress={toggle}
                            showChevron={false}
                            selected={false}
                        />
                    )}
                    items={TOOL_DETAIL_LEVEL_OPTIONS.map((opt) => ({
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
                    open={openToolDetailMenu === 'toolViewDetailLevelDefaultLocalControl'}
                    onOpenChange={(next) => setOpenToolDetailMenu(next ? 'toolViewDetailLevelDefaultLocalControl' : null)}
                    variant="selectable"
                    search={false}
                    selectedId={toolViewDetailLevelDefaultLocalControl as any}
                    showCategoryTitles={false}
                    matchTriggerWidth={true}
                    connectToTrigger={true}
                    rowKind="item"
                    popoverBoundaryRef={popoverBoundaryRef}
                    trigger={({ open, toggle }) => (
                        <Item
                            title={t('settingsSession.toolRendering.localControlDefaultTitle')}
                            subtitle={
                                (() => {
                                    const key = TOOL_DETAIL_LEVEL_OPTIONS.find((opt) => opt.key === toolViewDetailLevelDefaultLocalControl)?.titleKey;
                                    return key ? tToolDetail(key) : String(toolViewDetailLevelDefaultLocalControl);
                                })()
                            }
                            icon={<Ionicons name="shield-outline" size={29} color="#FF9500" />}
                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                            onPress={toggle}
                            showChevron={false}
                            selected={false}
                        />
                    )}
                    items={TOOL_DETAIL_LEVEL_OPTIONS.map((opt) => ({
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
                        setToolViewDetailLevelDefaultLocalControl(id as any);
                        setOpenToolDetailMenu(null);
                    }}
                />

                <Item
                    title={t('settingsSession.toolRendering.showDebugByDefaultTitle')}
                    subtitle={t('settingsSession.toolRendering.showDebugByDefaultSubtitle')}
                    icon={<Ionicons name="code-slash-outline" size={29} color="#5856D6" />}
                    rightElement={<Switch value={toolViewShowDebugByDefault} onValueChange={setToolViewShowDebugByDefault} />}
                    showChevron={false}
                    onPress={() => setToolViewShowDebugByDefault(!toolViewShowDebugByDefault)}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.toolDetailOverrides.title')}
                footer={t('settingsSession.toolDetailOverrides.footer')}
            >
                {TOOL_OVERRIDE_KEYS.map((toolKey, index) => {
                    const override = (toolViewDetailLevelByToolName as any)?.[toolKey.toolName] as ToolViewDetailLevel | undefined;
                    const selected = override ?? 'default';
                    const showDivider = index < TOOL_OVERRIDE_KEYS.length - 1;

                    return (
                        <DropdownMenu
                            key={toolKey.toolName}
                            open={openToolDetailMenu === `toolOverride:${toolKey.toolName}`}
                            onOpenChange={(next) => setOpenToolDetailMenu(next ? `toolOverride:${toolKey.toolName}` : null)}
                            variant="selectable"
                            search={false}
                            selectedId={selected as any}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            trigger={({ open, toggle }) => (
                                <Item
                                    title={toolKey.title}
                                    subtitle={
                                        (() => {
                                            const key = TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.find((opt) => opt.key === selected)?.titleKey;
                                            return key ? tToolDetail(key) : String(selected);
                                        })()
                                    }
                                    icon={<Ionicons name="construct-outline" size={29} color={theme.colors.textSecondary} />}
                                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                                    onPress={toggle}
                                    showChevron={false}
                                    showDivider={showDivider}
                                    selected={false}
                                />
                            )}
                            items={TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.map((opt) => ({
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
                                const next = id as ToolViewDetailLevel | 'default';
                                const current = (toolViewDetailLevelByToolName ?? {}) as Record<string, ToolViewDetailLevel>;
                                const nextRecord: Record<string, ToolViewDetailLevel> = { ...current };
                                if (next === 'default') {
                                    delete nextRecord[toolKey.toolName];
                                } else {
                                    nextRecord[toolKey.toolName] = next;
                                }
                                setToolViewDetailLevelByToolName(nextRecord as any);
                                setOpenToolDetailMenu(null);
                            }}
                        />
                    );
                })}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.defaultPermissions.title')} footer={t('settingsSession.defaultPermissions.footer')}>
                <Item
                    title={t('settingsSession.defaultPermissions.applyPermissionChangesTitle')}
                    subtitle={t(getPermissionApplyTimingSubtitleKey(permissionModeApplyTiming))}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                    rightElement={(
                        <Switch
                            value={permissionModeApplyTiming === 'immediate'}
                            onValueChange={(value) => setPermissionModeApplyTiming(value ? 'immediate' : 'next_prompt')}
                        />
                    )}
                    showChevron={false}
                    showDivider={true}
                    onPress={() => setPermissionModeApplyTiming(permissionModeApplyTiming === 'immediate' ? 'next_prompt' : 'immediate')}
                />
                {enabledAgentIds.map((agentId, index) => {
                    const core = getAgentCore(agentId);
                    const mode = getDefaultPermission(agentId);
                    const showDivider = index < enabledAgentIds.length - 1;
                    return (
                        <DropdownMenu
                            key={agentId}
                            open={openProvider === agentId}
                            onOpenChange={(next) => setOpenProvider(next ? agentId : null)}
                            variant="selectable"
                            search={false}
                            selectedId={mode as any}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            trigger={({ open, toggle }) => (
                                <Item
                                    title={t(core.displayNameKey)}
                                    subtitle={getPermissionModeLabelForAgentType(agentId as any, mode)}
                                    icon={<Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />}
                                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                                    onPress={toggle}
                                    showChevron={false}
                                    showDivider={showDivider}
                                    selected={false}
                                />
                            )}
                            items={getPermissionModeOptionsForAgentType(agentId as any).map((opt) => ({
                                id: opt.value,
                                title: opt.label,
                                subtitle: opt.description,
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name={opt.icon as any} size={22} color={theme.colors.textSecondary} />
                                    </View>
                                ),
                            }))}
                            onSelect={(id) => {
                                setDefaultPermission(agentId, id as any);
                                setOpenProvider(null);
                            }}
                        />
                    );
                })}
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.replayResume.title')}
                footer={t('settingsSession.replayResume.footer')}
            >
                <Item
                    title={t('settingsSession.replayResume.enabledTitle')}
                    subtitle={sessionReplayEnabled ? t('settingsSession.replayResume.enabledSubtitleOn') : t('settingsSession.replayResume.enabledSubtitleOff')}
                    icon={<Ionicons name="refresh-outline" size={29} color="#34C759" />}
                    rightElement={<Switch value={sessionReplayEnabled} onValueChange={setSessionReplayEnabled} />}
                    showChevron={false}
                    onPress={() => setSessionReplayEnabled(!sessionReplayEnabled)}
                />

                {sessionReplayEnabled ? (
                    <>
                        <DropdownMenu
                            open={openReplayMenu}
                            onOpenChange={setOpenReplayMenu}
                            variant="selectable"
                            search={false}
                            selectedId={String(sessionReplayStrategy ?? 'recent_messages')}
                            showCategoryTitles={false}
                            matchTriggerWidth={true}
                            connectToTrigger={true}
                            rowKind="item"
                            popoverBoundaryRef={popoverBoundaryRef}
                            trigger={({ open, toggle }) => (
                                <Item
                                    title={t('settingsSession.replayResume.strategyTitle')}
                                    subtitle={replayStrategyOptions.find((opt) => opt.key === sessionReplayStrategy)?.title ?? String(sessionReplayStrategy)}
                                    icon={<Ionicons name="list-outline" size={29} color="#34C759" />}
                                    rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                                    onPress={toggle}
                                    showChevron={false}
                                    selected={false}
                                />
                            )}
                            items={replayStrategyOptions.map((opt) => ({
                                id: opt.key,
                                title: opt.title,
                                subtitle: opt.subtitle,
                                icon: (
                                    <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                        <Ionicons name="chatbox-ellipses-outline" size={22} color={theme.colors.textSecondary} />
                                    </View>
                                ),
                            }))}
                            onSelect={(id) => {
                                setSessionReplayStrategy(id as any);
                                setOpenReplayMenu(false);
                            }}
                        />

                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>
                                {t('settingsSession.replayResume.recentMessagesTitle')}
                            </Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('settingsSession.replayResume.recentMessagesPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={String(sessionReplayRecentMessagesCount ?? '')}
                                keyboardType={Platform.select({ ios: 'number-pad', default: 'numeric' }) as any}
                                onChangeText={(value) => {
                                    const next = Number(String(value).replace(/[^0-9]/g, ''));
                                    if (!Number.isFinite(next)) return;
                                    const clamped = Math.max(1, Math.min(100, Math.floor(next)));
                                    setSessionReplayRecentMessagesCount(clamped as any);
                                }}
                            />
                        </View>
                    </>
                ) : null}
            </ItemGroup>

            <ExecutionRunsGuidanceSettingsGroup
                enabled={Boolean(executionRunsGuidanceEnabled)}
                setEnabled={(next) => setExecutionRunsGuidanceEnabled(next as any)}
                maxChars={Number(executionRunsGuidanceMaxChars ?? 4_000)}
                setMaxChars={(next) => setExecutionRunsGuidanceMaxChars(next as any)}
                entries={(Array.isArray(executionRunsGuidanceEntries) ? (executionRunsGuidanceEntries as any[]) : []) as any}
                setEntries={(next) => setExecutionRunsGuidanceEntries(next as any)}
            />

            <ActionsSettingsGroup
                settings={(actionsSettingsV1 as any) ?? { v: 1, disabledActionIds: [] }}
                setSettings={(next) => setActionsSettingsV1(next as any)}
            />

            <ItemGroup title={t('profiles.tmux.title')}>
                <Item
                    title={t('profiles.tmux.spawnSessionsTitle')}
                    subtitle={useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle')}
                    icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                    rightElement={<Switch value={useTmux} onValueChange={setUseTmux} />}
                    showChevron={false}
                    onPress={() => setUseTmux(!useTmux)}
                />

                {useTmux && (
                    <>
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>
                                {t('profiles.tmuxSession')} ({t('common.optional')})
                            </Text>
                            <TextInput
                                style={styles.textInput}
                                placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={tmuxSessionName ?? ''}
                                onChangeText={setTmuxSessionName}
                            />
                        </View>

                        <Item
                            title={t('profiles.tmux.isolatedServerTitle')}
                            subtitle={tmuxIsolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                            icon={<Ionicons name="albums-outline" size={29} color="#5856D6" />}
                            rightElement={<Switch value={tmuxIsolated} onValueChange={setTmuxIsolated} />}
                            showChevron={false}
                            onPress={() => setTmuxIsolated(!tmuxIsolated)}
                        />

                        {tmuxIsolated && (
                            <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                                <Text style={styles.fieldLabel}>
                                    {t('profiles.tmuxTempDir')} ({t('common.optional')})
                                </Text>
                                <TextInput
                                    style={styles.textInput}
                                    placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    value={tmuxTmpDir ?? ''}
                                    onChangeText={(value) => setTmuxTmpDir(value.trim().length > 0 ? value : null)}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>
                        )}
                    </>
                )}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.terminalConnect.title')}>
                <Item
                    title={t('settingsSession.terminalConnect.legacySecretExportTitle')}
                    subtitle={
                        terminalConnectLegacySecretExportEnabled
                            ? t('settingsSession.terminalConnect.legacySecretExportEnabledSubtitle')
                            : t('settingsSession.terminalConnect.legacySecretExportDisabledSubtitle')
                    }
                    icon={<Ionicons name="shield-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={terminalConnectLegacySecretExportEnabled}
                            onValueChange={setTerminalConnectLegacySecretExportEnabled}
                        />
                    }
                    showChevron={false}
                    onPress={() => setTerminalConnectLegacySecretExportEnabled(!terminalConnectLegacySecretExportEnabled)}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
        marginBottom: 4,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));
