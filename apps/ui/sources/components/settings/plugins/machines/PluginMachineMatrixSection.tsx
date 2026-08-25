import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import type { PluginMachineMatrixCellStateV1, PluginMachineMatrixCellV1 } from './pluginMachineMatrix';
import { usePluginMachineMatrix } from './usePluginMachineMatrix';

function stateLabel(state: PluginMachineMatrixCellStateV1): string {
    switch (state) {
        case 'installedCurrent':
            return t('settingsPlugins.machineMatrix.state.installedCurrent');
        case 'disabled':
            return t('settingsPlugins.machineMatrix.state.disabled');
        case 'untrusted':
            return t('settingsPlugins.machineMatrix.state.untrusted');
        case 'incompatible':
            return t('settingsPlugins.machineMatrix.state.incompatible');
        case 'localOnly':
            return t('settingsPlugins.machineMatrix.state.localOnly');
        case 'staleOffline':
            return t('settingsPlugins.machineMatrix.state.staleOffline');
        // The machine, not the plugin, is unavailable. Reuses the exact word
        // the Administration machine picker already gives this same fact.
        case 'machineUnavailable':
            return t('common.unavailable');
        case 'absent':
            return t('settingsPlugins.machineMatrix.state.absent');
        case 'unknown':
            return t('settingsPlugins.machineMatrix.state.unknown');
    }
}

/**
 * Never renders a live claim for a cached row: a version is always shown as
 * the last observation, with its age, so an offline machine's prior state
 * cannot read as current fact.
 */
function cellSubtitle(cell: PluginMachineMatrixCellV1): string | undefined {
    const parts = [cell.serverLabel];
    if (cell.version) parts.push(`${t('common.version')} ${cell.version}`);
    const ago = typeof cell.observedAt === 'number' ? formatShortRelativeTime(cell.observedAt) : '';
    if (ago && (cell.observation === 'stale' || cell.state !== 'installedCurrent')) {
        parts.push(t('settingsPlugins.machineMatrix.lastObserved', { ago }));
    }
    return parts.filter((part) => part.length > 0).join(' · ') || undefined;
}

/**
 * The Account-wide, read-only answer to "where is this plugin installed, and
 * where is it broken or missing?".
 *
 * It is structurally incapable of retargeting anything: its props carry no
 * callback, its rows carry no portable target or execution origin, and every
 * row renders in the non-interactive `info` mode. Administration mutations
 * stay bound to the exact machine selected in the administration picker.
 */
export const PluginMachineMatrixSection = React.memo(function PluginMachineMatrixSection(props: Readonly<{
    /** Restricts the matrix to one plugin on the plugin detail route. */
    pluginId?: string;
    testIDPrefix?: string;
}>) {
    const matrix = usePluginMachineMatrix(
        props.pluginId === undefined ? {} : { pluginId: props.pluginId },
    );
    const prefix = props.testIDPrefix ?? 'settings.plugins.machineMatrix';

    if (matrix.kind === 'unavailable') {
        return (
            <ItemGroup title={t('settingsPlugins.machineMatrix.title')}>
                <Item
                    testID={`${prefix}.unavailable`}
                    title={t('settingsPlugins.machineMatrix.unavailable')}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (matrix.rows.length === 0) {
        return (
            <ItemGroup title={t('settingsPlugins.machineMatrix.title')} footer={t('settingsPlugins.machineMatrix.footer')}>
                <Item
                    testID={`${prefix}.empty`}
                    title={t('settingsPlugins.machineMatrix.empty')}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const footer = matrix.unresolvedServerCount > 0
        ? `${t('settingsPlugins.machineMatrix.footer')} ${t('settingsPlugins.machineMatrix.incomplete', { count: matrix.unresolvedServerCount })}`
        : t('settingsPlugins.machineMatrix.footer');

    return (
        <>
            {matrix.rows.map((row, index) => (
                <ItemGroup
                    key={row.pluginId}
                    {...(index === 0 ? { title: t('settingsPlugins.machineMatrix.title') } : {})}
                    {...(index === matrix.rows.length - 1 ? { footer } : {})}
                >
                    <Item
                        testID={`${prefix}.${row.pluginId}.summary`}
                        title={row.pluginId}
                        detail={t('settingsPlugins.machineMatrix.summary', {
                            installed: row.installedCurrentCount,
                            total: matrix.machineCount,
                        })}
                        mode="info"
                        showChevron={false}
                    />
                    {row.cells.map((cell) => (
                        <Item
                            key={cell.machineKey}
                            testID={`${prefix}.${row.pluginId}.cell`}
                            title={cell.machineName}
                            subtitle={cellSubtitle(cell)}
                            detail={stateLabel(cell.state)}
                            accessibilityLabel={`${cell.machineName}: ${stateLabel(cell.state)}`}
                            mode="info"
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ))}
        </>
    );
});
