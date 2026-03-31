export type TrayDaemonServiceAction = 'start' | 'stop' | 'restart';

export const TRAY_DAEMON_SERVICE_ACTION_EVENT = 'tray://daemon-service/action';

export type TrayDaemonServiceActionPayload = Readonly<{
    action: TrayDaemonServiceAction;
}>;

export function buildDaemonServiceTaskKind(action: TrayDaemonServiceAction): 'daemon.service.start.v1' | 'daemon.service.stop.v1' | 'daemon.service.restart.v1' {
    return `daemon.service.${action}.v1` as const;
}
