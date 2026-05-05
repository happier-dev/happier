import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    PluginProjectionEntry,
    PluginProjectionField,
    PluginProjectionSection,
    PluginProjectionSurface,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

const stylesheet = StyleSheet.create((theme) => ({
    fieldBlock: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 14,
        marginBottom: 4,
    },
    fieldValue: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderText: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: -0.08,
        textTransform: 'uppercase',
    },
    sectionHeaderHelpButton: {
        padding: 2,
        marginLeft: 8,
    },
}));

function formatFieldValue(field: PluginProjectionField): string | undefined {
    if (field.kind === 'boolean') {
        return field.value === true ? t('common.enabled') : t('common.disabled');
    }
    if (field.kind === 'enum' && typeof field.value === 'string') {
        return field.enumOptions?.find((option) => option.id === field.value)?.title ?? field.value;
    }
    if (typeof field.value === 'string') return field.value;
    if (typeof field.value === 'number' && Number.isFinite(field.value)) return String(field.value);
    if (field.value === null || field.value === undefined) return undefined;
    return JSON.stringify(field.value);
}

function compareByOrderThenTitle(left: { order?: number; title: string; id?: string }, right: { order?: number; title: string; id?: string }): number {
    const leftOrder = typeof left.order === 'number' ? left.order : Number.POSITIVE_INFINITY;
    const rightOrder = typeof right.order === 'number' ? right.order : Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
    }
    const titleDelta = left.title.localeCompare(right.title);
    if (titleDelta !== 0) {
        return titleDelta;
    }
    return (left.id ?? '').localeCompare(right.id ?? '');
}

function resolveToneColor(params: Readonly<{
    tone: string | null | undefined;
    theme: ReturnType<typeof useUnistyles>['theme'];
}>): string | null {
    switch (params.tone) {
        case 'info':
            return params.theme.colors.accent.blue;
        case 'success':
            return params.theme.colors.success;
        case 'warning':
            return params.theme.colors.accent.orange;
        case 'danger':
            return params.theme.colors.warningCritical;
        case 'neutral':
            return params.theme.colors.textSecondary;
        default:
            return null;
    }
}

function resolveToneIconName(tone: string | null | undefined): React.ComponentProps<typeof Ionicons>['name'] | null {
    switch (tone) {
        case 'info':
            return 'information-circle-outline';
        case 'success':
            return 'checkmark-circle-outline';
        case 'warning':
            return 'warning-outline';
        case 'danger':
            return 'alert-circle-outline';
        case 'neutral':
            return 'ellipse-outline';
        default:
            return null;
    }
}

function PluginDescriptorFieldRow(props: Readonly<{
    pluginId: string;
    surface: PluginProjectionSurface;
    section: PluginProjectionSection;
    field: PluginProjectionField;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const testID = `settings.plugins.detail.${props.pluginId}.descriptor.${props.surface}.${props.section.id}.${props.field.key}`;

    if (props.field.kind === 'unsupported') {
        return (
            <Item
                testID={testID}
                title={props.field.title}
                subtitle={t('settingsPlugins.unsupportedDescriptorField')}
                icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.textSecondary} />}
                showChevron={false}
                mode="info"
            />
        );
    }

    if (props.field.kind === 'boolean') {
        return (
            <Item
                testID={testID}
                title={props.field.title}
                subtitle={props.field.subtitle ?? undefined}
                icon={<Ionicons name="options-outline" size={29} color={theme.colors.textSecondary} />}
                rightElement={<Switch value={props.field.value === true} disabled={true} />}
                showChevron={false}
                mode="info"
            />
        );
    }

    if (props.field.kind === 'text') {
        return (
            <View testID={testID} style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>{props.field.title}</Text>
                {props.field.subtitle ? <Text style={styles.fieldValue}>{props.field.subtitle}</Text> : null}
                <Text style={styles.fieldValue}>{formatFieldValue(props.field) ?? t('common.unavailable')}</Text>
            </View>
        );
    }

    return (
        <Item
            testID={testID}
            title={props.field.title}
            subtitle={props.field.subtitle ?? undefined}
            detail={formatFieldValue(props.field)}
            icon={<Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />}
            showChevron={false}
            mode="info"
        />
    );
}

function PluginDescriptorSectionTitle(props: Readonly<{
    pluginId: string;
    surface: PluginProjectionSurface;
    section: PluginProjectionSection;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const toneIconName = resolveToneIconName(props.section.tone);
    const toneColor = resolveToneColor({ tone: props.section.tone, theme });
    const helpUrl = props.section.helpUrl;

    return (
        <View style={styles.sectionHeaderRow}>
            {toneIconName && toneColor ? (
                <Ionicons
                    testID={`settings.plugins.detail.${props.pluginId}.descriptor.${props.surface}.${props.section.id}.tone`}
                    name={toneIconName}
                    size={16}
                    color={toneColor}
                    style={{ marginRight: 8 }}
                />
            ) : null}
            <Text style={styles.sectionHeaderText} numberOfLines={1}>
                {props.section.title}
            </Text>
            {helpUrl ? (
                <Pressable
                    testID={`settings.plugins.detail.${props.pluginId}.descriptor.${props.surface}.${props.section.id}.help`}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.open')}
                    onPress={() => {
                        void openExternalUrl(helpUrl).catch(() => {});
                    }}
                    hitSlop={10}
                    style={styles.sectionHeaderHelpButton}
                >
                    <Ionicons name="help-circle-outline" size={18} color={theme.colors.textLink} />
                </Pressable>
            ) : null}
        </View>
    );
}

function PluginDescriptorSurfaceSection(props: Readonly<{
    pluginId: string;
    surface: PluginProjectionSurface;
    sections: readonly PluginProjectionSection[];
}>) {
    const { theme } = useUnistyles();

    if (props.sections.length === 0) {
        return null;
    }

    const sortedSections = React.useMemo(() => {
        return [...props.sections].sort((left, right) => compareByOrderThenTitle(left, right));
    }, [props.sections]);

    return (
        <>
            {sortedSections.map((section) => {
                const sortedFields = [...section.fields].sort((left, right) => compareByOrderThenTitle({
                    order: left.order,
                    title: left.title,
                    id: left.key,
                }, {
                    order: right.order,
                    title: right.title,
                    id: right.key,
                }));

                const groupTitle = section.tone || section.helpUrl
                    ? <PluginDescriptorSectionTitle pluginId={props.pluginId} surface={props.surface} section={section} />
                    : section.title;

                return (
                    <ItemGroup key={`${props.surface}:${section.id}`} title={groupTitle} footer={section.footer ?? undefined}>
                        {sortedFields.length > 0 ? sortedFields.map((field) => (
                        <PluginDescriptorFieldRow
                            key={field.key}
                            pluginId={props.pluginId}
                            surface={props.surface}
                            section={section}
                            field={field}
                        />
                    )) : (
                        <Item
                            testID={`settings.plugins.detail.${props.pluginId}.descriptor.${props.surface}.${section.id}.empty`}
                            title={t('common.unavailable')}
                            subtitle={t('settingsPlugins.noDescriptors')}
                            icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            mode="info"
                        />
                    )}
                    </ItemGroup>
                );
            })}
        </>
    );
}

export function PluginDetailDescriptorsSection(props: Readonly<{
    pluginId: string;
    projection: PluginProjectionEntry | null;
}>) {
    return (
        <>
            <PluginDescriptorSurfaceSection
                pluginId={props.pluginId}
                surface="status"
                sections={props.projection?.statusSections ?? []}
            />
            <PluginDescriptorSurfaceSection
                pluginId={props.pluginId}
                surface="settings"
                sections={props.projection?.settingsSections ?? []}
            />
            <PluginDescriptorSurfaceSection
                pluginId={props.pluginId}
                surface="setup"
                sections={props.projection?.setupSections ?? []}
            />
            <PluginDescriptorSurfaceSection
                pluginId={props.pluginId}
                surface="agentSettings"
                sections={props.projection?.agentSettingsSections ?? []}
            />
            <PluginDescriptorSurfaceSection
                pluginId={props.pluginId}
                surface="providerSettings"
                sections={props.projection?.providerSettingsSections ?? []}
            />
            <PluginDescriptorSurfaceSection
                pluginId={props.pluginId}
                surface="backendSettings"
                sections={props.projection?.backendSettingsSections ?? []}
            />
        </>
    );
}
