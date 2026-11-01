import { View, Platform, Linking } from 'react-native';
import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { trackWhatsNewClicked } from '@/track';
import { requestReview } from '@/utils/system/requestReview';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';

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
                detail={appVersion}
                icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                onPress={handleVersionClick}
                showChevron={false}
            />
        </ItemGroup>
    );
});
