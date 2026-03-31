import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { PreAuthOnboardingWizardEntry } from '@/components/onboardingWizard/PreAuthOnboardingWizardEntry';
import { DesktopOnlySetupNotice } from '@/components/settings/machines/DesktopOnlySetupNotice';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isTauriDesktop } from '@/utils/platform/tauri';

function BrowserWebSetupRoute() {
    const snapshot = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
    const relayUrl = String(snapshot.serverUrl ?? '').trim().replace(/\/+$/, '') || null;

    React.useEffect(() => {
        clearPendingSetupIntent();
    }, []);

    return (
        <ItemList>
            <DesktopOnlySetupNotice
                testID="setup.desktopOnlyNotice"
                groupTitle={t('setupOnboarding.controlPanelTitle')}
                title={t('setupOnboarding.webDesktopOnlyTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
            <ItemGroup title={t('setupOnboarding.controlPanelTitle')}>
                <Item
                    testID="setup.launchWizard"
                    title={t('setupOnboarding.openSetupAction')}
                    subtitle={t('setupOnboarding.postAuthBody')}
                    onPress={() => {
                        router.push('/setup/wizard');
                    }}
                />
            </ItemGroup>
            <ItemGroup title={t('setupOnboarding.currentRelayTitle')}>
                <Item
                    testID="setup.web.activeRelay"
                    title={t('setupOnboarding.activeRelaySummaryTitle')}
                    subtitle={relayUrl ? toServerUrlDisplay(relayUrl) : t('status.unknown')}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        </ItemList>
    );
}

function PostAuthSetupRoute() {
    const pending = getPendingSetupIntent();
    const desktop = isTauriDesktop();
    const effectivePending = React.useMemo(() => {
        if (pending?.phase !== 'awaiting_auth') {
            return pending;
        }
        return {
            ...pending,
            phase: 'post_auth',
        } as const;
    }, [pending]);
    const snapshot = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
    const relayDriftBanner = useRelayDriftBanner();
    const relayUrl = (String(snapshot.serverUrl ?? effectivePending?.relayUrl ?? '').trim().replace(/\/+$/, '') || t('status.unknown'));
    const thisComputerSummary = relayDriftBanner?.title
        ?? (effectivePending?.branch === 'remoteMachine'
            ? t('settings.machineSetupSshMachineSubtitle')
            : effectivePending?.phase === 'post_auth'
                ? t('settings.machineSetupCurrentMachineSubtitle')
                : t('setupOnboarding.thisComputerReady'));
    const nextActionSummary = relayDriftBanner?.actionLabel
        ?? (effectivePending?.branch === 'remoteMachine'
            ? t('settingsProviders.setup.startTitle')
            : effectivePending?.phase === 'post_auth'
                ? t('settings.machineSetupStageConnect')
                : t('setupOnboarding.nextActionReady'));

    React.useEffect(() => {
        if (pending?.phase !== 'awaiting_auth') {
            return;
        }
        setPendingSetupIntent({
            ...pending,
            phase: 'post_auth',
        });
    }, []);

    const handleDiscard = React.useCallback(() => {
        clearPendingSetupIntent();
        router.replace('/');
    }, []);

    return (
        <ItemList>
            <ItemGroup title={t('setupOnboarding.postAuthTitle')}>
                <Item
                    testID="setup.postAuth"
                    title={t('setupOnboarding.postAuthBody')}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    testID="setup.postAuthDiscard"
                    title={t('common.discard')}
                    onPress={handleDiscard}
                />
            </ItemGroup>
            <ItemGroup title={t('setupOnboarding.controlPanelTitle')}>
                <Item
                    testID="setup.launchWizard"
                    title={t('setupOnboarding.openSetupAction')}
                    subtitle={t('setupOnboarding.postAuthBody')}
                    onPress={() => {
                        router.push('/setup/wizard');
                    }}
                />
                <Item
                    testID="setup.summary.activeRelay"
                    title={t('setupOnboarding.activeRelaySummaryTitle')}
                    subtitle={relayUrl}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    testID="setup.summary.thisComputer"
                    title={t('setupOnboarding.thisComputerSummaryTitle')}
                    subtitle={thisComputerSummary}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    testID="setup.summary.nextAction"
                    title={t('setupOnboarding.nextActionSummaryTitle')}
                    subtitle={nextActionSummary}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
            {relayDriftBanner ? (
                !desktop ? (
                    <ItemGroup title={relayDriftBanner.title}>
                        <Item
                            testID="setup.webRelayDriftNotice"
                            title={relayDriftBanner.title}
                            subtitle={relayDriftBanner.description}
                            showChevron={false}
                            mode="info"
                        />
                    </ItemGroup>
                ) : (
                    <RelayDriftActionCard banner={relayDriftBanner} />
                )
            ) : null}
        </ItemList>
    );
}

export default function SetupRoute() {
    const auth = useAuth();
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop();

    React.useEffect(() => {
        if (!auth.isAuthenticated) {
            clearPendingSetupIntent();
            router.replace('/');
        }
    }, [auth.isAuthenticated]);

    if (!auth.isAuthenticated) {
        return null;
    }
    if (isBrowserWeb) {
        return <BrowserWebSetupRoute />;
    }
    return <PostAuthSetupRoute />;
}
