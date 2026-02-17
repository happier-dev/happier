import { View, Pressable, Platform, Linking, Text as RNText, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import * as React from 'react';
import { Text } from '@/components/ui/text/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import Constants from 'expo-constants';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { useAuth } from '@/auth/context/AuthContext';
import { useEntitlement, useLocalSettingMutable, useSetting, useAllMachines, useProfile, useMachineListByServerId, useMachineListStatusByServerId } from '@/sync/domains/state/storage';
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
import { DEFAULT_AGENT_ID, getAgentCore, getAgentIconSource, getAgentIconTintColor, resolveAgentIdFromConnectedServiceId } from '@/agents/catalog/catalog';
import { resolveSupportUsAction } from '@/components/settings/supportUsBehavior';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useActiveSelectionMachineGroups } from '@/components/settings/server/hooks/useActiveSelectionMachineGroups';
import { ActiveSelectionMachinesSection } from '@/components/settings/server/sections/ActiveSelectionMachinesSection';

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const auth = useAuth();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const voiceEntitlement = useEntitlement('voice');
    const isPro = __DEV__ || voiceEntitlement;
    const usageReportingEnabled = useFeatureEnabled('usage.reporting');
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const connectedServicesEnabled = useFeatureEnabled('connected.services');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sourceControlEnabled = useFeatureEnabled('scm.writeOperations');
    const showChangelog = getFeatureBuildPolicyDecision('app.ui.changelog' as const satisfies FeatureId) !== 'deny';
    const useProfiles = useSetting('useProfiles');
    const terminalUseTmux = useSetting('sessionUseTmux');
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.enabled !== false;
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const settingsServerSelectionGroups = useSetting('serverSelectionGroups');
    const settingsServerSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const settingsServerSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');
    const activeServerSnapshot = getActiveServerSnapshot();
    const activeServerId = activeServerSnapshot.serverId;
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);

    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const activeSelectionMachineGroups = useActiveSelectionMachineGroups({
        activeServerSnapshot,
        allMachines,
        serverProfiles,
        machineListByServerId,
        machineListStatusByServerId,
        settings: {
            serverSelectionGroups: settingsServerSelectionGroups,
            serverSelectionActiveTargetKind: settingsServerSelectionActiveTargetKind,
            serverSelectionActiveTargetId: settingsServerSelectionActiveTargetId,
        },
    });

    const anthropicAgentId = resolveAgentIdFromConnectedServiceId('anthropic') ?? DEFAULT_AGENT_ID;
    const anthropicAgentCore = getAgentCore(anthropicAgentId);

    const showHiddenSettingsButtons = devModeEnabled;

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const [refreshingMachines, refreshMachines] = useHappyAction(async () => {
        await sync.refreshMachinesThrottled({ force: true });
    });

    useFocusEffect(
        React.useCallback(() => {
            void sync.refreshMachinesThrottled({ staleMs: 30_000 });
        }, [])
    );

    const machinesTitle = React.useMemo(() => {
        const headerTextStyle = [
            Typography.default('regular'),
            {
                color: theme.colors.groupped.sectionTitle,
                fontSize: Platform.select({ ios: 13, default: 14 }),
                lineHeight: Platform.select({ ios: 18, default: 20 }),
                letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
                textTransform: 'uppercase' as const,
                fontWeight: Platform.select({ ios: 'normal', default: '500' }) as any,
            },
        ];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <RNText style={headerTextStyle as any}>{t('settings.machines')}</RNText>
                <Pressable
                    onPress={refreshMachines}
                    hitSlop={10}
                    style={{ padding: 2 }}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh"
                    disabled={refreshingMachines}
                >
                    {refreshingMachines
                        ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        : <Ionicons name="refresh" size={18} color={theme.colors.textSecondary} />}
                </Pressable>
            </View>
        );
    }, [refreshMachines, refreshingMachines, theme.colors.groupped.sectionTitle, theme.colors.textSecondary]);

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
        router.push('/(app)/settings/report-issue');
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
            router.push(route);
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

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: 'happier://terminal?...',
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
                            icon={<Ionicons name="heart" size={29} color="#FF3B30" />}
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
                                <Image
                                    source={getAgentIconSource(anthropicAgentId)}
                                    style={{ width: 29, height: 29 }}
                                    tintColor={getAgentIconTintColor(anthropicAgentId, theme)}
                                    contentFit="contain"
                                />
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
                    icon={<Ionicons name="people-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            {/* Machines (grouped by server in multi-server mode) */}
            <ActiveSelectionMachinesSection
                hasAnyVisibleMachines={activeSelectionMachineGroups.hasAnyVisibleMachines}
                showMachinesGroupedByServer={activeSelectionMachineGroups.showMachinesGroupedByServer}
                visibleMachineGroups={activeSelectionMachineGroups.visibleMachineGroups}
                allMachines={allMachines}
                activeServerId={activeServerId}
                machinesTitle={machinesTitle}
                themeColors={{
                    textSecondary: theme.colors.textSecondary,
                    status: {
                        connected: theme.colors.status.connected,
                        disconnected: theme.colors.status.disconnected,
                    },
                }}
                onOpenMachine={(machineId, serverId) => {
                    const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
                    router.push(`/machine/${machineId}${query}`);
                }}
            />

            {/* Features */}
            <ItemGroup title={t('settings.features')}>
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/(app)/settings/account')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/(app)/settings/appearance')}
                />
                <Item
                    title="Notifications"
                    subtitle="Push notification preferences"
                    icon={<Ionicons name="notifications-outline" size={29} color="#0A84FF" />}
                    onPress={() => router.push('/(app)/settings/notifications')}
                />
                {voiceEnabled ? (
                    <Item
                        title={t('settings.voiceAssistant')}
                        subtitle={t('settings.voiceAssistantSubtitle')}
                        icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                        onPress={() => router.push('/(app)/settings/voice')}
                    />
                ) : null}
                {memorySearchEnabled ? (
                    <Item
                        title={t('settings.memorySearch')}
                        subtitle={t('settings.memorySearchSubtitle')}
                        icon={<Ionicons name="search-outline" size={29} color="#34C759" />}
                        onPress={() => router.push('/(app)/settings/memory')}
                    />
                ) : null}
                <Item
                    title={t('settings.featuresTitle')}
                    subtitle={t('settings.featuresSubtitle')}
                    icon={<Ionicons name="flask-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/(app)/settings/features')}
                />
                <Item
                    title={t('settings.session')}
                    subtitle={terminalUseTmux ? t('settings.sessionSubtitleTmuxEnabled') : t('settings.sessionSubtitleMessageSendingAndTmux')}
                    icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/(app)/settings/session')}
                />
                <Item
                    title={t('settings.servers')}
                    subtitle={t('settings.serversSubtitle')}
                    icon={<Ionicons name="server-outline" size={29} color="#0A84FF" />}
                    onPress={() => router.push('/server')}
                />
                {sourceControlEnabled ? (
                    <Item
                        title="Source control"
                        subtitle="Commit strategy and backend behavior"
                        icon={<Ionicons name="git-branch-outline" size={29} color="#34C759" />}
                        onPress={() => router.push('/(app)/settings/source-control')}
                    />
                ) : null}
                {showAutomations ? (
                    <Item
                        title="Automations"
                        subtitle="Manage scheduled sessions and recurring runs"
                        icon={<Ionicons name="timer-outline" size={29} color="#0A84FF" />}
                        onPress={() => router.push('/automations')}
                    />
                ) : null}
                {executionRunsEnabled ? (
                    <Item
                        title={t('runs.title') ?? 'Runs'}
                        subtitle="Execution runs across machines"
                        icon={<Ionicons name="play-outline" size={29} color="#34C759" />}
                        onPress={() => router.push('/runs')}
                    />
                ) : null}
                <Item
                    title={t('settingsProviders.title')}
                    subtitle={t('settingsProviders.entrySubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                    onPress={() => router.push('/(app)/settings/providers')}
                />
                {connectedServicesEnabled ? (
                    <Item
                        title={'Connected services'}
                        subtitle={'Claude/Codex subscriptions and OAuth profiles'}
                        icon={<Ionicons name="key-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/(app)/settings/connected-services')}
                    />
                ) : null}
                {useProfiles && (
                    <Item
                        title={t('settings.profiles')}
                        subtitle={t('settings.profilesSubtitle')}
                        icon={<Ionicons name="person-outline" size={29} color="#AF52DE" />}
                        onPress={() => router.push('/(app)/settings/profiles')}
                    />
                )}
                {useProfiles && (
                    <Item
                        title={t('settings.secrets')}
                        subtitle={t('settings.secretsSubtitle')}
                        icon={<Ionicons name="key-outline" size={29} color="#AF52DE" />}
                        onPress={() => router.push('/(app)/settings/secrets')}
                    />
                )}
                {usageReportingEnabled && (
                    <Item
                        title={t('settings.usage')}
                        subtitle={t('settings.usageSubtitle')}
                        icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push('/(app)/settings/usage')}
                    />
                )}
            </ItemGroup>

            {/* Developer */}
            {(__DEV__ || devModeEnabled) && (
                <ItemGroup title={t('settings.developer')}>
                    <Item
                        title={t('settings.developerTools')}
                        icon={<Ionicons name="construct-outline" size={29} color="#5856D6" />}
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
                        icon={<Ionicons name="sparkles-outline" size={29} color="#FF9500" />}
                        onPress={() => {
                            trackWhatsNewClicked();
                            router.push('/(app)/changelog');
                        }}
                    />
                ) : null}
                <Item
                    title={t('settings.github')}
                    icon={<Ionicons name="logo-github" size={29} color={theme.colors.text} />}
                    detail="happier-dev/happier"
                    onPress={handleGitHub}
                />
                <Item
                    title={t('settings.reportIssue')}
                    icon={<Ionicons name="bug-outline" size={29} color="#FF3B30" />}
                    onPress={handleReportIssue}
                />
                <Item
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color="#007AFF" />}
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
                    icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
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
                        icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
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
