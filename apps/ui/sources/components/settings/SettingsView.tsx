import { View, Pressable, Platform, Linking, useWindowDimensions } from 'react-native';
import * as React from 'react';
import { SafeExpoImage } from '@/components/ui/media/SafeExpoImage';
import { Text } from '@/components/ui/text/Text';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import Constants from 'expo-constants';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { useAuth } from '@/auth/context/AuthContext';
import { useEntitlement, useLocalSettingMutable, useSetting, useProfile } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/ui/useMultiClick';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/domains/profiles/profile';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { t } from '@/text';
import { canRequestReview } from '@/utils/system/requestReview';
import { resolveSupportUsAction } from '@/components/settings/supportUsBehavior';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { SettingsUsageSummaryStrip } from '@/components/settings/usage/SettingsUsageSummaryStrip';
import { useUsageBannerModel } from '@/components/settings/usage/useUsageBannerModel';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { SettingsBelowFoldSections } from '@/components/settings/SettingsBelowFoldSections';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { useScannedAuthUrlProcessor } from '@/hooks/auth/useScannedAuthUrlProcessor';
import { Icon } from '@/components/ui/icons/Icon';

const DEFER_BELOW_FOLD_SETTINGS_SECTIONS_DELAY_MS = 0;
const DEFER_BELOW_FOLD_SETTINGS_STAGE_DELAY_MS = 16;

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
    const showChangelog = getFeatureBuildPolicyDecision('app.ui.changelog' as const satisfies FeatureId) !== 'deny';
    const [showRateUs, setShowRateUs] = React.useState(false);
    const terminalUseTmux = useSetting('sessionUseTmux');
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.discoverable !== false;
    const automationsNeedLocalEnablement = automationsSupport?.blockedBy === 'local_policy';
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);
    const usageBanner = useUsageBannerModel(auth.credentials, usageReportingEnabled);
    const pushRoute = React.useCallback((route: Parameters<typeof router.push>[0]) => {
        deferOnWeb(() => {
            navigateWithBlurOnWeb(() => {
                router.push(route);
            });
        });
    }, [router]);
    const navigateCatalogRoute = React.useCallback((route: string) => {
        pushRoute(route as Parameters<typeof router.push>[0]);
    }, [pushRoute]);

    const showHiddenSettingsButtons = devModeEnabled;
    const [belowFoldSettingsStage, setBelowFoldSettingsStage] = React.useState(0);

    const { connectTerminal, isLoading } = useConnectTerminal();
    const { processAuthUrl } = useScannedAuthUrlProcessor();

    useFocusEffect(
        React.useCallback(() => {
            fireAndForget(sync.refreshMachinesThrottled({ staleMs: 30_000 }), { tag: 'SettingsView.refreshMachinesThrottled' });
        }, [])
    );

    React.useEffect(() => {
        if (belowFoldSettingsStage >= 4) return undefined;

        const nextStage = belowFoldSettingsStage + 1;
        const delayMs = belowFoldSettingsStage === 0
            ? DEFER_BELOW_FOLD_SETTINGS_SECTIONS_DELAY_MS
            : DEFER_BELOW_FOLD_SETTINGS_STAGE_DELAY_MS;
        let cancelStageTimer: (() => void) | undefined;

        const scheduleNextStage = () => {
            const timer = setTimeout(() => {
                setBelowFoldSettingsStage((currentStage) => Math.max(currentStage, nextStage));
            }, delayMs);
            cancelStageTimer = () => clearTimeout(timer);
        };

        if (belowFoldSettingsStage === 0) {
            const cancelInteractions = runAfterInteractionsWithFallback(scheduleNextStage);
            return () => {
                cancelStageTimer?.();
                cancelInteractions();
            };
        }

        scheduleNextStage();
        return () => {
            cancelStageTimer?.();
        };
    }, [belowFoldSettingsStage]);

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
        pushRoute(SETTINGS_ROUTES.reportIssue);
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

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface.base, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
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
                            <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text.primary, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        // Logo view: Original logo + version
                        <>
                            <SafeExpoImage
                                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                                contentFit="contain"
                                style={{ width: 300, height: 90 }}
                            />
                        </>
                    )}
                </View>
            </View>

            {usageReportingEnabled ? (
                <SettingsUsageSummaryStrip
                    viewModel={usageBanner.viewModel}
                    isLoading={usageBanner.isLoading}
                    errorMessage={usageBanner.errorMessage}
                    onOpenUsage={(target) => pushRoute(target)}
                />
            ) : null}

            {/* Add your phone (desktop/web only) */}
            {(isRunningOnMac() || (Platform.OS === 'web' && !isPhoneSizedWeb)) &&
            auth.isAuthenticated ? (
                <ItemGroup>
                    <Item
                        testID="settings-add-your-phone-shortcut"
                        title={t('settings.addYourPhone')}
                        subtitle={t('settings.addYourPhoneSubtitle')}
                        icon={<Icon name="device-mobile" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => router.push('/settings/add-phone')}
                    />
                </ItemGroup>
            ) : null}

            {/* Connect Terminal */}
            {!isRunningOnMac() && (Platform.OS !== 'web' || isPhoneSizedWeb) && (
                <ItemGroup>
                    <Item
                        testID="settings-connect-terminal-scan"
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Icon name="qr-code" size={29} color={theme.colors.accent.blue} />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        testID="settings-connect-terminal-enter-url"
                        title={t('connect.enterUrlManually')}
                        icon={<Icon name="link" size={29} color={theme.colors.accent.blue} />}
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
                                await processAuthUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* Hidden / unfinished buttons (toggle via Developer Mode) */}
            {showHiddenSettingsButtons && (
                <ItemGroup>
                    <Item
                        title={t('settings.supportUs')}
                        subtitle={isPro ? t('settings.supportUsSubtitlePro') : t('settings.supportUsSubtitle')}
                        icon={<Icon name="heart" size={29} color={theme.colors.state.danger.foreground} />}
                        showChevron={false}
                        onPress={handleSupportUs}
                    />
                </ItemGroup>
            )}

            {/* Social */}
            {/* <ItemGroup title={t('settings.social')}>
                <Item
                    title={t('navigation.friends')}
                    subtitle={t('friends.manageFriends')}
                    icon={<Icon name="users" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => router.push('/friends')}
                />
            </ItemGroup> */}

            <SettingsBelowFoldSections
                appVersion={appVersion}
                automationsNeedLocalEnablement={automationsNeedLocalEnablement}
                devModeEnabled={devModeEnabled}
                handleGitHub={handleGitHub}
                handleReportIssue={handleReportIssue}
                handleVersionClick={handleVersionClick}
                onNavigate={navigateCatalogRoute}
                router={router}
                showAutomations={showAutomations}
                showChangelog={showChangelog}
                showRateUs={showRateUs}
                stage={belowFoldSettingsStage}
                terminalUseTmux={terminalUseTmux}
                theme={theme}
            />

        </ItemList>
    );
});
