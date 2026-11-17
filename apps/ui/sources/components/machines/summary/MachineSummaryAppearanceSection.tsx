import * as React from 'react';

import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';

import { machineSummaryMetricTitle } from './MachineSummaryStrip';
import { MachineSummaryStyleTiles } from './MachineSummaryStyleTiles';
import { MACHINE_SUMMARY_METRICS, type MachineSummaryMetric } from './machineSummaryStripModel';
import { useMachineSummarySetting } from './useMachineSummarySetting';

const METRIC_DESCRIPTION_KEYS = {
    cpu: 'machineSummary.metricDescriptions.cpu',
    memory: 'machineSummary.metricDescriptions.memory',
    disk: 'machineSummary.metricDescriptions.disk',
    network: 'machineSummary.metricDescriptions.network',
} as const satisfies Record<MachineSummaryMetric, string>;

/**
 * Appearance › Machine summary: how every machine's resources read on this device. The page says what it
 * is for; Style is the visual tiles (4-up; 2-up on phones), then Show is one switch row per metric. Any
 * metric may be off, all of them included: rows then show names only (R42.6). The Machines rail's
 * sparkline follows this same setting (owner ruling 2026-11-15).
 */
export const MachineSummaryAppearanceSection = React.memo(function MachineSummaryAppearanceSection(props: Readonly<{ phone: boolean }>) {
    const setting = useMachineSummarySetting();
    return (
        <>
            <ItemGroup title={t('machineSummary.styleTitle')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.machineSummaryStyle}>
                    <SectionContentRow>
                        <MachineSummaryStyleTiles value={setting.style} metrics={setting.metrics} onChange={setting.setStyle}
                            columns={props.phone ? 2 : 4} testIdPrefix="settings-appearance-machineSummary-style" />
                    </SectionContentRow>
                </SettingAnchor>
            </ItemGroup>
            <ItemGroup title={t('machineSummary.showTitle')} description={t('machineSummary.showDescription')}>
                <SettingAnchor setting={APPEARANCE_SETTINGS.settings.machineSummaryMetrics}>
                    <>
                        {MACHINE_SUMMARY_METRICS.map(metric => {
                            const on = setting.metrics.includes(metric);
                            return (
                                <Item
                                    key={metric}
                                    testID={`settings-appearance-machineSummary-show-${metric}`}
                                    title={machineSummaryMetricTitle(metric)}
                                    subtitle={t(METRIC_DESCRIPTION_KEYS[metric])}
                                    showChevron={false}
                                    rightElement={<Switch value={on} onValueChange={() => setting.toggleMetric(metric)} />}
                                    onPress={() => setting.toggleMetric(metric)}
                                />
                            );
                        })}
                    </>
                </SettingAnchor>
            </ItemGroup>
        </>
    );
});
