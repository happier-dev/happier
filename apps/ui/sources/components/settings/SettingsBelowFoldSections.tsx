import { View, Platform, Linking, Animated } from 'react-native';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { trackWhatsNewClicked } from '@/track';
import { requestReview } from '@/utils/system/requestReview';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { useAllMachines, useSettings } from '@/sync/domains/state/storage';
import { listConnectedDevices } from '@/sync/domains/settings/connectedDevices';
import { readCurrentAppRuntimeInfo } from '@/sync/runtime/readCurrentAppRuntimeInfo';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Modal } from '@/modal';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';

type SettingsBelowFoldSectionsRouter = ReturnType<typeof useRouter>;
type SettingsBelowFoldSectionsTheme = ReturnType<typeof useUnistyles>['theme'];

type SettingsBelowFoldSectionsProps = Readonly<{
    appVersion: string;
    attachmentsUploadsEnabled: boolean;
    automationsNeedLocalEnablement: boolean;
    connectedServicesEnabled: boolean;
    devModeEnabled: boolean;
    executionRunsEnabled: boolean;
    handleGitHub: () => void | Promise<void>;
    handleReportIssue: () => void | Promise<void>;
    handleVersionClick: () => void;
    mcpServersEnabled: boolean;
    memorySearchEnabled: boolean;
    promptsLibraryEnabled: boolean;
    router: SettingsBelowFoldSectionsRouter;
    showAutomations: boolean;
    showChangelog: boolean;
    showRateUs: boolean;
    sourceControlEnabled: boolean;
    stage: number;
    terminalUseTmux: boolean | null | undefined;
    theme: SettingsBelowFoldSectionsTheme;
    useProfiles: boolean | null | undefined;
    voiceEnabled: boolean;
}>;

export const SettingsBelowFoldSections = React.memo(function SettingsBelowFoldSections({
    appVersion,
    attachmentsUploadsEnabled,
    automationsNeedLocalEnablement,
    connectedServicesEnabled,
    devModeEnabled,
    executionRunsEnabled,
    handleGitHub,
    handleReportIssue,
    handleVersionClick,
    mcpServersEnabled,
    memorySearchEnabled,
    promptsLibraryEnabled,
    router,
    showAutomations,
    showChangelog,
    showRateUs,
    sourceControlEnabled,
    stage,
    terminalUseTmux,
    theme,
    useProfiles,
    voiceEnabled,
}: SettingsBelowFoldSectionsProps) {
    return (
        <>
            {stage >= 1 ? (
                <SettingsAiAndAgentsSection
                    connectedServicesEnabled={connectedServicesEnabled}
                    mcpServersEnabled={mcpServersEnabled}
                    memorySearchEnabled={memorySearchEnabled}
                    promptsLibraryEnabled={promptsLibraryEnabled}
                    router={router}
                    theme={theme}
                    useProfiles={useProfiles}
                    voiceEnabled={voiceEnabled}
                />
            ) : null}
            {stage >= 2 ? (
                <SettingsSessionsBehaviorSection
                    automationsNeedLocalEnablement={automationsNeedLocalEnablement}
                    executionRunsEnabled={executionRunsEnabled}
                    router={router}
                    showAutomations={showAutomations}
                    terminalUseTmux={terminalUseTmux}
                    theme={theme}
                />
            ) : null}
            {stage >= 3 ? (
                <>
                    <SettingsFilesAndSourceControlSection
                        attachmentsUploadsEnabled={attachmentsUploadsEnabled}
                        router={router}
                        sourceControlEnabled={sourceControlEnabled}
                        theme={theme}
                    />
                    <SettingsSystemSection router={router} theme={theme} />
                    <SettingsDeveloperSection devModeEnabled={devModeEnabled} router={router} theme={theme} />
                </>
            ) : null}
            {stage >= 4 ? (
                <SettingsAboutSection
                    appVersion={appVersion}
                    handleGitHub={handleGitHub}
                    handleReportIssue={handleReportIssue}
                    handleVersionClick={handleVersionClick}
                    router={router}
                    showChangelog={showChangelog}
                    showRateUs={showRateUs}
                    theme={theme}
                />
            ) : null}
        </>
    );
});

type SettingsAiAndAgentsSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'connectedServicesEnabled'
    | 'mcpServersEnabled'
    | 'memorySearchEnabled'
    | 'promptsLibraryEnabled'
    | 'router'
    | 'theme'
    | 'useProfiles'
    | 'voiceEnabled'
>>;

const SettingsAiAndAgentsSection = React.memo(function SettingsAiAndAgentsSection({
    connectedServicesEnabled,
    mcpServersEnabled,
    memorySearchEnabled,
    promptsLibraryEnabled,
    router,
    theme,
    useProfiles,
    voiceEnabled,
}: SettingsAiAndAgentsSectionProps) {
    return (
        <ItemGroup title={t('settings.aiAndAgents')}>
            <Item
                title={t('settingsProviders.title')}
                subtitle={t('settingsProviders.entrySubtitle')}
                icon={<Icon name="sparkle" size={29} color={theme.colors.accent.orange} />}
                onPress={() => router.push('/settings/providers')}
            />
            <Item
                title={t('subAgentGuidance.settings.groupTitle')}
                subtitle={t('settingsSession.subAgentGuidanceEntry.openSubtitle')}
                icon={(
                    <View style={{ width: 29, height: 29, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="robot" size={ICON_SIZE.lg} color={theme.colors.accent.orange} />
                    </View>
                )}
                onPress={() => router.push('/settings/sub-agent')}
            />
            {useProfiles && (
                <Item
                    title={t('settings.profiles')}
                    subtitle={t('settings.profilesSubtitle')}
                    icon={<Icon name="person" size={29} color={theme.colors.accent.purple} />}
                    onPress={() => router.push('/settings/profiles')}
                />
            )}
            {connectedServicesEnabled ? (
                <Item
                    title={t('settings.connectedServices')}
                    subtitle={t('settings.connectedServicesSubtitle')}
                    icon={<Icon name="key" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/settings/connected-services')}
                />
            ) : null}
            {mcpServersEnabled && (
                <Item
                    testID="settings-mcp-servers-item"
                    title={t('settings.mcpServers')}
                    subtitle={t('settings.mcpServersSubtitle')}
                    icon={<Icon name="puzzle-piece" size={29} color={theme.colors.accent.purple} />}
                    onPress={() => router.push('/settings/mcp')}
                />
            )}
            {promptsLibraryEnabled ? (
                <Item
                    testID="settings-prompts"
                    title={t('settings.prompts')}
                    subtitle={t('settings.promptsSubtitle')}
                    icon={<Icon name="books" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/settings/prompts')}
                />
            ) : null}
            {voiceEnabled ? (
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<Icon name="microphone" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/settings/voice')}
                />
            ) : null}
            {memorySearchEnabled ? (
                <Item
                    title={t('settings.memorySearch')}
                    subtitle={t('settings.memorySearchSubtitle')}
                    icon={<Icon name="magnifying-glass" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/settings/memory')}
                />
            ) : null}
        </ItemGroup>
    );
});

type SettingsSessionsBehaviorSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'automationsNeedLocalEnablement'
    | 'executionRunsEnabled'
    | 'router'
    | 'showAutomations'
    | 'terminalUseTmux'
    | 'theme'
>>;

const SettingsSessionsBehaviorSection = React.memo(function SettingsSessionsBehaviorSection({
    automationsNeedLocalEnablement,
    executionRunsEnabled,
    router,
    showAutomations,
    terminalUseTmux,
    theme,
}: SettingsSessionsBehaviorSectionProps) {
    return (
        <ItemGroup title={t('settings.sessionsBehavior')}>
            <Item
                title={t('settings.sessions')}
                subtitle={terminalUseTmux ? t('settings.sessionSubtitleTmuxEnabled') : t('settings.sessionSubtitleMessageSendingAndTmux')}
                icon={<Icon name="terminal" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/settings/session')}
            />
            <Item
                title={t('common.actions')}
                subtitle={t('settings.actionsSubtitle')}
                icon={<Icon name="lightning" size={29} color={theme.colors.accent.orange} />}
                onPress={() => router.push('/settings/actions')}
            />
            <Item
                title={t('settings.transcript')}
                subtitle={t('settings.transcriptSubtitle')}
                icon={<Icon name="chats-circle" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/settings/session/transcript')}
            />
            <Item
                title={t('settings.permissions')}
                subtitle={t('settings.permissionsSubtitle')}
                icon={<Icon name="shield" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/settings/session/permissions')}
            />
            {showAutomations ? (
                <Item
                    title={t('settings.automations')}
                    subtitle={automationsNeedLocalEnablement
                        ? t('settingsFeatures.expAutomationsSubtitle')
                        : t('settings.automationsSubtitle')}
                    icon={<Icon name="timer" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push(automationsNeedLocalEnablement ? '/settings/features' : '/automations')}
                />
            ) : null}
            {executionRunsEnabled ? (
                <Item
                    title={t('runs.title')}
                    subtitle={t('settings.executionRunsSubtitle')}
                    icon={<Icon name="play" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/runs')}
                />
            ) : null}
        </ItemGroup>
    );
});

type SettingsFilesAndSourceControlSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'attachmentsUploadsEnabled'
    | 'router'
    | 'sourceControlEnabled'
    | 'theme'
>>;

const SettingsFilesAndSourceControlSection = React.memo(function SettingsFilesAndSourceControlSection({
    attachmentsUploadsEnabled,
    router,
    sourceControlEnabled,
    theme,
}: SettingsFilesAndSourceControlSectionProps) {
    return (
        <ItemGroup title={t('settings.filesAndSourceControl')}>
            {sourceControlEnabled ? (
                <Item
                    title={t('settings.filesSourceControl')}
                    subtitle={t('settings.filesSourceControlSubtitle')}
                    icon={<Icon name="git-branch" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={() => router.push('/settings/source-control')}
                />
            ) : null}
            {attachmentsUploadsEnabled ? (
                <Item
                    title={t('settings.attachments')}
                    subtitle={t('settings.attachmentsSubtitle')}
                    icon={<Icon name="paperclip" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/settings/attachments')}
                />
            ) : null}
        </ItemGroup>
    );
});

type SettingsSystemSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps, 'router' | 'theme'>>;

const SettingsSystemSection = React.memo(function SettingsSystemSection({ router, theme }: SettingsSystemSectionProps) {
    return (
        <ItemGroup title={t('settings.system')}>
            <Item
                title={t('settings.servers')}
                subtitle={t('settings.serversSubtitle')}
                icon={<Icon name="hard-drives" size={29} color={theme.colors.accent.blue} />}
                onPress={() => router.push('/settings/server')}
            />
            <Item
                testID="settings-system-status-item"
                title={t('settings.systemStatus')}
                subtitle={t('settings.systemStatusSubtitle')}
                icon={<Icon name="pulse" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/settings/system-status')}
            />
            <Item
                title={t('settings.notifications')}
                subtitle={t('settings.notificationsSubtitle')}
                icon={<Icon name="bell" size={29} color={theme.colors.accent.blue} />}
                onPress={() => router.push('/settings/notifications')}
            />
        </ItemGroup>
    );
});

type SettingsDeveloperSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'devModeEnabled'
    | 'router'
    | 'theme'
>>;

const SettingsDeveloperSection = React.memo(function SettingsDeveloperSection({
    devModeEnabled,
    router,
    theme,
}: SettingsDeveloperSectionProps) {
    if (!__DEV__ && !devModeEnabled) return null;

    return (
        <ItemGroup title={t('settings.developer')}>
            <Item
                title={t('settings.developerTools')}
                icon={<Icon name="wrench" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => router.push('/(app)/dev')}
            />
        </ItemGroup>
    );
});

type SettingsAboutSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'appVersion'
    | 'handleGitHub'
    | 'handleReportIssue'
    | 'handleVersionClick'
    | 'router'
    | 'showChangelog'
    | 'showRateUs'
    | 'theme'
>>;

const SettingsAboutSection = React.memo(function SettingsAboutSection({
    appVersion,
    handleGitHub,
    handleReportIssue,
    handleVersionClick,
    router,
    showChangelog,
    showRateUs,
    theme,
}: SettingsAboutSectionProps) {
    const machines = useAllMachines();
    const settings = useSettings();
    const [serverVersion, setServerVersion] = React.useState<string | null>(null);
    const [desktopVersion, setDesktopVersion] = React.useState<string | null>(null);
    const [showVersionCopiedToast, setShowVersionCopiedToast] = React.useState(false);
    const versionCopiedToastOpacity = React.useRef(new Animated.Value(0)).current;
    const versionCopiedToastAnimation = React.useRef<Animated.CompositeAnimation | null>(null);
    const versionCopiedToastPause = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const showCopiedToast = React.useCallback(() => {
        versionCopiedToastAnimation.current?.stop();
        if (versionCopiedToastPause.current) clearTimeout(versionCopiedToastPause.current);
        versionCopiedToastPause.current = null;
        versionCopiedToastOpacity.setValue(0);
        setShowVersionCopiedToast(true);
        const fadeIn = Animated.timing(versionCopiedToastOpacity, { toValue: 1, duration: 120, useNativeDriver: false });
        versionCopiedToastAnimation.current = fadeIn;
        fadeIn.start(({ finished }) => {
            if (!finished) return;
            versionCopiedToastPause.current = setTimeout(() => {
                versionCopiedToastPause.current = null;
                const fadeOut = Animated.timing(versionCopiedToastOpacity, { toValue: 0, duration: 180, useNativeDriver: false });
                versionCopiedToastAnimation.current = fadeOut;
                fadeOut.start(({ finished: fadeOutFinished }) => {
                    if (fadeOutFinished) setShowVersionCopiedToast(false);
                });
            }, 900);
        });
    }, [versionCopiedToastOpacity]);

    React.useEffect(() => () => {
        versionCopiedToastAnimation.current?.stop();
        if (versionCopiedToastPause.current) clearTimeout(versionCopiedToastPause.current);
    }, []);
    const runtime = React.useMemo(() => readCurrentAppRuntimeInfo(), []);

    React.useEffect(() => {
        if (!isTauriDesktop()) return;
        let cancelled = false;
        void invokeTauri<{ version: string }>('desktop_client_identity').then((identity) => {
            if (!cancelled) setDesktopVersion(identity.version || null);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        const load = (snapshot: ReturnType<typeof getActiveServerSnapshot>) => {
            setServerVersion(null);
            const url = snapshot.serverUrl.replace(/\/$/, '');
            if (!url) return;
            void runtimeFetch(`${url}/v1/version`).then(async (response) => {
                if (!response.ok) return;
                const data: unknown = await response.json();
                if (!cancelled && getActiveServerSnapshot().generation === snapshot.generation && data && typeof data === 'object' && 'version' in data && typeof data.version === 'string') {
                    const source = 'source_sha' in data && typeof data.source_sha === 'string' ? data.source_sha : null;
                    setServerVersion([data.version, source].filter(Boolean).join(' / '));
                }
            }).catch(() => {});
        };
        const unsubscribe = subscribeActiveServer(load);
        load(getActiveServerSnapshot());
        return () => { cancelled = true; unsubscribe(); };
    }, []);

    const versionDetails = [
        `${t('systemStatus.application.appVersion')}: ${runtime.appVersion ?? appVersion}`,
        ...(desktopVersion ? [`${t('systemStatus.application.nativeVersion')}: ${desktopVersion}`] : []),
        ...(runtime.nativeApplicationVersion ? [`${t('systemStatus.application.nativeVersion')}: ${runtime.nativeApplicationVersion}`] : []),
        ...(runtime.nativeBuildVersion ? [`${t('systemStatus.application.buildNumber')}: ${runtime.nativeBuildVersion}`] : []),
        ...(runtime.runtimeVersion ? [`${t('systemStatus.application.runtimeVersion')}: ${runtime.runtimeVersion}`] : []),
        `${t('settings.servers')}: ${serverVersion ?? t('status.unknown')}`,
        ...machines.filter((machine) => machine.metadata?.happyCliVersion).map((machine) =>
            `${t('settings.machines')} (${machine.metadata?.displayName || machine.metadata?.host || machine.id}): ${machine.metadata?.happyCliVersion}`),
        `${t('settings.connectedDevicesLast14Days')}:`,
        ...listConnectedDevices(settings, Date.now()).map((device) =>
            `${device.name ?? t('status.unknown')} | ${device.platform} | ${device.appVersion ?? t('status.unknown')} | ${new Date(device.lastSeen).toISOString()}`),
    ].join('\n');

    return (
        <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
            {showChangelog ? (
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<Icon name="sparkle" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => {
                        trackWhatsNewClicked();
                        router.push('/(app)/changelog');
                    }}
                />
            ) : null}
            {showRateUs ? (
                <Item
                    title={t('settings.rateUs')}
                    subtitle={t('settings.rateUsSubtitle')}
                    icon={<Icon name="star" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => {
                        void requestReview();
                    }}
                />
            ) : null}
            <Item
                title={t('settings.github')}
                icon={<Icon name="github-logo" size={29} color={theme.colors.text.primary} />}
                subtitle="happier-dev/happier"
                onPress={handleGitHub}
            />
            <Item
                title={t('settings.reportIssue')}
                icon={<Icon name="bug" size={29} color={theme.colors.state.danger.foreground} />}
                onPress={handleReportIssue}
            />
            <Item
                title={t('settings.privacyPolicy')}
                icon={<Icon name="shield-check" size={29} color={theme.colors.accent.blue} />}
                onPress={async () => {
                    const url = 'https://docs.happier.dev/legal/privacy';
                    const supported = await Linking.canOpenURL(url);
                    if (supported) {
                        await Linking.openURL(url);
                    }
                }}
            />
            <Item
                title={t('settings.termsOfService')}
                icon={<Icon name="file-text" size={29} color={theme.colors.accent.blue} />}
                onPress={async () => {
                    const url = 'https://docs.happier.dev/legal/terms';
                    const supported = await Linking.canOpenURL(url);
                    if (supported) {
                        await Linking.openURL(url);
                    }
                }}
            />
            {Platform.OS === 'ios' && (
                <Item
                    title={t('settings.eula')}
                    icon={<Icon name="file-text" size={29} color={theme.colors.accent.blue} />}
                    onPress={async () => {
                        const url = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
            )}
            <Item
                title={t('common.version')}
                subtitle={versionDetails}
                subtitleAccessory={showVersionCopiedToast ? (
                    <Animated.View style={{ opacity: versionCopiedToastOpacity }}>
                        <CopiedPill
                            visible
                            label={`${t('common.copied')}!`}
                            testID="settings-version-copied-toast"
                        />
                    </Animated.View>
                ) : null}
                icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                onPress={() => {
                    handleVersionClick();
                    void setClipboardStringSafe(versionDetails).then((copied) => {
                        if (!copied) {
                            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
                            return;
                        }
                        showCopiedToast();
                    });
                }}
                showChevron={false}
            />
        </ItemGroup>
    );
});
