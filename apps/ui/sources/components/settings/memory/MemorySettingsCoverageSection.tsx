import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import {
    readMemoryCoveragePolicy,
    withMemoryCoveragePolicy,
} from './memorySettingsPolicies';

type CoveragePolicyId = MemorySettingsV1['coveragePolicy']['type'];

export const MemorySettingsCoverageSection = React.memo(function MemorySettingsCoverageSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const [coverageMenuOpen, setCoverageMenuOpen] = React.useState(false);
    const coveragePolicy = readMemoryCoveragePolicy(props.settings);
    const items = React.useMemo<ReadonlyArray<Readonly<{ id: CoveragePolicyId; title: string; subtitle: string }>>>(() => [
        {
            id: 'full',
            title: t('memorySearchSettings.coverage.options.fullTitle'),
            subtitle: t('memorySearchSettings.coverage.options.fullSubtitle'),
        },
        {
            id: 'latest_messages',
            title: t('memorySearchSettings.coverage.options.latestMessagesTitle'),
            subtitle: t('memorySearchSettings.coverage.options.latestMessagesSubtitle'),
        },
        {
            id: 'latest_days',
            title: t('memorySearchSettings.coverage.options.latestDaysTitle'),
            subtitle: t('memorySearchSettings.coverage.options.latestDaysSubtitle'),
        },
        {
            id: 'since_enabled',
            title: t('memorySearchSettings.coverage.options.sinceEnabledTitle'),
            subtitle: t('memorySearchSettings.coverage.options.sinceEnabledSubtitle'),
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
        <ItemGroup
            title={t('memorySearchSettings.coverage.title')}
            footer={t('memorySearchSettings.coverage.footer')}
        >
            <DropdownMenu
                open={coverageMenuOpen}
                onOpenChange={setCoverageMenuOpen}
                selectedId={coveragePolicy.type}
                items={items}
                onSelect={(id) => {
                    void props.writeSettings(withMemoryCoveragePolicy(props.settings, buildPolicy(id)));
                    setCoverageMenuOpen(false);
                }}
                itemTrigger={{
                    title: t('memorySearchSettings.coverage.triggerTitle'),
                    icon: <Icon name="funnel-simple" size={29} color={theme.colors.accent.indigo} />,
                }}
            />
        </ItemGroup>
    );
});
