import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
    },
    iconBox: {
        width: 44,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.base,
    },
    content: {
        flex: 1,
        gap: 4,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 22,
        lineHeight: 28,
    },
    subtitle: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    meta: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 18,
    },
}));

export function PluginDetailHeader(props: Readonly<{
    installed: InstalledPluginEntry;
    projection: PluginProjectionEntry | null;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const statusLabel = props.projection?.status?.label ?? (props.installed.enabled ? t('common.enabled') : t('common.disabled'));
    const description = props.projection?.description ?? props.installed.description ?? t('settingsPlugins.subtitle');

    return (
        <View testID={`settings.plugins.detail.${props.installed.pluginId}.header`} style={styles.container}>
            <View style={styles.iconBox}>
                <Icon
                    name="puzzle-piece"
                    size={20}
                    color={theme.colors.button.secondary.tint}
                />
            </View>
            <View style={styles.content}>
                <Text style={styles.title}>{props.projection?.title ?? props.installed.title}</Text>
                <Text style={styles.subtitle}>{description}</Text>
                <Text style={styles.meta}>{[statusLabel, props.installed.version].join(' | ')}</Text>
            </View>
        </View>
    );
}

/**
 * The recovery route can remain available from Account-scoped data after its
 * daemon projection has disappeared. Keep its identity presentation local to
 * the detail surface without implying that the plugin is installed or active.
 */
export function PluginDetailRecoveryHeader(props: Readonly<{
    pluginId: string;
    title: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View testID={`settings.plugins.detail.${props.pluginId}.recoveryHeader`} style={styles.container}>
            <View style={styles.iconBox}>
                <Icon
                    name="cloud-slash"
                    size={20}
                    color={theme.colors.text.secondary}
                />
            </View>
            <View style={styles.content}>
                <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>
                    {props.title}
                </Text>
                <Text style={styles.subtitle}>{t('common.unavailable')}</Text>
                <Text style={styles.meta} numberOfLines={1} ellipsizeMode="middle">
                    {props.pluginId}
                </Text>
            </View>
        </View>
    );
}
