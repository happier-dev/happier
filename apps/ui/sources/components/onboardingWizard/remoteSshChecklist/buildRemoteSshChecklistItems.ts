import type { RemoteSshChecklistItem, RemoteSshChecklistMode } from './remoteSshChecklistTypes';
import { getRemoteSshChecklistCopy } from './remoteSshChecklistCopy';

export function buildRemoteSshChecklistItems(params: Readonly<{
    mode: RemoteSshChecklistMode;
}>): readonly RemoteSshChecklistItem[] {
    const copy = getRemoteSshChecklistCopy(params.mode);
    const daemonItem: RemoteSshChecklistItem = {
        id: 'install_daemon',
        title: copy.installDaemonTitle,
        subtitle: copy.installDaemonSubtitle,
        selected: true,
        disabled: true,
        optional: false,
        stepIds: ['daemon.service.install', 'daemon.service.start'],
        details: copy.installDaemonDetails,
    };
    const required: RemoteSshChecklistItem[] = [
        {
            id: 'trust_host',
            title: copy.trustHostTitle,
            subtitle: copy.trustHostSubtitle,
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['ssh.trust', 'ssh.hostTrust'],
            details: copy.trustHostDetails,
        },
        {
            id: 'install_cli',
            title: copy.installCliTitle,
            subtitle: copy.installCliSubtitle,
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['ssh.installCli'],
            details: copy.installCliDetails,
        },
        {
            id: 'configure_relay',
            title: copy.configureRelayTitle,
            subtitle: copy.configureRelaySubtitle,
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['ssh.auth.request', 'ssh.auth.approval', 'ssh.auth.wait', 'ssh.complete'],
            details: copy.configureRelayDetails,
        },
        ...(params.mode === 'remoteRelayHost' ? [] : [daemonItem]),
    ];

    const relayRuntime: RemoteSshChecklistItem[] = params.mode === 'remoteRelayHost'
        ? [
            {
                id: 'install_relay_runtime',
                title: copy.installRelayRuntimeTitle,
                subtitle: copy.installRelayRuntimeSubtitle,
                selected: true,
                disabled: false,
                optional: true,
                stepIds: ['relay.runtime.install'],
                details: copy.installRelayRuntimeDetails,
            },
        ]
        : [];

    return [
        ...required,
        ...relayRuntime,
    ];
}
