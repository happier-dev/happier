import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text, TextInput } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { PluginScaffoldUiMode } from '@happier-dev/protocol';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

import {
    CatalogEntriesSection,
    DevelopmentPluginsSection,
    InstalledPluginsSection,
    PendingPluginChangesSection,
    PluginDiagnosticsSnapshotSection,
} from './PluginMarketplaceSections';
import { buildPluginDetailRoute } from './model/pluginDetailRoute';
import { createPluginSettingsViews } from './model/pluginMarketplaceModel';
import { usePluginSettingsScreenState } from './model/usePluginSettingsScreenState';
import { NpmRegistryProfilesSection } from './NpmRegistryProfilesSection';
import { PluginAccountDataEraseRecoverySection } from './PluginAccountDataEraseRecoverySection';
import { PluginReadOnlySnapshotNotice } from './PluginReadOnlySnapshotNotice';
import { NativeAppPluginPanelsSettingsEntry } from './NativeAppPluginPanelsSettingsEntry';
import { PluginAppPagesSettingsEntry } from './PluginAppPagesSettingsEntry';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    viewSelector: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
    },
    inputBlock: {
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 12,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        marginBottom: 8,
    },
    input: {
        ...Typography.default(),
        fontSize: 16,
        color: theme.colors.text.primary,
        borderRadius: 12,
        borderWidth: 1,
        minHeight: 44,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 12,
        paddingVertical: 12,
        marginBottom: 12,
    },
}));

export const PluginSettingsHomeScreen = React.memo(function PluginSettingsHomeScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const state = usePluginSettingsScreenState();
    const views = createPluginSettingsViews((key) => t(key));
    const createDevelopmentPlugin = React.useCallback(async () => {
        if (!state.daemonOperationsAvailable || !state.developmentCreateAvailable) return;
        const targetDir = (await Modal.prompt(
            t('settingsPlugins.developmentCreateDirectoryTitle'),
            t('settingsPlugins.developmentCreateDirectoryBody'),
            { confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!targetDir) return;
        const displayName = (await Modal.prompt(
            t('settingsPlugins.developmentCreateNameTitle'),
            t('settingsPlugins.developmentCreateNameBody'),
            { confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!displayName) return;
        const pluginId = (await Modal.prompt(
            t('settingsPlugins.developmentCreateIdTitle'),
            t('settingsPlugins.developmentCreateIdBody'),
            { placeholder: 'com.example.my-plugin', confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!pluginId) return;
        // The scaffold's UI mode is part of what the author is creating, so the
        // in-app lifecycle asks for it. Without this step every plugin created
        // from the app is a non-UI plugin and no later in-app step can add a
        // surface to it.
        let ui: PluginScaffoldUiMode | undefined;
        let uiChosen = false;
        await Modal.alertAsync(
            t('settingsPlugins.developmentCreateSurfaceTitle'),
            t('settingsPlugins.developmentCreateSurfaceBody'),
            [
                {
                    text: t('settingsPlugins.developmentCreateSurfaceReactNative'),
                    onPress: () => { ui = 'reactNative'; uiChosen = true; },
                },
                {
                    text: t('settingsPlugins.developmentCreateSurfaceHostedWeb'),
                    onPress: () => { ui = 'hostedWeb'; uiChosen = true; },
                },
                {
                    text: t('settingsPlugins.developmentCreateSurfaceNone'),
                    onPress: () => { ui = undefined; uiChosen = true; },
                },
            ],
        );
        if (!uiChosen) return;
        const confirmed = await Modal.confirm(
            t('settingsPlugins.developmentCreateConfirmTitle'),
            t('settingsPlugins.developmentCreateConfirmBody', { pluginId, targetDir }),
            { confirmText: t('settingsPlugins.developmentCreate'), cancelText: t('common.cancel') },
        );
        if (!confirmed) return;
        state.runDevelopmentCreate({ targetDir, displayName, pluginId, ...(ui ? { ui } : {}) });
    }, [state]);
    // Adopting an existing folder is the step that turns a created (or cloned)
    // plugin project into a running development source. The path the user types
    // here is the exact thing the daemon will be asked to trust, so it is echoed
    // back verbatim in the trust decision rather than being summarised.
    const developPluginSourceRoot = React.useCallback(async () => {
        if (!state.daemonOperationsAvailable || !state.developmentSourceInstallAvailable) return;
        const sourceRootPath = (await Modal.prompt(
            t('settingsPlugins.developmentSourceInstallTitle'),
            t('settingsPlugins.developmentSourceInstallBody'),
            { confirmText: t('common.continue'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!sourceRootPath) return;
        state.runDevelopmentSourceInstall(sourceRootPath);
    }, [state]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {state.readOnlySnapshotNotice ? (
                <PluginReadOnlySnapshotNotice
                    testID="settings.plugins.marketplace.readOnlySnapshot"
                    reason={state.readOnlySnapshotNotice.reason}
                    onRetry={state.refreshPluginTruth}
                />
            ) : null}

            {/*
              * Above the management views on purpose: a change waiting on this
              * user is attention, not one tab's content. A change an Agent
              * prepared has no other route into the app at all.
              */}
            <PendingPluginChangesSection
                pendingChanges={state.pendingPluginChanges}
                canRunActions={state.daemonOperationsAvailable}
                isPluginActionInFlight={state.isPluginActionInFlight}
                onDecide={state.decidePendingPluginChange}
            />

            <PluginAccountDataEraseRecoverySection
                testID="settings.plugins.accountDataErase"
            />

            <MachineAdministrationTargetSelector
                selection={state.administrationTargetSelection}
                testIDPrefix="settings.plugins.administration.target"
            />

            <ItemGroup>
                <Item
                    testID="settings.plugins.webhooks"
                    title={t('settingsPlugins.webhookAdministration.title')}
                    subtitle={t('settingsPlugins.webhookAdministration.footer')}
                    icon={<Icon name="link" size={29} color={theme.colors.accent.indigo} />}
                    onPress={() => router.push(SETTINGS_ROUTES.pluginWebhooks)}
                />
            </ItemGroup>

            <NativeAppPluginPanelsSettingsEntry />

            <PluginAppPagesSettingsEntry />

            <View style={styles.viewSelector}>
                <ScrollView
                    testID="settings.plugins.management.viewScroller"
                    horizontal
                    showsHorizontalScrollIndicator={false}
                >
                    <SegmentedTabBar
                        tabs={views}
                        activeTabId={state.activeView}
                        onSelectTab={state.setActiveView}
                        testIDPrefix="settings.plugins.management.view"
                        accessibilityLabel={t('settingsPlugins.viewSelectorLabel')}
                        segmentSizing="content"
                    />
                </ScrollView>
            </View>

            {state.activeView === 'installed' ? (
                <InstalledPluginsSection
                    installedPlugins={state.installedPlugins}
                    catalog={state.catalog}
                    canRunActions={state.canRefreshInstalledPlugins}
                    isPluginActionInFlight={state.isPluginActionInFlight}
                    onNavigateToPlugin={(pluginId) => router.push(buildPluginDetailRoute(pluginId))}
                    onRunAction={state.runInstalledPluginAction}
                />
            ) : null}

            {state.activeView === 'discover' ? (
                <>
                    <ItemGroup title={t('settingsPlugins.title')} footer={t('settingsPlugins.subtitle')}>
                        <View style={styles.inputBlock}>
                            <Text style={styles.label}>{t('settingsPlugins.catalogUrlLabel')}</Text>
                            <TextInput
                                testID="settings.plugins.marketplace.catalogUrl"
                                value={state.catalogUrl}
                                accessibilityLabel={t('settingsPlugins.catalogUrlLabel')}
                                editable={state.daemonOperationsAvailable}
                                onChangeText={state.daemonOperationsAvailable
                                    ? state.setCatalogUrl
                                    : undefined}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                style={[styles.input, { minHeight: minimumInteractiveTargetSize }]}
                                autoCapitalize="none"
                                autoCorrect={false}
                                textContentType="URL"
                                autoComplete="url"
                                onSubmitEditing={state.daemonOperationsAvailable
                                    ? () => {
                                        void state.loadCatalog();
                                    }
                                    : undefined}
                            />
                        </View>
                        <Item
                            testID="settings.plugins.marketplace.loadCatalog"
                            title={t('settingsPlugins.loadCatalog')}
                            subtitle={state.loadingCatalog ? t('common.loading') : undefined}
                            icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => {
                                void state.loadCatalog();
                            }}
                            disabled={!state.canLoadCatalog}
                            loading={state.loadingCatalog}
                            showChevron={false}
                        />
                    </ItemGroup>

                    <NpmRegistryProfilesSection
                        daemonOperationsAvailable={state.daemonOperationsAvailable}
                        targetSelection={state.administrationTargetSelection}
                        marketplaceSources={state.marketplaceSourceRegistry?.sources ?? []}
                        onSetMarketplaceSourceProfile={state.setMarketplaceSourceProfile}
                    />

                    <CatalogEntriesSection
                        catalog={state.catalog}
                        loadingCatalog={state.loadingCatalog}
                        resolvedCatalogUrl={state.resolvedCatalogUrl}
                        loadedCatalogTitle={state.loadedCatalogTitle}
                        loadedCatalogFooter={state.loadedCatalogFooter}
                        installedPluginById={state.installedPluginById}
                        canRunCatalogActions={state.canRunCatalogActions}
                        isPluginActionInFlight={state.isPluginActionInFlight}
                        onAction={state.runCatalogAction}
                    />

                    {state.catalogError ? (
                        <View
                            testID="settings.plugins.marketplace.catalog.error"
                            accessible
                            accessibilityRole="alert"
                            accessibilityLiveRegion="assertive"
                            accessibilityLabel={`${t('common.error')}: ${state.catalogError}`}
                        >
                            <ItemGroup title={t('common.error')}>
                                <Item
                                    title={t('common.error')}
                                    subtitle={state.catalogError}
                                    showChevron={false}
                                    mode="info"
                                />
                            </ItemGroup>
                        </View>
                    ) : null}
                </>
            ) : null}

            {state.activeView === 'development' ? (
                <DevelopmentPluginsSection
                    developmentPlugins={state.developmentPlugins}
                    createAvailable={state.developmentCreateAvailable}
                    sourceInstallAvailable={state.developmentSourceInstallAvailable}
                    canRunActions={state.daemonOperationsAvailable}
                    isPluginActionInFlight={state.isPluginActionInFlight}
                    onCreate={() => {
                        void createDevelopmentPlugin();
                    }}
                    onDevelopSourceRoot={() => {
                        void developPluginSourceRoot();
                    }}
                    onRunAction={state.runDevelopmentAction}
                />
            ) : null}

            {state.activeView === 'diagnostics' ? (
                <PluginDiagnosticsSnapshotSection diagnostics={state.currentDiagnostics} />
            ) : null}
        </ItemList>
    );
});

export default PluginSettingsHomeScreen;
