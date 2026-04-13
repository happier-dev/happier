import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { readPluginMarketplaceCatalog, type PluginMarketplaceCatalog } from './readPluginMarketplaceCatalog';

const stylesheet = StyleSheet.create((theme) => ({
    formBlock: {
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
    },
    catalogSource: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        marginTop: 6,
    },
}));

function resolveCatalogErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return t('errors.unknownError');
}

function formatEntryVersion(version: string | null): string | undefined {
    return version ?? undefined;
}

export const PluginMarketplaceSettingsScreen = React.memo(function PluginMarketplaceSettingsScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [catalogUrl, setCatalogUrl] = React.useState('');
    const [loadedUrl, setLoadedUrl] = React.useState<string | null>(null);
    const [catalog, setCatalog] = React.useState<PluginMarketplaceCatalog | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    const canLoad = catalogUrl.trim().length > 0 && !loading;

    const loadCatalog = React.useCallback(async () => {
        const nextUrl = catalogUrl.trim();
        if (!nextUrl || loading) {
            return;
        }

        setLoading(true);
        setErrorMessage(null);

        try {
            const nextCatalog = await readPluginMarketplaceCatalog(nextUrl);
            setCatalog(nextCatalog);
            setLoadedUrl(nextCatalog.sourceUrl);
        } catch (error) {
            setCatalog(null);
            setLoadedUrl(null);
            setErrorMessage(resolveCatalogErrorMessage(error));
        } finally {
            setLoading(false);
        }
    }, [catalogUrl, loading]);

    const catalogFooter = catalog
        ? (catalog.entries.length === 0
            ? t('settingsPlugins.emptySubtitle')
            : catalog.description ?? undefined)
        : undefined;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsPlugins.title')} footer={t('settingsPlugins.subtitle')}>
                <View style={styles.formBlock}>
                    <Text style={styles.label}>{t('settingsPlugins.catalogUrlLabel')}</Text>
                    <TextInput
                        testID="settings.plugins.marketplace.catalogUrl"
                        value={catalogUrl}
                        onChangeText={setCatalogUrl}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        style={styles.input}
                        autoCapitalize="none"
                        autoCorrect={false}
                        textContentType="URL"
                        autoComplete="url"
                        onSubmitEditing={() => {
                            void loadCatalog();
                        }}
                    />
                    {loadedUrl ? (
                        <Text style={styles.catalogSource}>{loadedUrl}</Text>
                    ) : null}
                </View>

                <Item
                    testID="settings.plugins.marketplace.loadCatalog"
                    title={t('settingsPlugins.loadCatalog')}
                    subtitle={loading ? t('common.loading') : undefined}
                    onPress={() => {
                        void loadCatalog();
                    }}
                    loading={loading}
                    disabled={!canLoad}
                    showChevron={false}
                />
            </ItemGroup>

            {errorMessage ? (
                <ItemGroup title={t('common.error')}>
                    <Item
                        title={t('common.error')}
                        subtitle={errorMessage}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            {catalog ? (
                <ItemGroup title={catalog.title} footer={catalogFooter}>
                    {catalog.entries.map((entry) => (
                        <Item
                            key={entry.id}
                            testID={`settings.plugins.marketplace.entry.${entry.id}`}
                            title={entry.title}
                            subtitle={entry.description ?? null}
                            detail={formatEntryVersion(entry.version)}
                            mode="info"
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

export default PluginMarketplaceSettingsScreen;
