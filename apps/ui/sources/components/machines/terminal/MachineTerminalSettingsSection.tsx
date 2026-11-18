import * as React from 'react';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SettingTextInput } from '@/components/settings/shell/SettingTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Modal } from '@/modal';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { useSettingsSelector } from '@/sync/store/hooks';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * How new sessions on this machine use a terminal host (Terminal sub-page): follow the account's host,
 * or override it here with its tmux details. Changes go through the keyed `machines.terminal.host`
 * setting, so they are the same Action an agent would use.
 */
export const MachineTerminalSettingsSection = React.memo(function MachineTerminalSettingsSection(props: Readonly<{
    machineId: string;
    serverId: string;
    /** Whether the machine reported tmux; `null` while unknown. */
    tmuxAvailable: boolean | null;
}>) {
    const { machineId, tmuxAvailable } = props;
    const stopExecution = useMountedActionExecution(props.serverId);
    const { tmuxOverride, tmuxOverrideEnabled, selectedGlobalTerminalHost, selectedMachineTerminalHost } = useSettingsSelector(settings => {
        const tmuxOverride = machineId && Object.hasOwn(settings.sessionTmuxByMachineId, machineId)
            ? settings.sessionTmuxByMachineId[machineId] : undefined;
        return {
            tmuxOverride,
            tmuxOverrideEnabled: Boolean(tmuxOverride || (machineId && Object.hasOwn(settings.sessionTerminalHostByMachineId, machineId))),
            selectedGlobalTerminalHost: resolveTerminalHost({ settings, machineId: null }),
            selectedMachineTerminalHost: resolveTerminalHost({ settings, machineId }),
        };
    }, ['sessionTerminalHost', 'sessionUseTmux', 'sessionTerminalHostByMachineId', 'sessionTmuxByMachineId']);

    const setTmuxOverrideEnabled = React.useCallback((enabled: boolean) => {
        if (!machineId) return;
        fireAndForget((async () => {
            const result = await stopExecution.execute('settings.set', { anchor: 'machines.terminal.host', key: machineId,
                value: { host: enabled ? selectedGlobalTerminalHost : null } });
            if (!result.ok) Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(result, t('common.requestFailed')));
        })(), { tag: 'MachineTerminalSettingsSection.setTerminalHostOverride' });
    }, [machineId, stopExecution, selectedGlobalTerminalHost]);

    const updateTmuxOverride = React.useCallback(async (patch: Partial<NonNullable<typeof tmuxOverride>>) => {
        if (!machineId || !tmuxOverride) return false;
        const { useTmux: _host, ...tmux } = patch;
        try {
            const result = await stopExecution.execute('settings.set', { anchor: 'machines.terminal.host', key: machineId,
                value: { tmux } });
            if (!result.ok) Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(result, t('common.requestFailed')));
            return result.ok;
        } catch {
            Modal.alert(t('common.error'), t('common.unavailable'));
            return false;
        }
    }, [machineId, stopExecution, tmuxOverride]);

    const setTerminalHostOverride = React.useCallback((next: 'none' | 'tmux' | 'zellij' | 'herdr') => {
        if (next === 'tmux' && tmuxAvailable === false) {
            Modal.alert(t('common.error'), t('machine.tmux.notDetectedMessage'));
            return;
        }
        if (!machineId) return;
        fireAndForget((async () => {
            const result = await stopExecution.execute('settings.set', { anchor: 'machines.terminal.host', key: machineId,
                value: { host: next } });
            if (!result.ok) Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(result, t('common.requestFailed')));
        })(), { tag: 'MachineTerminalSettingsSection.setTerminalHost' });
    }, [tmuxAvailable, machineId, stopExecution]);

    return (
        <ItemGroup title={t('settingsSessionPages.runtime.terminalSection')} description={t('settingsSessionPages.runtime.pageDescription')}>
            <Item
                title={t('machine.tmux.overrideTitle')}
                subtitle={tmuxOverrideEnabled ? t('machine.tmux.overrideEnabledSubtitle') : t('machine.tmux.overrideDisabledSubtitle')}
                rightElement={<Switch value={tmuxOverrideEnabled} onValueChange={setTmuxOverrideEnabled} />}
                showChevron={false}
                onPress={() => setTmuxOverrideEnabled(!tmuxOverrideEnabled)}
            />

            {!tmuxOverrideEnabled && (
                <Item
                    testID="machine-terminal-effective-host"
                    title={t('settingsSessionPages.runtime.terminalHostTitle')}
                    subtitle={selectedMachineTerminalHost === 'none'
                        ? t('settingsSessionPages.runtime.terminalHostNone')
                        : selectedMachineTerminalHost === 'herdr' ? 'Herdr'
                            : selectedMachineTerminalHost === 'zellij' ? 'Zellij' : 'tmux'}
                    mode="info"
                    showChevron={false}
                />
            )}

            {tmuxOverrideEnabled && (
                <>
                    <SegmentedChoiceItem<'none' | 'tmux' | 'zellij' | 'herdr'>
                        title={t('settingsSessionPages.runtime.terminalHostTitle')}
                        options={[
                            { id: 'none', label: t('settingsSessionPages.runtime.terminalHostNone') },
                            { id: 'tmux', label: 'tmux', unavailableReason: tmuxAvailable === false ? t('machine.tmux.notDetectedSubtitle') : undefined },
                            { id: 'zellij', label: 'Zellij' },
                            { id: 'herdr', label: 'Herdr' },
                        ]}
                        value={selectedMachineTerminalHost}
                        onChange={setTerminalHostOverride}
                    />

                    {selectedMachineTerminalHost === 'tmux' && tmuxOverride && (
                        <>
                            <Item
                                title={t('profiles.tmuxSession')}
                                subtitle={t('common.optional')}
                                showChevron={false}
                                mode="info"
                                accessoryLayout="adaptive"
                                rightElement={(
                                    <SettingTextInput
                                        key={machineId}
                                        accessibilityLabel={t('profiles.tmuxSession')}
                                        placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                        value={tmuxOverride.sessionName}
                                        onCommit={(value) => updateTmuxOverride({ sessionName: value })}
                                        autoCapitalize="none"
                                        monospace
                                    />
                                )}
                            />

                            <Item
                                title={t('profiles.tmux.isolatedServerTitle')}
                                subtitle={tmuxOverride.isolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                                rightElement={<Switch value={tmuxOverride.isolated} onValueChange={(next) => { void updateTmuxOverride({ isolated: next }); }} />}
                                showChevron={false}
                                onPress={() => { void updateTmuxOverride({ isolated: !tmuxOverride.isolated }); }}
                            />

                            {tmuxOverride.isolated && (
                                <Item
                                    title={t('profiles.tmuxTempDir')}
                                    subtitle={t('common.optional')}
                                    showChevron={false}
                                    mode="info"
                                    accessoryLayout="adaptive"
                                    rightElement={(
                                        <SettingTextInput
                                            key={machineId}
                                            accessibilityLabel={t('profiles.tmuxTempDir')}
                                            placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                            value={tmuxOverride.tmpDir ?? ''}
                                            normalize={value => value.trim().length > 0 ? value : ''}
                                            onCommit={(value) => updateTmuxOverride({ tmpDir: value || null })}
                                            autoCapitalize="none"
                                            monospace
                                        />
                                    )}
                                />
                            )}
                        </>
                    )}
                </>
            )}
        </ItemGroup>
    );
});
