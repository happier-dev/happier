import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    CatalogEntriesSection,
    InstalledPluginsSection,
    RegistryDiagnosticsSection,
} from './PluginMarketplaceSections';
import { buildPluginDetailRoute } from './model/pluginDetailRoute';
import { usePluginSettingsScreenState } from './model/usePluginSettingsScreenState';

const stylesheet = StyleSheet.create((theme) => ({
    inputBlock: {
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 12,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 14,
        marginBottom: 8,
    },
    input: {
        ...Typography.default(),
        fontSize: 16,
        color: theme.colors.text,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 12,
        paddingVertical: 12,
        marginBottom: 12,
    },
}));

export const PluginSettingsHomeScreen = React.memo(function PluginSettingsHomeScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const state = usePluginSettingsScreenState();

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsPlugins.title')} footer={t('settingsPlugins.subtitle')}>
                <View style={styles.inputBlock}>
                    <Text style={styles.label}>{t('settingsPlugins.catalogUrlLabel')}</Text>
                    <TextInput
                        testID="settings.plugins.marketplace.catalogUrl"
                        value={state.catalogUrl}
                        onChangeText={state.setCatalogUrl}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        style={styles.input}
                        autoCapitalize="none"
                        autoCorrect={false}
                        textContentType="URL"
                        autoComplete="url"
                        onSubmitEditing={() => {
                            void state.loadCatalog();
                        }}
                    />
                </View>
                <Item
                    testID="settings.plugins.marketplace.loadCatalog"
                    title={t('settingsPlugins.loadCatalog')}
                    subtitle={state.loadingCatalog ? t('common.loading') : undefined}
                    icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => {
                        void state.loadCatalog();
                    }}
                    disabled={!state.canLoadCatalog}
                    loading={state.loadingCatalog}
                    showChevron={false}
                />
            </ItemGroup>

            <InstalledPluginsSection
                installedPlugins={state.installedPlugins}
                catalog={state.catalog}
                canRunActions={state.canRefreshInstalledPlugins}
                isPluginActionInFlight={state.isPluginActionInFlight}
                onNavigateToPlugin={(pluginId) => router.push(buildPluginDetailRoute(pluginId))}
                onRunAction={state.runInstalledPluginAction}
            />

            <RegistryDiagnosticsSection diagnostics={state.registryDiagnostics} />

            <CatalogEntriesSection
                catalog={state.catalog}
                loadingCatalog={state.loadingCatalog}
                resolvedCatalogUrl={state.resolvedCatalogUrl}
                loadedCatalogTitle={state.loadedCatalogTitle}
                loadedCatalogFooter={state.loadedCatalogFooter}
                installedPluginById={state.installedPluginById}
                canRefreshInstalledPlugins={state.canRefreshInstalledPlugins}
                isPluginActionInFlight={state.isPluginActionInFlight}
                onAction={state.runCatalogAction}
            />

            {state.catalogError ? (
                <ItemGroup title={t('common.error')}>
                    <Item
                        title={t('common.error')}
                        subtitle={state.catalogError}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

export default PluginSettingsHomeScreen;
