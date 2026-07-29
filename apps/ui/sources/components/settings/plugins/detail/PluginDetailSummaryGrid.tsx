import * as React from 'react';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';

function resolveTrustStatus(trustPolicy: string | null | undefined): BadgeGridItem['status'] {
    if (!trustPolicy) return 'warning';
    if (trustPolicy === 'local_trusted' || trustPolicy === 'trusted') return 'positive';
    if (trustPolicy === 'prompt') return 'warning';
    return 'negative';
}

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

export function PluginDetailSummaryGrid(props: Readonly<{
    installed: InstalledPluginEntry;
    projection: PluginProjectionEntry | null;
}>) {
    const provenance = props.projection?.provenance;
    const trustPolicy = provenance?.trustPolicy ?? props.installed.source.trustPolicy;
    const sourceKind = provenance?.sourceKind ?? props.installed.source.kind;
    const items = React.useMemo<BadgeGridItem[]>(() => {
        const summaryItems: BadgeGridItem[] = [
            {
                id: 'status',
                label: props.projection?.status?.label ?? (props.installed.enabled ? t('common.enabled') : t('common.disabled')),
                detail: props.projection?.status?.detail ?? props.installed.version,
                status: props.installed.enabled ? 'positive' : 'warning',
            },
            {
                id: 'version',
                label: t('common.version'),
                detail: props.projection?.version ?? props.installed.version,
                status: 'neutral',
            },
            {
                id: 'trust',
                label: resolveTrustPolicyLabel(trustPolicy),
                detail: provenance?.sourceLabel ?? resolveSourceKindLabel(sourceKind),
                status: resolveTrustStatus(trustPolicy),
            },
        ];

        return summaryItems;
    }, [
        props.installed.enabled,
        props.installed.version,
        props.projection?.status?.detail,
        props.projection?.status?.label,
        props.projection?.version,
        provenance?.sourceLabel,
        sourceKind,
        trustPolicy,
    ]);

    return (
        <ItemGroup title={t('common.details')}>
            <BadgeGrid
                testID={`settings.plugins.detail.${props.installed.pluginId}.summary`}
                items={items}
                columns={2}
            />
        </ItemGroup>
    );
}
