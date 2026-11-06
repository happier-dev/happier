import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { Modal } from '@/modal';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineConnection';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

const styles = StyleSheet.create((theme) => ({
    identifier: {
        ...Typography.mono(),
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
}));

/** The machine's daemon (Doctor sub-page): whether it runs, stopping it, and its last-known facts. */
export const MachineDaemonSection = React.memo(function MachineDaemonSection(props: Readonly<{
    machine: Machine;
    serverId: string;
}>) {
    const { theme } = useUnistyles();
    const { machine } = props;
    const machineId = machine.id;
    const machineServerId = props.serverId;
    const shouldContinue = useMountedShouldContinue();
    const stopExecution = useMountedActionExecution(machineServerId);
    const [isStoppingDaemon, setIsStoppingDaemon] = React.useState(false);
    const presence = useMachinePresenceSummary(machineServerId, machineId);

    // The daemon's last-known status; a connected machine is the proxy for a live daemon.
    const daemonStatus: 'stopped' | 'likelyAlive' | 'unknown' = presence.reachability === 'unknown' ? 'unknown' : machine.metadata?.daemonLastKnownStatus === 'shutting-down'
        ? 'stopped'
        : presence.reachability === 'reachable' ? 'likelyAlive' : 'stopped';
    const daemonStatusLabel = daemonStatus === 'unknown' ? t('common.unknown') : daemonStatus === 'likelyAlive' ? t('machine.daemonStatus.likelyAlive') : t('machine.daemonStatus.stopped');

    const handleStopDaemon = async () => {
        const runStopDaemon = async () => {
            setIsStoppingDaemon(true);
            try {
                const execution = await stopExecution.execute('machines.daemon.stop', { serverId: machineServerId, machineId });
                if (!execution.ok) {
                    if (execution.errorCode === 'cancelled' || isActionApprovalDeclinedErrorCode(execution.errorCode)) return;
                    Modal.alert(t('common.error'), resolveActionExecutionFailureMessage(execution, t('machine.stopDaemonFailed')) ?? t('machine.stopDaemonFailed'));
                    return;
                }
                const result = MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.daemon.stop'].parse(execution.result);
                Modal.alert(t('machine.daemonStoppedTitle'), result.message);
                // Refresh to get updated metadata
                await sync.refreshMachines();
            } catch (error) {
                const shown = tryShowDaemonUnavailableAlertForRpcError({
                    error,
                    machine,
                    onRetry: () => {
                        void runStopDaemon();
                    },
                    shouldContinue,
                });
                if (!shown) {
                    Modal.alert(t('common.error'), t('machine.stopDaemonFailed'));
                }
            } finally {
                setIsStoppingDaemon(false);
            }
        };

        await runStopDaemon();
    };

    return (
        <ItemGroup title={t('machine.daemon')} description={t('machineDetailPage.daemonSectionDescription')}>
            <Item
                title={t('machine.status')}
                detail={daemonStatusLabel}
                detailStyle={daemonStatus === 'stopped' ? { color: theme.colors.state.warning.foreground } : undefined}
                mode="info"
                showChevron={false}
            />
            <Item
                testID="machine-detail-stop-daemon"
                title={t('machine.stopDaemon')}
                subtitle={t('machineDetailPage.stopDaemonDescription')}
                subtitleLines={0}
                showChevron={false}
                mode="info"
                accessoryLayout="adaptive"
                rightElement={(
                    <RoundButton
                        testID="machine-detail-stop-daemon-button"
                        size="small"
                        display="secondary"
                        title={t('machineDetailPage.stopDaemonAction')}
                        disabled={isStoppingDaemon || daemonStatus !== 'likelyAlive'}
                        loading={isStoppingDaemon}
                        onPress={handleStopDaemon}
                    />
                )}
            />
            {machine.daemonState && (
                <>
                    {machine.daemonState.pid && (
                        <Item
                            title={t('machine.lastKnownPid')}
                            detail={String(machine.daemonState.pid)}
                            detailStyle={styles.identifier}
                            mode="info"
                            showChevron={false}
                        />
                    )}
                    {machine.daemonState.httpPort && (
                        <Item
                            title={t('machine.lastKnownHttpPort')}
                            detail={String(machine.daemonState.httpPort)}
                            detailStyle={styles.identifier}
                            mode="info"
                            showChevron={false}
                        />
                    )}
                    {typeof machine.daemonState.startedAt === 'number' && (
                        <Item
                            title={t('machine.startedAt')}
                            detail={new Date(machine.daemonState.startedAt).toLocaleString()}
                            mode="info"
                            showChevron={false}
                        />
                    )}
                    {machine.daemonState.cliVersion && (
                        <Item
                            title={t('machine.cliVersion')}
                            detail={machine.daemonState.cliVersion}
                            detailStyle={styles.identifier}
                            mode="info"
                            showChevron={false}
                        />
                    )}
                </>
            )}
            <Item
                title={t('machine.daemonStateVersion')}
                detail={String(machine.daemonStateVersion)}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
});
