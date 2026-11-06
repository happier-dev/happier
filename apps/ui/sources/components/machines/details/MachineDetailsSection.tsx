import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { hasProviderMachineStateV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { composeProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineConnection';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { machinesIndexHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { sync } from '@/sync/sync';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

const styles = StyleSheet.create((theme) => ({
    identifier: {
        ...Typography.mono(),
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
    leaveActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    footnote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        marginTop: theme.space.s10,
        marginHorizontal: theme.space.s2,
    },
}));

function MachineLastSeenItem({ activeAt }: Readonly<{ activeAt: number | null }>) {
    return <Item title={t('machine.lastSeen')}
        detail={activeAt ? new Date(activeAt).toLocaleString() : t('machine.never')}
        mode="info" showChevron={false} />;
}

/**
 * The machine's identifiers and facts (Details sub-page), then Remove machine: the irreversible action
 * closes the page, with its consequence beneath it.
 */
export const MachineDetailsSection = React.memo(function MachineDetailsSection(props: Readonly<{
    machine: Machine;
    serverId: string;
    lastSeenAtOnOpen?: number | null;
}>) {
    const router = useRouter();
    const door = useMachinesDoor();
    const { machine } = props;
    const machineId = machine.id;
    const machineServerId = props.serverId;
    const metadata = machine.metadata;
    const stopExecution = useMountedActionExecution(machineServerId);
    const expectedSettingsScope = useAccountSettingsScope();
    const providerCatalog = useProviderCatalog(expectedSettingsScope);
    const [isRevokingMachine, setIsRevokingMachine] = React.useState(false);
    const [isProviderCleanupPending, setIsProviderCleanupPending] = React.useState(false);
    const hasDurableProviderCleanup = React.useMemo(() => {
        if (!machine.revokedAt) return false;
        if (providerCatalog?.status !== 'ready' || !providerCatalog.data) return true;
        return hasProviderMachineStateV1(composeProviderSettingsV1(providerCatalog.data, {}), machineId);
    }, [machine.revokedAt, machineId, providerCatalog?.status, providerCatalog?.data]);
    const providerCleanupPending = isProviderCleanupPending || hasDurableProviderCleanup;

    const handleRevokeMachine = React.useCallback(() => {
        if (isRevokingMachine) return;
        if (machine.revokedAt && !providerCleanupPending) return;
        fireAndForget((async () => {
            setIsRevokingMachine(true);
            try {
                const execution = await stopExecution.execute('machines.remove', { serverId: machineServerId, machineId });
                if (!execution.ok && (execution.errorCode === 'cancelled'
                    || isActionApprovalDeclinedErrorCode(execution.errorCode))) return;
                const result = execution.ok ? MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.remove'].parse(execution.result) : null;
                if (!result?.ok) {
                    if (result && 'machineRevoked' in result && result.machineRevoked) {
                        setIsProviderCleanupPending(true);
                        await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
                        await Modal.alert(t('common.error'), t('settingsProviders.errors.machineCleanupPendingDescription'));
                    } else {
                        await Modal.alert(t('common.error'), resolveActionExecutionFailureMessage(execution, t('errors.operationFailed')) ?? t('errors.operationFailed'));
                    }
                    return;
                }
                setIsProviderCleanupPending(false);
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
                // The machine is gone: its pages close onto the Machines index of the same door.
                router.replace(machinesIndexHref(door) as never);
            } finally {
                setIsRevokingMachine(false);
            }
        })(), { tag: 'MachineDetailsSection.revokeMachine' });
    }, [door, isRevokingMachine, machine.revokedAt, machineId, machineServerId, providerCleanupPending, router, stopExecution]);

    const removeMachineFootnote = providerCleanupPending
        ? t('settingsProviders.errors.machineCleanupPendingDescription')
        : machine.revokedAt
            ? t('machine.actions.removeMachineAlreadyRemoved')
            : t('machine.actions.removeMachineConfirmBody');

    return (
        <>
            <ItemGroup title={t('machineDetailPage.detailsTitle')}>
                <Item
                    title={t('machine.host')}
                    detail={metadata?.host || t('status.unknown')}
                    mode="info"
                    showChevron={false}
                />
                <Item
                    title={t('machine.machineId')}
                    detail={machineId}
                    detailStyle={styles.identifier}
                    copy={machineId}
                    mode="info"
                    showChevron={false}
                />
                {metadata?.username && (
                    <Item
                        title={t('machine.username')}
                        detail={metadata.username}
                        mode="info"
                        showChevron={false}
                    />
                )}
                {metadata?.homeDir && (
                    <Item
                        title={t('machine.homeDirectory')}
                        detail={metadata.homeDir}
                        detailStyle={styles.identifier}
                        mode="info"
                        showChevron={false}
                    />
                )}
                {metadata?.platform && (
                    <Item
                        title={t('machine.platform')}
                        detail={formatOSPlatform(metadata.platform)}
                        mode="info"
                        showChevron={false}
                    />
                )}
                {metadata?.arch && (
                    <Item
                        title={t('machine.architecture')}
                        detail={metadata.arch}
                        mode="info"
                        showChevron={false}
                    />
                )}
                <MachineLastSeenItem activeAt={props.lastSeenAtOnOpen ?? machine.activeAt} />
                <Item
                    title={t('machine.metadataVersion')}
                    detail={String(machine.metadataVersion)}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup surface="none" accessibilityLabel={t('machine.actions.removeMachine')}>
                <View style={styles.leaveActions}>
                    <RoundButton
                        testID="machine-detail-remove"
                        size="small"
                        display="destructive"
                        title={t('machine.actions.removeMachine')}
                        titleNumberOfLines="complete"
                        accessibilityHint={removeMachineFootnote}
                        disabled={isRevokingMachine || (Boolean(machine.revokedAt) && !providerCleanupPending)}
                        loading={isRevokingMachine}
                        onPress={handleRevokeMachine}
                    />
                </View>
                <Text testID="machine-detail-remove-footnote" style={styles.footnote}>{removeMachineFootnote}</Text>
            </ItemGroup>
        </>
    );
});
