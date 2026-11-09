import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';

import type { ThisComputerConnection } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { resolveHomeDisplayNameForRelayUrl } from '@/components/settings/server/homeDisplayName';

import { presentThisComputerConnection } from './thisComputerConnectionPresentation';
import { ThisComputerServersGroup } from './ThisComputerServersGroup';
import { readKeptCliUpdateCommand, useLocalDaemonControl, type LocalCliUpdateStatus, type LocalDaemonStatusData } from './useLocalDaemonControl';
import { useThisComputerConnection } from './useThisComputerConnection';

/** One sentence about this computer from the shared connection owner (never a local reading). */
function resolveStatusSubtitle(
    status: ReturnType<typeof useLocalDaemonControl>['status'],
    connection: ThisComputerConnection | null,
    activeRelayUrl: string | null,
): string {
    if (!status) {
        return t('machine.daemonStatus.unknown');
    }
    if (!connection) {
        // No daemon here yet: the ordinary first-run state, stated plainly.
        return activeRelayUrl
            ? t('machine.thisComputer.description.daemon_not_installed', { home: resolveHomeDisplayNameForRelayUrl(activeRelayUrl) ?? t('settingsAccount.thisHomeTitle') })
            : t('machine.daemonStatus.stopped');
    }
    return presentThisComputerConnection(connection)?.description
        ?? t('machine.thisComputer.connected', { home: connection.homeLabel, appAccount: connection.appAccountLabel });
}

/** R17: the CLI version, and the version it can update to, from the CLI's own cached check. */
function resolveCliVersionTitle(cliUpdate: LocalCliUpdateStatus | null): string | null {
    if (!cliUpdate) return null;
    return cliUpdate.updateAvailable && cliUpdate.latestVersion
        ? t('machine.thisComputer.cli.updateAvailable', {
            version: cliUpdate.currentVersion,
            latestVersion: cliUpdate.latestVersion,
        })
        : t('machine.thisComputer.cli.version', { version: cliUpdate.currentVersion });
}

/** The repair row names the repair the current state needs, when it needs one. */
function resolveRepairTitle(connection: ThisComputerConnection | null): string {
    switch (connection?.status) {
        case 'daemon_url_mismatch':
        case 'daemon_account_mismatch':
        case 'daemon_needs_auth':
        case 'daemon_not_configured':
            return presentThisComputerConnection(connection)?.actionLabel ?? t('machine.repairBackgroundServiceAction');
        default:
            return t('machine.repairBackgroundServiceAction');
    }
}

/**
 * R12: once this computer answered who manages the command line, the CLI row says that answer;
 * otherwise a CLI the app did not install is named by where it came from.
 */
function resolveCliSubtitle(status: LocalDaemonStatusData): string | undefined {
    const cliUpdate = status.cliUpdate;
    if (status.cliChoice?.mode === 'own' && cliUpdate && !cliUpdate.managed && cliUpdate.origin) {
        return t('machine.thisComputer.cliChoice.own', { path: cliUpdate.origin });
    }
    if (status.cliChoice?.mode === 'managed' && cliUpdate?.managed) {
        return t('machine.thisComputer.cliChoice.managed');
    }
    return cliUpdate && !cliUpdate.managed && cliUpdate.origin
        ? t('machine.thisComputer.cli.notManaged', { origin: cliUpdate.origin })
        : undefined;
}

/**
 * R12: the copy of `happier` still installed beside the managed one. Its removal command is shown
 * and copyable, never run: it belongs to the package manager.
 */
function resolveOldCliCopy(status: LocalDaemonStatusData | null): Readonly<{ subtitle: string; removalCommand: string | null }> | null {
    const other = status?.cliChoice?.mode === 'managed' ? status.cliChoice.otherCli : null;
    if (!other) return null;
    return {
        subtitle: other.removalCommand
            ? t('machine.thisComputer.cliChoice.oldCopyRemove', { path: other.command, command: other.removalCommand })
            : t('machine.thisComputer.cliChoice.oldCopyPath', { path: other.command }),
        removalCommand: other.removalCommand,
    };
}

export const LocalDaemonControlSection = React.memo(function LocalDaemonControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const {
        activeRelayUrl,
        activeTaskSnapshot,
        activeTaskTitle,
        canRepair,
        canStart,
        canInstall,
        canUpdateCli,
        canChangeCommandLine,
        changeCommandLine,
        cliUpdateErrorMessage,
        showInstallBackgroundService,
        cancel,
        lastErrorMessage,
        installBackgroundService,
        repairBackgroundService,
        startDaemonService,
        updateCli,
        status,
        isBusy,
        isUnavailable,
        refreshStatus,
    } = useLocalDaemonControl({
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const connection = useThisComputerConnection(status);
    const cliVersionTitle = resolveCliVersionTitle(status?.cliUpdate ?? null);
    const cliSubtitle = status ? resolveCliSubtitle(status) : undefined;
    const oldCliCopy = resolveOldCliCopy(status);
    // A11-08: an update to the command line the person kept is theirs to run; say exactly how.
    const keptCliUpdateCommand = status?.cliUpdate?.updateAvailable && !status.cliUpdate.managed
        ? readKeptCliUpdateCommand(status)
        : null;
    const showChangeCommandLine = status?.cliChoice?.otherCli != null;
    const handleRepair = repairBackgroundService;

    return (
        <>
            <ItemGroup
                title={t('settingsMachines.daemonTitle')}
                description={t('settingsMachines.daemonDescription')}
                action={(
                    <SectionActionButton
                        testID="settings.localDaemonControl.refresh"
                        title={t('common.refresh')}
                        icon="arrows-clockwise"
                        onPress={() => {
                            void refreshStatus();
                        }}
                        disabled={isBusy || isUnavailable}
                    />
                )}
            >
                <Item
                    testID="settings.localDaemonControl.status"
                    title={t('machine.status')}
                    subtitle={isUnavailable ? t('settings.systemTaskBridgeUnavailable') : resolveStatusSubtitle(status, connection, activeRelayUrl || null)}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />
                {status?.machineId ? (
                    <Item
                        testID="settings.localDaemonControl.machineId"
                        title={t('machine.machineId')}
                        subtitle={status.machineId}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        subtitleLines={0}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {/* Operations are buttons, not destinations: one row of them under the status. */}
                <SectionContentRow>
                    <View style={styles.actions}>
                        {showInstallBackgroundService ? (
                            <RoundButton
                                testID="settings.localDaemonControl.install"
                                size="small"
                                title={t('sessionGettingStarted.steps.daemonInstall.title')}
                                accessibilityHint={t('sessionGettingStarted.steps.daemonInstall.description')}
                                onPress={() => {
                                    void installBackgroundService();
                                }}
                                disabled={!canInstall}
                            />
                        ) : null}
                        <RoundButton
                            testID="settings.localDaemonControl.start"
                            size="small"
                            display="secondary"
                            title={t('machine.thisComputer.action.daemon_not_running')}
                            onPress={() => {
                                void startDaemonService();
                            }}
                            disabled={!canStart}
                        />
                        <RoundButton
                            testID="settings.localDaemonControl.repair"
                            size="small"
                            display="secondary"
                            title={resolveRepairTitle(connection)}
                            onPress={() => {
                                void handleRepair();
                            }}
                            disabled={!canRepair}
                        />
                    </View>
                </SectionContentRow>
            </ItemGroup>
            {/* R15 d: every Home this computer serves, from the status read above (R13C-F4). */}
            {status && !isUnavailable ? <ThisComputerServersGroup {...(props.runner ? { runner: props.runner } : {})} /> : null}
            {cliVersionTitle && status?.cliUpdate ? (
                <ItemGroup title={t('machine.thisComputer.cli.title')}>
                    <Item
                        testID="settings.localDaemonControl.cliVersion"
                        title={cliVersionTitle}
                        {...(cliSubtitle ? { subtitle: cliSubtitle } : {})}
                        showChevron={false}
                        mode="info"
                    />
                    {keptCliUpdateCommand ? (
                        <Item
                            testID="settings.localDaemonControl.keptCliUpdate"
                            title={t('machine.thisComputer.cliChoice.keptUpdateTitle')}
                            subtitle={t('machine.thisComputer.cliChoice.keptUpdate', { command: keptCliUpdateCommand })}
                            subtitleLines={0}
                            copy={keptCliUpdateCommand}
                            showChevron={false}
                            mode="interactive"
                        />
                    ) : null}
                    {oldCliCopy ? (
                        <Item
                            testID="settings.localDaemonControl.oldCli"
                            title={t('machine.thisComputer.cliChoice.oldCopyTitle')}
                            subtitle={oldCliCopy.subtitle}
                            subtitleLines={0}
                            {...(oldCliCopy.removalCommand ? { copy: oldCliCopy.removalCommand } : {})}
                            showChevron={false}
                            mode={oldCliCopy.removalCommand ? 'interactive' : 'info'}
                        />
                    ) : null}
                    {cliUpdateErrorMessage ? (
                        <Item
                            testID="settings.localDaemonControl.cliUpdateError"
                            title={t('common.error')}
                            subtitle={cliUpdateErrorMessage}
                            subtitleLines={0}
                            showChevron={false}
                            mode="info"
                        />
                    ) : null}
                    {(status.cliUpdate.managed && status.cliUpdate.updateAvailable) || showChangeCommandLine ? (
                        <SectionContentRow>
                            <View style={styles.actions}>
                                {status.cliUpdate.managed && status.cliUpdate.updateAvailable ? (
                                    <RoundButton
                                        testID="settings.localDaemonControl.cliUpdate"
                                        size="small"
                                        display="secondary"
                                        title={t('machine.thisComputer.cli.update')}
                                        onPress={() => {
                                            void updateCli();
                                        }}
                                        disabled={!canUpdateCli}
                                    />
                                ) : null}
                                {/* R12: a choice exists only when another command line sits beside the managed one. */}
                                {showChangeCommandLine ? (
                                    <RoundButton
                                        testID="settings.localDaemonControl.changeCli"
                                        size="small"
                                        display="secondary"
                                        title={t('machine.thisComputer.cliChoice.change')}
                                        onPress={() => {
                                            void changeCommandLine();
                                        }}
                                        disabled={!canChangeCommandLine}
                                    />
                                ) : null}
                            </View>
                        </SectionContentRow>
                    ) : null}
                </ItemGroup>
            ) : null}
            {activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={activeTaskTitle ?? t('machine.daemon')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
        </>
    );
});

const styles = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
}));
