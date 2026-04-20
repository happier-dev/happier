import * as React from 'react';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { BadgeGrid, type BadgeGridItem } from '@/components/ui/layout/BadgeGrid';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import type { InstalledPluginUpdateState } from '../model/usePluginSettingsScreenState';

function resolveTrustStatus(trustPolicy: string | null | undefined): BadgeGridItem['status'] {
    if (!trustPolicy) return 'warning';
    if (trustPolicy === 'local_trusted' || trustPolicy === 'trusted') return 'positive';
    if (trustPolicy === 'prompt') return 'warning';
    return 'negative';
}

export function PluginDetailSummaryGrid(props: Readonly<{
    installed: InstalledPluginEntry;
    projection: PluginProjectionEntry | null;
    updateState: InstalledPluginUpdateState;
}>) {
    const generationLabel = props.projection?.generationLabel
        ?? (props.projection?.generation !== null && props.projection?.generation !== undefined ? String(props.projection.generation) : null);
    const provenance = props.projection?.provenance;
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
                label: provenance?.trustPolicy ?? props.installed.source.trustPolicy ?? t('common.unavailable'),
                detail: provenance?.sourceLabel ?? props.installed.source.kind,
                status: resolveTrustStatus(provenance?.trustPolicy ?? props.installed.source.trustPolicy),
            },
        ];

        if (generationLabel) {
            summaryItems.push({
                id: 'generation',
                label: t('settingsPlugins.generationLabel'),
                detail: generationLabel,
                status: 'neutral',
            });
        }

        if (props.updateState.canUpdate) {
            summaryItems.push({
                id: 'update',
                label: t('common.update'),
                detail: props.updateState.updateAvailable
                    ? (props.updateState.catalogVersion ?? props.installed.version)
                    : (props.updateState.sourceUrl ?? props.installed.version),
                status: props.updateState.updateAvailable ? 'positive' : 'neutral',
            });
        }

        return summaryItems;
    }, [generationLabel, props.installed, props.projection, props.updateState]);

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
