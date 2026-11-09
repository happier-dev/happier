import * as React from 'react';

import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import {
    readMemoryCoveragePolicy,
    withMemoryCoveragePolicy,
} from './memorySettingsPolicies';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';

type CoveragePolicyId = MemorySettingsV1['coveragePolicy']['type'];

export const MemorySettingsCoverageRow = React.memo(function MemorySettingsCoverageRow(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
    /** Set by the enclosing `ItemGroup`. */
    showDivider?: boolean;
}>) {
    const coveragePolicy = readMemoryCoveragePolicy(props.settings);
    const options = React.useMemo<ReadonlyArray<Readonly<{ id: CoveragePolicyId; label: string; description: string }>>>(() => [
        {
            id: 'full',
            label: t('memorySearchSettings.coverage.options.fullTitle'),
            description: t('memorySearchSettings.coverage.options.fullSubtitle'),
        },
        {
            id: 'latest_messages',
            label: t('memorySearchSettings.coverage.options.latestMessagesTitle'),
            description: t('memorySearchSettings.coverage.options.latestMessagesSubtitle'),
        },
        {
            id: 'latest_days',
            label: t('memorySearchSettings.coverage.options.latestDaysTitle'),
            description: t('memorySearchSettings.coverage.options.latestDaysSubtitle'),
        },
        {
            id: 'since_enabled',
            label: t('memorySearchSettings.coverage.options.sinceEnabledTitle'),
            description: t('memorySearchSettings.coverage.options.sinceEnabledSubtitle'),
        },
    ], []);

    const buildPolicy = React.useCallback((id: string): MemorySettingsV1['coveragePolicy'] => {
        if (id === 'latest_messages') {
            return {
                type: 'latest_messages',
                maxSemanticMessagesPerSession:
                    coveragePolicy.type === 'latest_messages'
                        ? coveragePolicy.maxSemanticMessagesPerSession
                        : 1000,
            };
        }
        if (id === 'latest_days') {
            return {
                type: 'latest_days',
                days: coveragePolicy.type === 'latest_days' ? coveragePolicy.days : 30,
            };
        }
        if (id === 'since_enabled') {
            return { type: 'since_enabled' };
        }
        return { type: 'full' };
    }, [coveragePolicy]);

    return (
        <SettingAnchor setting={MEMORY_SETTINGS.settings.coverage} showDivider={props.showDivider}>
            <SegmentedChoiceItem<CoveragePolicyId>
                title={t(MEMORY_SETTINGS.settings.coverage.titleKey)}
                subtitleLines={0}
                testIDPrefix="memory-settings-coverage"
                value={coveragePolicy.type}
                options={options}
                onChange={(id) => {
                    void props.writeSettings(withMemoryCoveragePolicy(props.settings, buildPolicy(id)));
                }}
            />
        </SettingAnchor>
    );
});
