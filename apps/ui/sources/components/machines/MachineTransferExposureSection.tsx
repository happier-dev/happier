import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import {
    readMachineDaemonTransferState,
    type MachineDaemonTransferListenerClassState,
} from '@/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';

function resolveListenerStateLabel(state: MachineDaemonTransferListenerClassState): string {
    if (!state.enabled) {
        return t('machine.transferExposure.stateDisabled');
    }
    if (!state.configured) {
        return t('machine.transferExposure.stateUnconfigured');
    }
    if (state.available === false) {
        return t('machine.transferExposure.stateUnavailable');
    }
    if (state.active) {
        return t('machine.transferExposure.stateActive');
    }
    return t('machine.transferExposure.stateInactive');
}

function resolveTailscaleServeStateLabel(state: MachineDaemonTransferListenerClassState): string {
    if (!state.enabled) {
        return t('machine.transferExposure.stateDisabled');
    }
    if (state.available === false) {
        return t('machine.transferExposure.stateUnavailable');
    }
    if (!state.configured) {
        return t('machine.transferExposure.stateApprovalNeeded');
    }
    if (state.active) {
        return t('machine.transferExposure.stateActive');
    }
    return t('machine.transferExposure.stateStale');
}

export const MachineTransferExposureSection = React.memo(function MachineTransferExposureSection(props: Readonly<{
    daemonState: unknown | null;
}>) {
    const transferState = readMachineDaemonTransferState({ daemonState: props.daemonState });

    if (!transferState) {
        return (
            <ItemGroup title={t('machine.transferExposure.title')}>
                <Item
                    testID="machine.transferExposure.unknown"
                    title={t('machine.transferExposure.status')}
                    subtitle={t('machine.transferExposure.stateUnknown')}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        );
    }

    return (
        <ItemGroup title={t('machine.transferExposure.title')}>
            <Item
                testID="machine.transferExposure.loopbackHttp"
                title={t('machine.transferExposure.loopbackHttp')}
                subtitle={resolveListenerStateLabel(transferState.listenerClasses.loopback_http)}
                showChevron={false}
                mode="info"
            />
            <Item
                testID="machine.transferExposure.tailscaleServeHttps"
                title={t('machine.transferExposure.tailscaleServeHttps')}
                subtitle={resolveTailscaleServeStateLabel(transferState.listenerClasses.tailscale_serve_https)}
                showChevron={false}
                mode="info"
            />
        </ItemGroup>
    );
});
