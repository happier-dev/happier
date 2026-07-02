import * as React from 'react';
import type { ScrollView, ScrollViewProps } from 'react-native';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance';
import { SavedServersSection } from '@/components/settings/server/sections/SavedServersSection';
import { AddTargetsSection } from '@/components/settings/server/sections/AddTargetsSection';
import { ServerGroupsSection } from '@/components/settings/server/sections/ServerGroupsSection';
import { ServerRetentionSection } from '@/components/settings/server/sections/ServerRetentionSection';
import { RelayDriftActionCard } from '@/components/settings/server/RelayDriftActionCard';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { resolveKnownLocalRelayUrl } from '@/sync/domains/server/url/resolveKnownLocalRelayUrl';
import { useServerSettingsScreenController } from '@/components/settings/server/hooks/useServerSettingsScreenController';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { t } from '@/text';
import { buildRelaySetupWizardHref } from '@/utils/routes/setupWizardHref';

const stylesheet = StyleSheet.create((_theme) => ({
    itemListContainer: {
        flex: 1,
    },
}));

type KeyboardAwareItemListProps = ScrollViewProps & Readonly<{
    children?: React.ReactNode;
}>;

const ServerSettingsKeyboardAwareItemList = React.forwardRef<ScrollView, KeyboardAwareItemListProps>(
    function ServerSettingsKeyboardAwareItemList({ children, ...props }, ref) {
        return (
            <ItemList ref={ref} {...props}>
                {children}
            </ItemList>
        );
    },
);

export function ServerSettingsScreen() {
    useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const controller = useServerSettingsScreenController();
    const isDesktop = isTauriDesktop();
    const isWeb = Platform.OS === 'web';
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const [localRelayUrl, setLocalRelayUrl] = React.useState<string | null>(null);
    const knownLocalRelayUrl = React.useMemo(() => resolveKnownLocalRelayUrl({
        activeServerUrl: controller.activeServerUrl,
        activeLocalRelayUrl: controller.activeLocalRelayUrl,
    }), [controller.activeLocalRelayUrl, controller.activeServerUrl]);
    const handleLocalRelayStatusChange = React.useCallback((status: Readonly<{ relayUrl: string }> | null | undefined) => {
        const nextRelayUrl = typeof status?.relayUrl === 'string' && status.relayUrl.trim().length > 0
            ? status.relayUrl.trim()
            : null;
        setLocalRelayUrl((current) => current === nextRelayUrl ? current : nextRelayUrl);
    }, []);

    return (
            <KeyboardAwareScrollView
                style={styles.itemListContainer}
                ScrollViewComponent={ServerSettingsKeyboardAwareItemList}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
            >
                    {controller.relayDriftBanner ? (
                        isDesktop ? (
                            <RelayDriftActionCard banner={controller.relayDriftBanner} />
                        ) : (
                            <ItemGroup title={controller.relayDriftBanner.title}>
                                <Item
                                    testID="settings.server.relayDrift.readOnlyNotice"
                                    title={controller.relayDriftBanner.title}
                                    subtitle={controller.relayDriftBanner.description}
                                    showChevron={false}
                                    mode="info"
                                />
                            </ItemGroup>
                        )
                    ) : null}
                    <SavedServersSection
                        servers={controller.servers}
                        serverGroups={controller.serverGroups}
                        activeServerId={controller.activeServerId}
                        deviceDefaultServerId={controller.deviceDefaultServerId}
                        activeTargetKey={controller.activeTargetKey}
                        authStatusByServerId={controller.authStatusByServerId}
                        onSwitch={controller.onSwitchServer}
                        onSwitchGroup={controller.onSwitchGroup}
                        onRenameGroup={controller.onRenameGroup}
                        onRemoveGroup={controller.onRemoveGroup}
                        onRename={controller.onRenameServer}
                        onRemove={controller.onRemoveServer}
                    />

                    <ServerRetentionSection serverId={controller.activeServerId || null} />

                    {setupPolicy.relay.allowRelaySelection ? (
                        <ItemGroup title={t('common.actions')}>
                            <Item
                                testID="settings.server.openSetupWizard"
                                title={t('setupOnboarding.setupNewRelayAction')}
                                subtitle={t('setupOnboarding.openSetupWizardSubtitle')}
                                onPress={() => router.push(buildRelaySetupWizardHref({ step: 'setup_chooser' }))}
                            />
                        </ItemGroup>
                    ) : null}

                    {isDesktop && setupPolicy.relay.allowLocalRelayHost ? (
                        <>
                            <LocalRelayRuntimeControlSection
                                onStatusChange={handleLocalRelayStatusChange}
                            />
                            <LocalRelayAccessControlSection upstreamUrl={localRelayUrl ?? knownLocalRelayUrl} />
                        </>
                    ) : isWeb ? null : (
                        <ItemGroup title={t('settingsProviders.localControlTitle')}>
                            <Item
                                testID="settings.server.localControl.desktopOnlyNotice"
                                title={t('settingsProviders.localControlTitle')}
                                subtitle={t('settings.systemTaskBridgeUnavailable')}
                                showChevron={false}
                                mode="info"
                            />
                        </ItemGroup>
                    )}

                    {setupPolicy.relay.allowRelaySelection && setupPolicy.relay.allowCustomRelayUrl ? (
                        <AddTargetsSection
                            autoMode={controller.autoMode}
                            inputUrl={controller.inputUrl}
                            inputName={controller.inputName}
                            error={controller.error}
                            isValidating={controller.isValidating}
                            reachabilityRemediation={controller.reachabilityRemediation}
                            reachabilityRemediationTaskSnapshot={controller.reachabilityRemediationTaskSnapshot}
                            prefillHint={controller.addServerPrefillHint}
                            defaultExpanded={controller.addServerDefaultExpanded}
                            onChangeUrl={controller.onChangeUrl}
                            onChangeName={controller.onChangeName}
                            onResetServer={controller.onResetServer}
                            onAddServer={controller.onAddServer}
                            onReachabilityRemediationAction={controller.onReachabilityRemediationAction}
                            servers={controller.servers}
                            activeServerId={controller.activeServerId}
                            onCreateServerGroup={controller.onCreateServerGroup}
                        />
                    ) : null}

                    {controller.serverGroups.length > 0 ? (
                        <ServerGroupsSection
                            groupSelectionEnabled={controller.groupSelectionEnabled}
                            setGroupSelectionEnabled={controller.setGroupSelectionEnabled}
                            groupSelectionPresentation={controller.groupSelectionPresentation}
                            activeServerGroupId={controller.activeServerGroupId}
                            selectedGroupServerIds={controller.selectedGroupServerIds}
                            servers={controller.servers}
                            onToggleGroupPresentation={controller.onToggleGroupPresentation}
                            onToggleGroupServer={controller.onToggleGroupServer}
                        />
                    ) : null}
            </KeyboardAwareScrollView>
    );
}
