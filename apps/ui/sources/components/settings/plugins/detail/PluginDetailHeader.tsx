import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, PageHeaderStateSwitch, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { t } from '@/text';

import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import { PluginMark } from '../PluginMark';

function resolveTrustPolicyLabel(trustPolicy: string | null | undefined): string {
    switch (trustPolicy) {
        case 'local_trusted':
            return t('settingsPlugins.trustPolicy.localTrusted');
        case 'trusted':
            return t('settingsPlugins.trustPolicy.trusted');
        case 'prompt':
            return t('settingsPlugins.trustPolicy.prompt');
        case 'untrusted':
            return t('settingsPlugins.trustPolicy.untrusted');
        default:
            return trustPolicy
                ? t('settingsPlugins.unknownValue', { value: trustPolicy })
                : t('common.unavailable');
    }
}

function resolveSourceKindLabel(sourceKind: string | null | undefined): string {
    switch (sourceKind) {
        case 'bundled':
            return t('settingsPlugins.sourceKind.bundled');
        case 'path':
            return t('settingsPlugins.sourceKind.path');
        case 'marketplace':
            return t('settingsPlugins.sourceKind.marketplace');
        case 'package':
            return t('settingsPlugins.sourceKind.package');
        case 'archive':
            return t('settingsPlugins.sourceKind.archive');
        case 'catalog':
            return t('settingsPlugins.sourceKind.catalog');
        default:
            return sourceKind
                ? t('settingsPlugins.unknownValue', { value: sourceKind })
                : t('common.unavailable');
    }
}

/**
 * The facts that distinguish one installed plugin, in reading order: its id (what support, erase
 * and diagnostics ask for), the running version, where it came from, and the trust it was granted.
 * The installed trust grant outranks the source's future-admission policy; a runtime status the
 * plugin reports joins them. The host's internal generation is never a user fact.
 */
export function resolvePluginDetailFacts(
    installed: InstalledPluginEntry,
    projection: PluginProjectionEntry | null,
): readonly PageHeaderMetaFact[] {
    const provenance = projection?.provenance;
    const trustPolicy = installed.install.trust?.state === 'trusted'
        ? 'trusted'
        : provenance?.trustPolicy ?? installed.source.trustPolicy;
    const sourceKind = provenance?.sourceKind ?? installed.source.kind;
    const version = projection?.version ?? installed.version;
    // The status the plugin reports, with its detail (often the reason, e.g. what failed).
    const statusLabel = projection?.status?.label ?? null;
    const statusDetail = projection?.status?.detail ?? null;
    const runtimeStatus = statusLabel && statusDetail && statusDetail !== statusLabel
        ? `${statusLabel}: ${statusDetail}`
        : statusLabel ?? statusDetail;
    return [
        { key: 'id', text: installed.pluginId, testID: `settings.plugins.detail.${installed.pluginId}.id` },
        ...(version ? [{ key: 'version', text: version }] : []),
        { key: 'source', text: provenance?.sourceLabel ?? resolveSourceKindLabel(sourceKind) },
        {
            key: 'trust',
            text: resolveTrustPolicyLabel(trustPolicy),
            icon: trustPolicy === 'trusted' || trustPolicy === 'local_trusted' ? 'shield-check' as const : 'shield' as const,
        },
        ...(runtimeStatus ? [{ key: 'status', text: runtimeStatus }] : []),
    ];
}

/** Whether the plugin is offered at all, when this installation's lifecycle lets the user change it. */
export type PluginDetailEnabledControl = Readonly<{
    value: boolean;
    disabled: boolean;
    testID: string;
    onChange: () => void;
}>;

/**
 * A plugin page's identity: its mark, name and purpose, the facts that tell it apart, and the
 * page-level controls — whether it runs, and its rarer operations behind `⋯`.
 */
export const PluginDetailHeader = React.memo(function PluginDetailHeader(props: Readonly<{
    pluginId: string;
    installed: InstalledPluginEntry | null;
    projection: PluginProjectionEntry | null;
    enabled?: PluginDetailEnabledControl | null;
    menuActions?: readonly PageHeaderMenuAction[];
}>) {
    const styles = stylesheet;
    const title = props.projection?.title ?? props.installed?.title ?? props.pluginId;
    const description = props.projection?.description ?? props.installed?.description ?? undefined;
    const meta = props.installed
        ? resolvePluginDetailFacts(props.installed, props.projection)
        : [{ key: 'id', text: props.pluginId }, ...(props.projection?.version ? [{ key: 'version', text: props.projection.version }] : [])];
    const { enabled } = props;
    const hasMenu = (props.menuActions?.length ?? 0) > 0;
    return (
        <PageHeader
            testID={`settings.plugins.detail.${props.pluginId}.header`}
            alwaysShowTitle
            title={title}
            description={description}
            meta={meta}
            leading={<PluginMark title={title} iconAgentId={props.projection?.iconAgentId ?? null} size="page" />}
            actions={enabled || hasMenu ? (
                <View style={styles.actions}>
                    {enabled ? (
                        <PageHeaderStateSwitch
                            testID={enabled.testID}
                            label={t('common.enabled')}
                            value={enabled.value}
                            disabled={enabled.disabled}
                            onValueChange={enabled.onChange}
                        />
                    ) : null}
                    {hasMenu ? (
                        <PageHeaderMenu
                            testID={`settings.plugins.detail.${props.pluginId}.menu`}
                            actions={props.menuActions ?? []}
                        />
                    ) : null}
                </View>
            ) : undefined}
        />
    );
});

/**
 * The recovery route can remain available from Account-scoped data after its daemon projection has
 * disappeared. Its header names the plugin without implying that it is installed or active.
 */
export function PluginDetailRecoveryHeader(props: Readonly<{
    pluginId: string;
    title: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <PageHeader
            testID={`settings.plugins.detail.${props.pluginId}.recoveryHeader`}
            alwaysShowTitle
            title={props.title || props.pluginId}
            description={t('common.unavailable')}
            meta={[{ key: 'id', text: props.pluginId }]}
            leading={(
                <PageHeaderMarkSlot>
                    <Icon name="cloud-slash" size={20} color={theme.colors.text.secondary} />
                </PageHeaderMarkSlot>
            )}
        />
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
}));
