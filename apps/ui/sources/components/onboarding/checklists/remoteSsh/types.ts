export type RemoteSshChecklistMode = 'remoteMachine' | 'remoteRelayHost';

export type RemoteSshChecklistPhase = 'credentials' | 'plan' | 'execution' | 'complete';

export type RemoteSshChecklistItemId =
    | 'trust_host'
    | 'install_cli'
    | 'configure_relay'
    | 'authenticate_and_pair'
    | 'install_daemon'
    | 'install_relay_runtime';

export type RemoteSshChecklistItem = Readonly<{
    id: RemoteSshChecklistItemId;
    title: string;
    subtitle: string;
    satisfied?: boolean;
    selected: boolean;
    disabled: boolean;
    optional: boolean;
    stepIds: readonly string[];
    details: string;
}>;
