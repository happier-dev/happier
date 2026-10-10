import { Linking } from 'react-native';
import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';
import Constants from 'expo-constants';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useEntitlement, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { trackPaywallButtonClicked } from '@/track';
import { Modal } from '@/modal';
import { useMultiClick } from '@/hooks/ui/useMultiClick';
import { t } from '@/text';
import { canRequestReview } from '@/utils/system/requestReview';
import { resolveSupportUsAction } from '@/components/settings/supportUsBehavior';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { SettingsBelowFoldSections } from '@/components/settings/SettingsBelowFoldSections';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { HubIdentityHeader } from '@/components/hub/HubIdentityHeader';
import { HubAttentionSection } from '@/components/hub/HubAttentionSection';
import { HubSetupSection } from '@/components/hub/HubSetupSection';
import { HubMachinesSection } from '@/components/hub/HubMachinesSection';
import { UsageCapacitySection } from '@/components/settings/usage/UsageCapacitySection';
import { HubSecuritySection } from '@/components/hub/HubSecuritySection';
import { HubQuickSettingsSection } from '@/components/hub/HubQuickSettingsSection';
import { useSettingsRailVisible } from '@/components/settings/shell/settingsRailVisibility';
import { SettingsPageSearch } from '@/components/settings/shell/SettingsPageSearch';

const DEFER_BELOW_FOLD_SETTINGS_SECTIONS_DELAY_MS = 0;
const DEFER_BELOW_FOLD_SETTINGS_STAGE_DELAY_MS = 16;

export const SettingsView = React.memo(function SettingsView() {
    const router = useRouter();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const railVisible = useSettingsRailVisible();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const voiceEntitlement = useEntitlement('voice');
    const isPro = __DEV__ || voiceEntitlement;
    const showChangelog = getFeatureBuildPolicyDecision('app.ui.changelog' as const satisfies FeatureId) !== 'deny';
    const [showRateUs, setShowRateUs] = React.useState(false);
    const automationsSupport = useAutomationsSupport();
    const showAutomations = automationsSupport?.discoverable !== false;
    const automationsNeedLocalEnablement = automationsSupport?.blockedBy === 'local_policy';
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

    // Unfinished entries stay behind developer mode.
    const supportUs = showHiddenSettingsButtons ? {
        subtitle: isPro ? t('settings.supportUsSubtitlePro') : t('settings.supportUsSubtitle'),
        onPress: () => { void handleSupportUs(); },
    } : null;

    const overview = (
        <>
            {/* The lighter hub (lab H1): the same hub sections as the app home, in one column, without
                the greeting and start box, setup as a checklist with its progress. Every section drops
                out when it has nothing to say, and none of them asks a machine anything. */}
            <HubIdentityHeader />
            <HubAttentionSection />
            <HubSetupSection presentation="checklist" />
            <HubMachinesSection />
            <UsageCapacitySection />
            <HubSecuritySection />
            <HubQuickSettingsSection />

            <SettingsBelowFoldSections
                appVersion={appVersion}
                automationsNeedLocalEnablement={automationsNeedLocalEnablement}
                devModeEnabled={devModeEnabled}
                handleGitHub={handleGitHub}
                handleReportIssue={handleReportIssue}
                handleVersionClick={handleVersionClick}
                onNavigate={navigateCatalogRoute}
                router={router}
                showCatalogGroups={!railVisible}
                showAutomations={showAutomations}
                showChangelog={showChangelog}
                showRateUs={showRateUs}
                stage={belowFoldSettingsStage}
                supportUs={supportUs}
            />
        </>
    );

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* The rail carries search where it is shown; otherwise the page does (phones). */}
            {railVisible ? overview : <SettingsPageSearch>{overview}</SettingsPageSearch>}
        </ItemList>
    );
});
