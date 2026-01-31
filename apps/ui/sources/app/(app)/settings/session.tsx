import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, TextInput, Platform } from 'react-native';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/storage';
import type { MessageSendMode } from '@/sync/submitMode';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/permissionModeOptions';
import type { PermissionMode } from '@/sync/permissionTypes';
import { useEnabledAgentIds } from '@/agents/useEnabledAgentIds';
import { getAgentCore, type AgentId } from '@/agents/catalog';

type ToolViewDetailLevel = 'title' | 'summary' | 'full';

const TOOL_DETAIL_LEVEL_OPTIONS: Array<{ key: ToolViewDetailLevel; title: string; subtitle: string }> = [
    { key: 'title', title: 'Title only', subtitle: 'Show only the tool name (no body) in the timeline.' },
    { key: 'summary', title: 'Summary', subtitle: 'Show a compact, safe summary in the timeline.' },
    { key: 'full', title: 'Full', subtitle: 'Show full details inline in the timeline.' },
];

const TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS: Array<{ key: ToolViewDetailLevel | 'default'; title: string; subtitle: string }> = [
    { key: 'default', title: 'Default', subtitle: 'Use the global default.' },
    ...TOOL_DETAIL_LEVEL_OPTIONS,
];

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

    const [toolViewDetailLevelDefault, setToolViewDetailLevelDefault] = useSettingMutable('toolViewDetailLevelDefault');
    const [toolViewDetailLevelDefaultLocalControl, setToolViewDetailLevelDefaultLocalControl] = useSettingMutable('toolViewDetailLevelDefaultLocalControl');
    const [toolViewDetailLevelByToolName, setToolViewDetailLevelByToolName] = useSettingMutable('toolViewDetailLevelByToolName');
    const [toolViewShowDebugByDefault, setToolViewShowDebugByDefault] = useSettingMutable('toolViewShowDebugByDefault');

    const enabledAgentIds = useEnabledAgentIds();

    const [defaultPermissionByAgent, setDefaultPermissionByAgent] = useSettingMutable('sessionDefaultPermissionModeByAgent');
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

    const options: Array<{ key: MessageSendMode; title: string; subtitle: string }> = [
        {
            key: 'agent_queue',
            title: 'Queue in agent (current)',
            subtitle: 'Write to transcript immediately; agent processes when ready.',
        },
        {
            key: 'interrupt',
            title: 'Interrupt & send',
            subtitle: 'Abort current turn, then send immediately.',
        },
        {
            key: 'server_pending',
            title: 'Pending until ready',
            subtitle: 'Keep messages in a pending queue; agent pulls when ready.',
        },
    ];

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup title="Message sending" footer="Controls what happens when you send a message while the agent is running.">
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

            <ItemGroup
                title="Tool rendering"
                footer="Controls how much tool detail is shown in the session timeline. This is a UI preference; it does not change agent behavior."
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
                            title="Default tool detail level"
                            subtitle={TOOL_DETAIL_LEVEL_OPTIONS.find((opt) => opt.key === toolViewDetailLevelDefault)?.title ?? String(toolViewDetailLevelDefault)}
                            icon={<Ionicons name="construct-outline" size={29} color="#007AFF" />}
                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                            onPress={toggle}
                            showChevron={false}
                            selected={false}
                        />
                    )}
                    items={TOOL_DETAIL_LEVEL_OPTIONS.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
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
                            title="Local-control default"
                            subtitle={TOOL_DETAIL_LEVEL_OPTIONS.find((opt) => opt.key === toolViewDetailLevelDefaultLocalControl)?.title ?? String(toolViewDetailLevelDefaultLocalControl)}
                            icon={<Ionicons name="shield-outline" size={29} color="#FF9500" />}
                            rightElement={<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />}
                            onPress={toggle}
                            showChevron={false}
                            selected={false}
                        />
                    )}
                    items={TOOL_DETAIL_LEVEL_OPTIONS.map((opt) => ({
                        id: opt.key,
                        title: opt.title,
                        subtitle: opt.subtitle,
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
                    title="Show debug by default"
                    subtitle="Auto-expand raw tool payloads in the full tool view."
                    icon={<Ionicons name="code-slash-outline" size={29} color="#5856D6" />}
                    rightElement={<Switch value={toolViewShowDebugByDefault} onValueChange={setToolViewShowDebugByDefault} />}
                    showChevron={false}
                    onPress={() => setToolViewShowDebugByDefault(!toolViewShowDebugByDefault)}
                />
            </ItemGroup>

            <ItemGroup
                title="Tool detail overrides"
                footer="Override the detail level for specific tools. Overrides apply to the canonical tool name (V2), after legacy normalization."
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
                                    subtitle={TOOL_DETAIL_LEVEL_WITH_DEFAULT_OPTIONS.find((opt) => opt.key === selected)?.title ?? String(selected)}
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
                                title: opt.title,
                                subtitle: opt.subtitle,
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

            <ItemGroup title="Default permissions" footer="Applies when starting a new session. Profiles can optionally override this.">
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
