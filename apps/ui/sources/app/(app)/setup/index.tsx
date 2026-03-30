import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { HomeHeaderNotAuth } from '@/components/navigation/shell/HomeHeader';
import { DesktopOnlySetupNotice } from '@/components/settings/machines/DesktopOnlySetupNotice';
import { MachineSetupFlowScreen } from '@/components/settings/machines/MachineSetupFlowScreen';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSetupTextField } from '@/components/settings/machines/shared/MachineSetupTextField';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { listServerProfiles, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isTauriDesktop } from '@/utils/platform/tauri';

function normalizeRelayUrl(rawUrl: string | null | undefined): string | null {
    const value = String(rawUrl ?? '').trim().replace(/\/+$/, '');
    return value ? value : null;
}

const styles = StyleSheet.create((theme) => ({
    errorInput: {
        borderColor: theme.colors.textDestructive,
    },
    errorFooterText: {
        color: theme.colors.textDestructive,
    },
    inlineFormContent: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 16,
    },
}));

function BrowserWebSetupRoute() {
    const snapshot = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
    const relayUrl = normalizeRelayUrl(snapshot.serverUrl ?? null);

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

function PreAuthSetupRoute() {
    const snapshot = React.useSyncExternalStore(subscribeActiveServer, getActiveServerSnapshot, getActiveServerSnapshot);
    const relayUrl = normalizeRelayUrl(snapshot.serverUrl ?? null);
    const savedRelayProfiles = React.useMemo(() => listServerProfiles().slice(), [snapshot.generation]);
    const [showInlineRelayForm, setShowInlineRelayForm] = React.useState(false);
    const [customRelayUrl, setCustomRelayUrl] = React.useState('');
    const [customRelayName, setCustomRelayName] = React.useState('');
    const [customRelayError, setCustomRelayError] = React.useState<string | null>(null);
    const relayFormOpacity = React.useRef(new Animated.Value(0)).current;
    const continueToAuthForRelay = React.useCallback((nextRelayUrl: string | null) => {
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: nextRelayUrl,
        });
        router.replace('/');
    }, []);

    const handleContinueToAuth = React.useCallback(async () => {
        continueToAuthForRelay(normalizeRelayUrl(getActiveServerSnapshot().serverUrl ?? relayUrl));
    }, [continueToAuthForRelay, relayUrl]);

    const handleDiscard = React.useCallback(() => {
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl,
        });
        router.replace('/');
    }, [relayUrl]);

    const handleAddRelay = React.useCallback(() => {
        const nextRelayUrl = normalizeRelayUrl(customRelayUrl);
        const validation = validateServerUrl(nextRelayUrl ?? customRelayUrl);
        if (!nextRelayUrl || !validation.valid) {
            setCustomRelayError(t('errors.invalidFormat'));
            return;
        }

        const profile = upsertServerProfile({
            serverUrl: nextRelayUrl,
            ...(customRelayName.trim() ? { name: customRelayName.trim() } : {}),
            source: 'manual',
            replaceEquivalentStoredUrl: true,
        });
        setActiveServerId(profile.id, { scope: 'device' });
        setCustomRelayUrl('');
        setCustomRelayName('');
        setCustomRelayError(null);
        setShowInlineRelayForm(false);
        continueToAuthForRelay(nextRelayUrl);
    }, [continueToAuthForRelay, customRelayName, customRelayUrl]);

    React.useEffect(() => {
        if (!showInlineRelayForm) {
            relayFormOpacity.setValue(0);
            return;
        }
        Animated.timing(relayFormOpacity, {
            toValue: 1,
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: true,
        }).start();
    }, [relayFormOpacity, showInlineRelayForm]);

    return (
        <>
            <HomeHeaderNotAuth />
            <ItemList>
                <ItemGroup title={t('setupOnboarding.preAuthTitle')}>
                    <Item
                        testID="setup.preAuth.intro"
                        title={t('setupOnboarding.preAuthBody')}
                        subtitle={t('setupOnboarding.preAuthContinueHint')}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>

                <ItemGroup title={t('setupOnboarding.currentRelayTitle')}>
                    <Item
                        testID="setup.currentRelay"
                        title={t('setupOnboarding.currentRelayTitle')}
                        subtitle={t('setupOnboarding.currentRelayDescription', {
                            relayUrl: relayUrl ?? t('status.unknown'),
                        })}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>

                {savedRelayProfiles.length > 0 ? (
                    <ItemGroup title={t('setupOnboarding.savedRelaysTitle')}>
                        {savedRelayProfiles.map((profile) => (
                            <Item
                                key={profile.id}
                                testID={`setup.savedRelay.${profile.id}`}
                                title={profile.name}
                                subtitle={toServerUrlDisplay(profile.serverUrl)}
                                selected={profile.id === snapshot.serverId}
                                showChevron={false}
                                onPress={() => {
                                    setActiveServerId(profile.id, { scope: 'device' });
                                }}
                            />
                        ))}
                    </ItemGroup>
                ) : null}

                <ItemGroup title={t('common.actions')}>
                    <Item
                        testID="setup.continueToAuth"
                        title={t('setupOnboarding.continueToAuth')}
                        onPress={() => {
                            void handleContinueToAuth();
                        }}
                    />
                </ItemGroup>

                <ItemGroup>
                    <Item
                        testID="setup.changeRelay"
                        title={t('setupOnboarding.changeRelayAction')}
                        onPress={() => {
                            setShowInlineRelayForm((current) => !current);
                        }}
                    />
                    <Item
                        testID="setup.discard"
                        title={t('common.discard')}
                        onPress={handleDiscard}
                        destructive
                    />
                </ItemGroup>

                {showInlineRelayForm ? (
                    <Animated.View style={{ opacity: relayFormOpacity }}>
                        <ItemGroup
                            footer={customRelayError ?? undefined}
                            footerTextStyle={customRelayError ? styles.errorFooterText : undefined}
                        >
                            <View style={styles.inlineFormContent}>
                                <MachineSetupTextField
                                    testID="setup.customRelayUrl"
                                    label={t('setupOnboarding.customRelayUrlLabel')}
                                    value={customRelayUrl}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    placeholder={t('common.urlPlaceholder')}
                                    inputStyle={customRelayError ? styles.errorInput : undefined}
                                    onChangeText={(value) => {
                                        setCustomRelayUrl(value);
                                        if (customRelayError) setCustomRelayError(null);
                                    }}
                                />
                                <MachineSetupTextField
                                    testID="setup.customRelayName"
                                    label={t('setupOnboarding.relayNameLabel')}
                                    value={customRelayName}
                                    autoCorrect={false}
                                    onChangeText={setCustomRelayName}
                                />
                            </View>
                        </ItemGroup>

                        <ItemGroup>
                            <Item
                                testID="setup.addRelay"
                                title={t('setupOnboarding.addAndUseRelay')}
                                disabled={!customRelayUrl.trim()}
                                onPress={handleAddRelay}
                            />
                        </ItemGroup>
                    </Animated.View>
                ) : null}

            </ItemList>
        </>
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
    const relayUrl = normalizeRelayUrl(snapshot.serverUrl ?? effectivePending?.relayUrl ?? null) ?? t('status.unknown');
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
            {desktop ? (
                <MachineSetupFlowScreen
                    autoStartLocalTask={effectivePending?.branch === 'thisComputer'}
                    embedded
                    initialProviderMachineId={effectivePending?.branch === 'remoteMachine' ? effectivePending.machineId : null}
                    onLocalSetupSucceeded={() => {
                        clearPendingSetupIntent();
                    }}
                />
            ) : null}
        </ItemList>
    );
}

export default function SetupRoute() {
    const auth = useAuth();
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop();
    if (isBrowserWeb) {
        return <BrowserWebSetupRoute />;
    }
    return auth.isAuthenticated ? <PostAuthSetupRoute /> : <PreAuthSetupRoute />;
}
