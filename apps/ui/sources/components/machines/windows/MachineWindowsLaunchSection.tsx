import * as React from 'react';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import {
    readMachineWindowsRemoteSessionLaunchMode,
    resolveEffectiveWindowsRemoteSessionLaunchMode,
} from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';
import { useSetting } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';

/**
 * How remote sessions open on a Windows machine (Terminal sub-page): follow the account's launch mode,
 * or override it for this machine. Absent on other platforms.
 */
export const MachineWindowsLaunchSection = React.memo(function MachineWindowsLaunchSection(props: Readonly<{
    machine: Machine;
    serverId: string;
    /** Whether the machine reported Windows Terminal. */
    windowsTerminalAvailable: boolean;
}>) {
    const { machine, windowsTerminalAvailable } = props;
    const machineId = machine.id;
    const machineServerId = props.serverId;
    const metadata = machine.metadata;
    const isWindowsMachine = metadata?.platform === 'win32';
    const stopExecution = useMountedActionExecution(machineServerId);
    const windowsRemoteSessionLaunchModeDefault = useSetting('sessionWindowsRemoteSessionLaunchMode');
    const [isUpdatingWindowsConsoleMode, setIsUpdatingWindowsConsoleMode] = React.useState(false);
    const [openWindowsRemoteSessionLaunchModeMenu, setOpenWindowsRemoteSessionLaunchModeMenu] = React.useState(false);
    const machineWindowsRemoteSessionLaunchMode = readMachineWindowsRemoteSessionLaunchMode(metadata);
    const windowsRemoteSessionLaunchModeOverrideEnabled = isWindowsMachine && machineWindowsRemoteSessionLaunchMode !== undefined;
    const effectiveWindowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
        machineMetadata: metadata,
        settings: { sessionWindowsRemoteSessionLaunchMode: windowsRemoteSessionLaunchModeDefault },
    }).mode;

    const updateMachineWindowsRemoteSessionLaunchMode = React.useCallback(async (mode: 'hidden' | 'windows_terminal' | 'console' | null) => {
        if (!machine.metadata || machine.metadata.platform !== 'win32') return;
        setIsUpdatingWindowsConsoleMode(true);
        try {
            const execution = await stopExecution.execute('machines.metadata.update', {
                serverId: machineServerId, machineId, expectedVersion: machine.metadataVersion,
                patch: { windowsRemoteSessionLaunchMode: mode },
            });
            if (!execution.ok) throw new Error(resolveActionExecutionErrorMessage(execution, t('machine.windows.remoteSessionConsoleUpdateFailed')));
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('machine.windows.remoteSessionConsoleUpdateFailed'),
            );
            await sync.refreshMachines();
        } finally {
            setIsUpdatingWindowsConsoleMode(false);
        }
    }, [machine, machineId, machineServerId, stopExecution]);

    const setWindowsRemoteSessionLaunchModeOverrideEnabled = React.useCallback(async (enabled: boolean) => {
        if (!enabled) {
            await updateMachineWindowsRemoteSessionLaunchMode(null);
            return;
        }
        await updateMachineWindowsRemoteSessionLaunchMode(effectiveWindowsRemoteSessionLaunchMode ?? windowsRemoteSessionLaunchModeDefault);
    }, [effectiveWindowsRemoteSessionLaunchMode, updateMachineWindowsRemoteSessionLaunchMode, windowsRemoteSessionLaunchModeDefault]);

    if (!isWindowsMachine || !canManageMachine(machine)) return null;
    return (
        <ItemGroup title={t('machine.windows.title')} description={t('machineDetailPage.windowsSectionDescription')}>
            <Item
                title={t('machine.windows.remoteSessionModeOverrideTitle')}
                subtitle={
                    windowsRemoteSessionLaunchModeOverrideEnabled
                        ? t('machine.windows.remoteSessionModeOverrideEnabledSubtitle')
                        : t('machine.windows.remoteSessionModeOverrideDisabledSubtitle')
                }
                rightElement={
                    <Switch
                        value={windowsRemoteSessionLaunchModeOverrideEnabled}
                        onValueChange={setWindowsRemoteSessionLaunchModeOverrideEnabled}
                        disabled={isUpdatingWindowsConsoleMode}
                    />
                }
                showChevron={false}
                disabled={isUpdatingWindowsConsoleMode}
                onPress={() => setWindowsRemoteSessionLaunchModeOverrideEnabled(!windowsRemoteSessionLaunchModeOverrideEnabled)}
            />
            {windowsRemoteSessionLaunchModeOverrideEnabled ? (
                <DropdownMenu
                    open={openWindowsRemoteSessionLaunchModeMenu}
                    onOpenChange={setOpenWindowsRemoteSessionLaunchModeMenu}
                    items={WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.map((option) => ({
                        id: option.value,
                        title: t(option.labelKey),
                        subtitle: option.value === 'windows_terminal' && !windowsTerminalAvailable
                            ? `${t(option.subtitleKey)} ${t('machine.windows.windowsTerminalUnavailableSuffix')}`
                            : t(option.subtitleKey),
                        disabled: option.value === 'windows_terminal' && !windowsTerminalAvailable,
                    }))}
                    selectedId={machineWindowsRemoteSessionLaunchMode ?? effectiveWindowsRemoteSessionLaunchMode ?? windowsRemoteSessionLaunchModeDefault}
                    onSelect={(id) => {
                        if (id === 'hidden' || id === 'windows_terminal' || id === 'console') {
                            void updateMachineWindowsRemoteSessionLaunchMode(id);
                        }
                    }}
                    itemTrigger={{
                        title: t('machine.windows.remoteSessionModeTitle'),
                        subtitle: t(
                            WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.find((option) =>
                                option.value === (machineWindowsRemoteSessionLaunchMode ?? effectiveWindowsRemoteSessionLaunchMode ?? windowsRemoteSessionLaunchModeDefault)
                            )?.subtitleKey ?? 'windowsRemoteSessionLaunchMode.hiddenSubtitle',
                        ),
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
            ) : null}
        </ItemGroup>
    );
});
