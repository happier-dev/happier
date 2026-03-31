import type { RemoteSshChecklistItem, RemoteSshChecklistMode } from './remoteSshChecklistTypes';

export function buildRemoteSshChecklistItems(params: Readonly<{
    mode: RemoteSshChecklistMode;
    installRelayRuntime: boolean;
}>): readonly RemoteSshChecklistItem[] {
    const required: RemoteSshChecklistItem[] = [
        {
            id: 'trust_host',
            title: 'Trust SSH host',
            subtitle: 'Verify the remote machine fingerprint before connecting.',
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['ssh.trust', 'ssh.hostTrust'],
            details: 'We verify the SSH host key and reject unexpected fingerprints unless you explicitly trust them.',
        },
        {
            id: 'install_cli',
            title: 'Install Happier CLI',
            subtitle: 'Copy the Happier CLI to the remote machine.',
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['ssh.installCli'],
            details: 'The remote machine needs the Happier CLI so the rest of the bootstrap can be executed on it.',
        },
        {
            id: 'configure_relay',
            title: 'Configure the relay',
            subtitle: 'Point the remote machine at the active relay and web app.',
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['ssh.auth.request', 'ssh.auth.approval', 'ssh.auth.wait', 'ssh.complete'],
            details: 'The remote CLI is configured to talk to the active relay and authenticate this machine to your account.',
        },
        {
            id: 'install_daemon',
            title: 'Install background service',
            subtitle: 'Keep Happier running in the background on the remote machine.',
            selected: true,
            disabled: true,
            optional: false,
            stepIds: ['daemon.service.install', 'daemon.service.start'],
            details: 'The background service keeps the remote machine connected and ready for future sessions.',
        },
    ];

    const relayRuntime: RemoteSshChecklistItem[] = params.mode === 'remoteRelayHost'
        ? [
            {
                id: 'install_relay_runtime',
                title: 'Install relay runtime',
                subtitle: 'Host a relay on this remote machine.',
                selected: params.installRelayRuntime,
                disabled: true,
                optional: false,
                stepIds: ['relay.runtime.install'],
                details: 'This installs the relay runtime on the remote machine so the machine can host a relay for you.',
            },
        ]
        : [];

    return [
        ...required,
        ...relayRuntime,
    ];
}

export function getRemoteSshSelectedItemIds(items: readonly RemoteSshChecklistItem[]): readonly string[] {
    return items.filter((item) => item.selected).map((item) => item.id);
}
