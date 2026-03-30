import { View, Pressable, Platform, Linking, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import * as React from 'react';
import { Text } from '@/components/ui/text/Text';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import Constants from 'expo-constants';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { DependabotIcon } from '@/components/ui/icons/DependabotIcon';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { useAuth } from '@/auth/context/AuthContext';
import { useEntitlement, useLocalSettingMutable, useSetting, useProfile } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked, trackWhatsNewClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/ui/useMultiClick';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { disconnectVendorToken } from '@/sync/api/account/apiVendorTokens';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/domains/profiles/profile';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { t } from '@/text';
import { canRequestReview, requestReview } from '@/utils/system/requestReview';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromConnectedServiceId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveSupportUsAction } from '@/components/settings/supportUsBehavior';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { DesktopSettingsSection } from '@/components/settings/desktop/DesktopSettingsSection';

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { width, height } = useWindowDimensions();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const voiceEntitlement = useEntitlement('voice');
    const isPro = __DEV__ || voiceEntitlement;
    const usageReportingEnabled = useFeatureEnabled('usage.reporting');
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sourceControlEnabled = useFeatureEnabled('scm.writeOperations');
    const attachmentsUploadsEnabled = useFeatureEnabled('attachments.uploads');
    const promptsLibraryEnabled = useFeatureEnabled('prompts.library');
    const mcpServersEnabled = useFeatureEnabled('mcp.servers');
    const showChangelog = getFeatureBuildPolicyDecision('app.ui.changelog' as const satisfies FeatureId) !== 'deny';
    const [showRateUs, setShowRateUs] = React.useState(false);
    const useProfiles = useSetting('useProfiles');
    const terminalUseTmux = useSetting('sessionUseTmux');
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.discoverable !== false;
    const automationsNeedLocalEnablement = automationsSupport?.blockedBy === 'local_policy';
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);
    const pushRoute = React.useCallback((route: Parameters<typeof router.push>[0]) => {
        deferOnWeb(() => {
            navigateWithBlurOnWeb(() => {
                router.push(route);
            });
        });
    }, [router]);

    const anthropicAgentId = resolveAgentIdFromConnectedServiceId('anthropic') ?? DEFAULT_AGENT_ID;
    const anthropicAgentCore = getAgentCore(anthropicAgentId);

    const showHiddenSettingsButtons = devModeEnabled;
    const showDesktopSettings = isTauriDesktop();

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    useFocusEffect(
        React.useCallback(() => {
            fireAndForget(sync.refreshMachinesThrottled({ staleMs: 30_000 }), { tag: 'SettingsView.refreshMachinesThrottled' });
        }, [])
    );

    React.useEffect(() => {
        let cancelled = false;

        const refreshRateUsAvailability = async () => {
            let available = false;
            try {
                available = await canRequestReview();
            } catch {
                available = false;
            }
            if (!cancelled) {
                setShowRateUs(available);
            }
        };

        void refreshRateUsAvailability();

        return () => {
            cancelled = true;
        };
    }, []);

    const handleGitHub = async () => {
        const url = 'https://github.com/happier-dev/happier';
        const supported = await Linking.canOpenURL(url);
        if (supported) {
            await Linking.openURL(url);
        }
    };

    const handleReportIssue = async () => {
        recordBugReportUserAction('settings.report_issue_open');
        const overrideUrl = String(process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL ?? '').trim();
        if (overrideUrl.length > 0) {
            const supported = await Linking.canOpenURL(overrideUrl);
            if (supported) {
                await Linking.openURL(overrideUrl);
                return;
            }
        }
        pushRoute('/(app)/settings/report-issue');
    };

    const handleSubscribe = async () => {
        trackPaywallButtonClicked();
        const result = await sync.presentPaywall();
        if (!result.success) {
            Modal.alert(t('common.error'), result.error || t('errors.unknownError'));
        }
    };

    const handleSupportUs = async () => {
        const action = resolveSupportUsAction({ isPro });
        if (action === 'github') {
            await handleGitHub();
            return;
        }
        await handleSubscribe();
    };

    // Use the multi-click hook for version clicks
    const handleVersionClick = useMultiClick(() => {
        // Toggle dev mode
        const newDevMode = !devModeEnabled;
        setDevModeEnabled(newDevMode);
        Modal.alert(
            t('modals.developerMode'),
            newDevMode ? t('modals.developerModeEnabled') : t('modals.developerModeDisabled')
        );
    }, {
        requiredClicks: 10,
        resetTimeout: 2000,
    });

    // Connection status
    const isAnthropicConnected = profile.connectedServices?.includes('anthropic') || false;

    // Anthropic connection
    const [connectingAnthropic, connectAnthropic] = useHappyAction(async () => {
        const route = anthropicAgentCore.connectedService.connectRoute;
        if (route) {
            pushRoute(route);
        }
    });

    // Anthropic disconnection
      const [disconnectingAnthropic, handleDisconnectAnthropic] = useHappyAction(async () => {
          const serviceName = anthropicAgentCore.connectedService.name;
          const confirmed = await Modal.confirm(
              t('modals.disconnectService', { service: serviceName }),
            t('modals.disconnectServiceConfirm', { service: serviceName }),
            { confirmText: t('modals.disconnect'), destructive: true }
          );
          if (confirmed) {
              if (!auth.credentials) {
                  Modal.alert(t('common.error'), t('errors.unknownError'), [{ text: t('common.ok') }]);
                  return;
              }
              await disconnectVendorToken(auth.credentials, 'anthropic');
              await sync.refreshProfile();
          }
      });

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
                    {profile.firstName ? (
                        // Profile view: Avatar + name + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Avatar
                                    id={profile.id}
                                    size={90}
                                    imageUrl={avatarUrl}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </View>
                            <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        // Logo view: Original logo + version
                        <>
                            <Image
                                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                                contentFit="contain"
                                style={{ width: 300, height: 90 }}
                            />
                        </>
                    )}
                </View>
            </View>

            {/* Add your phone (desktop/web only) */}
            {(isRunningOnMac() || (Platform.OS === 'web' && !isPhoneSizedWeb)) &&
            auth.isAuthenticated ? (
                <ItemGroup>
                    <Item
                        testID="settings-add-your-phone-shortcut"
                        title={t('settings.addYourPhone')}
                        subtitle={t('settings.addYourPhoneSubtitle')}
                        icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/settings/add-phone')}
                    />
                </ItemGroup>
            ) : null}

            {showDesktopSettings ? <DesktopSettingsSection /> : null}

            {/* Connect Terminal */}
            {!isRunningOnMac() && (Platform.OS !== 'web' || isPhoneSizedWeb) && (
                <ItemGroup>
                    <Item
                        testID="settings-connect-terminal-scan"
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        testID="settings-connect-terminal-enter-url"
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: t('connect.terminalUrlPlaceholder'),
                                    confirmText: t('common.authenticate')
                                }
                            );
                            if (url?.trim()) {
                                connectWithUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Hidden / unfinished buttons (toggle via Developer Mode) */}
            {showHiddenSettingsButtons && (
                <>
                    {/* Support Us */}
                    <ItemGroup>
                        <Item
                            title={t('settings.supportUs')}
                            subtitle={isPro ? t('settings.supportUsSubtitlePro') : t('settings.supportUsSubtitle')}
                            icon={<Ionicons name="heart" size={29} color={theme.colors.warningCritical} />}
                            showChevron={false}
                            onPress={handleSupportUs}
                        />
                    </ItemGroup>

                    <ItemGroup title={t('settings.connectedAccounts')}>
                        <Item
                            title={anthropicAgentCore.connectedService.name}
                            subtitle={isAnthropicConnected
                                ? t('settingsAccount.statusActive')
                                : t('settings.connectAccount')
                            }
                            icon={
                                <AgentIcon agentId={anthropicAgentId} size={29} />
                            }
                            onPress={isAnthropicConnected ? handleDisconnectAnthropic : connectAnthropic}
                            loading={connectingAnthropic || disconnectingAnthropic}
                            showChevron={false}
                        />
                    </ItemGroup>
                </>
            )}

            {/* Social */}
            {/* <ItemGroup title={t('settings.social')}>
                <Item
                    title={t('navigation.friends')}
                    subtitle={t('friends.manageFriends')}
                    icon={<Ionicons name="people-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            {/* Profile & Account */}
            <ItemGroup title={t('settings.profileAndAccount')}>
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/(app)/settings/account')}
                />
                {useProfiles && (
                    <Item
                        title={t('settings.secrets')}
                        subtitle={t('settings.secretsSubtitle')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.accent.purple} />}
                        onPress={() => router.push('/(app)/settings/secrets')}
                    />
                )}
                {usageReportingEnabled && (
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/(app)/settings/usage')}
                    />
                )}
                <Item
                    title={t('settings.machines')}
                    icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => pushRoute('/(app)/settings/machines')}
                />
            </ItemGroup>

            {/* General */}
            <ItemGroup title={t('settings.general')}>
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => pushRoute('/(app)/settings/appearance')}
                />
                <Item
                    title={t('settings.featuresTitle')}
                    subtitle={t('settings.featuresSubtitle')}
                    icon={<Ionicons name="flask-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => pushRoute('/(app)/settings/features')}
                />
            </ItemGroup>

            {/* AI & Agents */}
            <ItemGroup title={t('settings.aiAndAgents')}>
                <Item
                    title={t('settingsProviders.title')}
                    subtitle={t('settingsProviders.entrySubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => router.push('/(app)/settings/providers')}
                />
                <Item
                    title={t('subAgentGuidance.settings.groupTitle')}
                    subtitle={t('settingsSession.subAgentGuidanceEntry.openSubtitle')}
                    icon={(
                        <View style={{ width: 29, height: 29, alignItems: 'center', justifyContent: 'center' }}>
                            <DependabotIcon size={22} color={theme.colors.accent.orange} />
                        </View>
                    )}
                    onPress={() => router.push('/(app)/settings/sub-agent')}
                />
                {useProfiles && (
                    <Item
                        title={t('settings.profiles')}
                        subtitle={t('settings.profilesSubtitle')}
                        icon={<Ionicons name="person-outline" size={29} color={theme.colors.accent.purple} />}
                        onPress={() => router.push('/(app)/settings/profiles')}
                    />
                )}
                {connectedServicesEnabled ? (
                    <Item
                        title={t('settings.connectedServices')}
                        subtitle={t('settings.connectedServicesSubtitle')}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/(app)/settings/connected-services')}
                    />
                ) : null}
                {mcpServersEnabled && (
                    <Item
                        testID="settings-mcp-servers-item"
                        title={t('settings.mcpServers')}
                        subtitle={t('settings.mcpServersSubtitle')}
                        icon={<Ionicons name="extension-puzzle-outline" size={29} color={theme.colors.accent.purple} />}
                        // `router.push` expects the public route (group segments like `/(app)` are not valid here on web).
                        onPress={() => router.push('/settings/mcp')}
                    />
                )}
                {promptsLibraryEnabled ? (
                    <Item
                        title={t('settings.prompts')}
                        subtitle={t('settings.promptsSubtitle')}
                        icon={<Ionicons name="library-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/(app)/settings/prompts')}
                    />
                ) : null}
                {voiceEnabled ? (
                    <Item
                        title={t('settings.voiceAssistant')}
                        subtitle={t('settings.voiceAssistantSubtitle')}
                        icon={<Ionicons name="mic-outline" size={29} color={theme.colors.success} />}
                        onPress={() => router.push('/(app)/settings/voice')}
                    />
                ) : null}
                {memorySearchEnabled ? (
                    <Item
                        title={t('settings.memorySearch')}
                        subtitle={t('settings.memorySearchSubtitle')}
                        icon={<Ionicons name="search-outline" size={29} color={theme.colors.success} />}
                        onPress={() => router.push('/(app)/settings/memory')}
                    />
                ) : null}
            </ItemGroup>

            {/* Sessions & Behavior */}
            <ItemGroup title={t('settings.sessionsBehavior')}>
                <Item
                    title={t('settings.sessions')}
                    subtitle={terminalUseTmux ? t('settings.sessionSubtitleTmuxEnabled') : t('settings.sessionSubtitleMessageSendingAndTmux')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push('/(app)/settings/session')}
                />
                <Item
                    title={t('common.actions')}
                    subtitle={t('settings.actionsSubtitle')}
                    icon={<Ionicons name="flash-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => router.push('/(app)/settings/actions')}
                />
                <Item
                    title={t('settings.transcript')}
                    subtitle={t('settings.transcriptSubtitle')}
                    icon={<Ionicons name="chatbubbles-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push('/(app)/settings/session/transcript')}
                />
                <Item
                    title={t('settings.permissions')}
                    subtitle={t('settings.permissionsSubtitle')}
                    icon={<Ionicons name="shield-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push('/(app)/settings/session/permissions')}
                />
                {showAutomations ? (
                    <Item
                        title={t('settings.automations')}
                        subtitle={automationsNeedLocalEnablement
                            ? t('settingsFeatures.expAutomationsSubtitle')
                            : t('settings.automationsSubtitle')}
                        icon={<Ionicons name="timer-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push(automationsNeedLocalEnablement ? '/(app)/settings/features' : '/automations')}
                    />
                ) : null}
                {executionRunsEnabled ? (
                    <Item
                        title={t('runs.title')}
                        subtitle={t('settings.executionRunsSubtitle')}
                        icon={<Ionicons name="play-outline" size={29} color={theme.colors.success} />}
                        onPress={() => router.push('/runs')}
                    />
                ) : null}
            </ItemGroup>

            {/* Files & Source Control */}
            <ItemGroup title={t('settings.filesAndSourceControl')}>
                {sourceControlEnabled ? (
                    <Item
                        title={t('settings.filesSourceControl')}
                        subtitle={t('settings.filesSourceControlSubtitle')}
                        icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.success} />}
                        onPress={() => router.push('/(app)/settings/source-control')}
                    />
                ) : null}
                {attachmentsUploadsEnabled ? (
                    <Item
                        title={t('settings.attachments')}
                        subtitle={t('settings.attachmentsSubtitle')}
                        icon={<Ionicons name="attach-outline" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/(app)/settings/attachments')}
                    />
                ) : null}
            </ItemGroup>

            {/* System */}
            <ItemGroup title={t('settings.system')}>
                <Item
                    title={t('settings.servers')}
                    subtitle={t('settings.serversSubtitle')}
                    icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/server')}
                />
                <Item
                    testID="settings-system-status-item"
                    title={t('settings.systemStatus')}
                    subtitle={t('settings.systemStatusSubtitle')}
                    icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push('/(app)/settings/system-status')}
                />
                <Item
                    title={t('settings.notifications')}
                    subtitle={t('settings.notificationsSubtitle')}
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/(app)/settings/notifications')}
                />
            </ItemGroup>

            {/* Developer */}
            {(__DEV__ || devModeEnabled) && (
                <ItemGroup title={t('settings.developer')}>
                    <Item
                        title={t('settings.developerTools')}
                        icon={<Ionicons name="construct-outline" size={29} color={theme.colors.accent.indigo} />}
                        onPress={() => router.push('/(app)/dev')}
                    />
                </ItemGroup>
            )}

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                {showChangelog ? (
                    <Item
                        title={t('settings.whatsNew')}
                        subtitle={t('settings.whatsNewSubtitle')}
                        icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />}
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
                        icon={<Ionicons name="star-outline" size={29} color={theme.colors.accent.orange} />}
                        onPress={() => {
                            void requestReview();
                        }}
                    />
                ) : null}
                <Item
                    title={t('settings.github')}
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    subtitle="happier-dev/happier"
                    onPress={handleGitHub}
                />
                <Item
                    title={t('settings.reportIssue')}
                    icon={<Ionicons name="bug-outline" size={29} color={theme.colors.warningCritical} />}
                    onPress={handleReportIssue}
                />
                <Item
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.accent.blue} />}
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
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />}
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
                        icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />}
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
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={handleVersionClick}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
