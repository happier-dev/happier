import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, Platform } from 'react-native';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import type { BusySteerSendPolicy, MessageSendMode } from '@/sync/domains/session/control/submitMode';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function SessionSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const popoverBoundaryRef = React.useRef<any>(null);
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const thinkingVisibilityEnabled = useFeatureEnabled('messages.thinkingVisibility');

    const [useTmux, setUseTmux] = useSettingMutable('sessionUseTmux');
    const [tmuxSessionName, setTmuxSessionName] = useSettingMutable('sessionTmuxSessionName');
    const [tmuxIsolated, setTmuxIsolated] = useSettingMutable('sessionTmuxIsolated');
    const [tmuxTmpDir, setTmuxTmpDir] = useSettingMutable('sessionTmuxTmpDir');

    const [messageSendMode, setMessageSendMode] = useSettingMutable('sessionMessageSendMode');
    const [busySteerSendPolicy, setBusySteerSendPolicy] = useSettingMutable('sessionBusySteerSendPolicy');

    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [agentInputHistoryScope, setAgentInputHistoryScope] = useSettingMutable('agentInputHistoryScope');

    const [sessionThinkingDisplayMode, setSessionThinkingDisplayMode] = useSettingMutable('sessionThinkingDisplayMode');

    const [terminalConnectLegacySecretExportEnabled, setTerminalConnectLegacySecretExportEnabled] = useSettingMutable('terminalConnectLegacySecretExportEnabled');

    const [sessionReplayEnabled, setSessionReplayEnabled] = useSettingMutable('sessionReplayEnabled');
    const [sessionReplayStrategy, setSessionReplayStrategy] = useSettingMutable('sessionReplayStrategy');
    const [sessionReplayRecentMessagesCount, setSessionReplayRecentMessagesCount] = useSettingMutable('sessionReplayRecentMessagesCount');

    const [sessionTagsEnabled, setSessionTagsEnabled] = useSettingMutable('sessionTagsEnabled');

    const [openHistoryScopeMenu, setOpenHistoryScopeMenu] = React.useState<boolean>(false);
    const [openReplayMenu, setOpenReplayMenu] = React.useState<boolean>(false);
    const [openThinkingDisplayMenu, setOpenThinkingDisplayMenu] = React.useState<boolean>(false);

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

    const thinkingDisplayOptions: Array<{ key: 'inline' | 'tool' | 'hidden'; title: string; subtitle: string }> = [
        {
            key: 'inline',
            title: t('settingsSession.thinking.displayMode.inlineTitle'),
            subtitle: t('settingsSession.thinking.displayMode.inlineSubtitle'),
        },
        {
            key: 'tool',
            title: t('settingsSession.thinking.displayMode.toolTitle'),
            subtitle: t('settingsSession.thinking.displayMode.toolSubtitle'),
        },
        {
            key: 'hidden',
            title: t('settingsSession.thinking.displayMode.hiddenTitle'),
            subtitle: t('settingsSession.thinking.displayMode.hiddenSubtitle'),
        },
    ];

    const normalizedHistoryScope = agentInputHistoryScope === 'global' ? 'global' : 'perSession';
    const historyScopeOptions: ReadonlyArray<{
        id: 'perSession' | 'global';
        title: string;
        subtitle: string;
        iconName: React.ComponentProps<typeof Ionicons>['name'];
    }> = [
        {
            id: 'perSession',
            title: t('settingsFeatures.historyScopePerSessionOption'),
            subtitle: t('settingsFeatures.historyScopePerSession'),
            iconName: 'repeat-outline',
        },
        {
            id: 'global',
            title: t('settingsFeatures.historyScopeGlobalOption'),
            subtitle: t('settingsFeatures.historyScopeGlobal'),
            iconName: 'globe-outline',
        },
    ];

    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.sessionList.title')} footer={t('settingsSession.sessionList.footer')}>
                <Item
                    title={t('settingsSession.sessionList.tagsTitle')}
                    subtitle={sessionTagsEnabled ? t('settingsSession.sessionList.tagsEnabledSubtitle') : t('settingsSession.sessionList.tagsDisabledSubtitle')}
                    icon={<Ionicons name="pricetag-outline" size={29} color={theme.colors.accent.blue} />}
                    rightElement={<Switch value={Boolean(sessionTagsEnabled)} onValueChange={setSessionTagsEnabled} />}
                    showChevron={false}
                    onPress={() => setSessionTagsEnabled(!sessionTagsEnabled)}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.messageSending.title')} footer={t('settingsSession.messageSending.footer')}>
                {options.map((option) => (
                    <Item
                        key={option.key}
                        title={option.title}
                        subtitle={option.subtitle}
                        icon={<Ionicons name="send-outline" size={29} color={theme.colors.accent.blue} />}
                        rightElement={messageSendMode === option.key ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
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
                            icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accent.blue} />}
                            rightElement={busySteerSendPolicy === option.key ? <Ionicons name="checkmark" size={20} color={theme.colors.accent.blue} /> : null}
                            onPress={() => setBusySteerSendPolicy(option.key)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {Platform.OS === 'web' ? (
                <ItemGroup
                    title={t('settingsFeatures.webFeatures')}
                    footer={t('settingsFeatures.webFeaturesDescription')}
                >
                    <Item
                        title={t('settingsFeatures.enterToSend')}
                        subtitle={agentInputEnterToSend ? t('settingsFeatures.enterToSendEnabled') : t('settingsFeatures.enterToSendDisabled')}
                        icon={<Ionicons name="return-down-forward-outline" size={29} color={theme.colors.accent.blue} />}
                        rightElement={<Switch value={agentInputEnterToSend} onValueChange={setAgentInputEnterToSend} />}
                        showChevron={false}
                        onPress={() => setAgentInputEnterToSend(!agentInputEnterToSend)}
                    />

                    <DropdownMenu
                        open={openHistoryScopeMenu}
                        onOpenChange={setOpenHistoryScopeMenu}
                        variant="selectable"
                        search={false}
                        selectedId={normalizedHistoryScope as any}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={popoverBoundaryRef}
                        itemTrigger={{
                            title: t('settingsFeatures.historyScope'),
                            icon: <Ionicons name="time-outline" size={29} color={theme.colors.accent.blue} />,
                        }}
                        items={historyScopeOptions.map((opt) => ({
                            id: opt.id,
                            title: opt.title,
                            subtitle: opt.subtitle,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name={opt.iconName as any} size={22} color={theme.colors.textSecondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            setAgentInputHistoryScope(id as any);
                            setOpenHistoryScopeMenu(false);
                        }}
                    />
                </ItemGroup>
            ) : null}

            {thinkingVisibilityEnabled ? (
                <ItemGroup title={t('settingsSession.thinking.title')} footer={t('settingsSession.thinking.footer')}>
                    <DropdownMenu
                        open={openThinkingDisplayMenu}
                        onOpenChange={setOpenThinkingDisplayMenu}
                        variant="selectable"
                        search={false}
                        selectedId={String(sessionThinkingDisplayMode ?? 'inline')}
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
                            id: opt.key,
                            title: opt.title,
                            subtitle: opt.subtitle,
                            icon: (
                                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="bulb-outline" size={22} color={theme.colors.textSecondary} />
                                </View>
                            ),
                        }))}
                        onSelect={(id) => {
                            setSessionThinkingDisplayMode(id as any);
                            setOpenThinkingDisplayMenu(false);
                        }}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('settingsSession.toolRendering.title')}
                footer={t('settingsSession.toolRendering.footer')}
            >
                <Item
                    title={t('settingsSession.toolRendering.title')}
                    subtitle={t('settingsSession.toolDetailOverrides.title')}
                    icon={<Ionicons name="construct-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/(app)/settings/session/tool-rendering')}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsSession.permissions.title')} footer={t('settingsSession.permissions.footer')}>
                <Item
                    title={t('settingsSession.permissions.title')}
                    subtitle={t('settingsSession.permissions.entrySubtitle')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.success} />}
                    onPress={() => router.push('/(app)/settings/session/permissions')}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsSession.replayResume.title')}
                footer={t('settingsSession.replayResume.footer')}
            >
                <Item
                    title={t('settingsSession.replayResume.enabledTitle')}
                    subtitle={sessionReplayEnabled ? t('settingsSession.replayResume.enabledSubtitleOn') : t('settingsSession.replayResume.enabledSubtitleOff')}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.success} />}
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
                            itemTrigger={{
                                title: t('settingsSession.replayResume.strategyTitle'),
                                icon: <Ionicons name="list-outline" size={29} color={theme.colors.success} />,
                            }}
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

            {executionRunsEnabled ? (
                <ItemGroup
                    title="Sub-agent"
                    footer="Configure delegation guidance rules (backend/model/intent hints) used by the main agent."
                >
                    <Item
                        title="Guidance rules"
                        subtitle="Open Sub-agent settings"
                        icon={<Ionicons name="git-network-outline" size={29} color={theme.colors.accent.orange} />}
                        onPress={() => router.push('/(app)/settings/sub-agent')}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title="Actions" footer="Enable actions per surface and placement (UI, voice, MCP) and control where they appear.">
                <Item
                    title="Actions"
                    subtitle="Open actions settings"
                    icon={<Ionicons name="flash-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => router.push('/(app)/settings/actions')}
                />
            </ItemGroup>

            <ItemGroup title={t('profiles.tmux.title')}>
                <Item
                    title={t('profiles.tmux.spawnSessionsTitle')}
                    subtitle={useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
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
                            icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />}
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

            <ItemGroup title={t('settingsSession.terminalConnect.title')} style={styles.sectionSpacerTop}>
                <Item
                    title={t('settingsSession.terminalConnect.legacySecretExportTitle')}
                    subtitle={
                        terminalConnectLegacySecretExportEnabled
                            ? t('settingsSession.terminalConnect.legacySecretExportEnabledSubtitle')
                            : t('settingsSession.terminalConnect.legacySecretExportDisabledSubtitle')
                    }
                    icon={<Ionicons name="shield-outline" size={29} color={theme.colors.accent.indigo} />}
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
    sectionSpacerTop: {
        marginTop: Platform.select({ ios: 8, default: 16 }),
    },
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
