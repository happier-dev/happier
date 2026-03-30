import type { ConnectionHealth, ConnectionHealthPresentation } from './connectionHealthTypes';

type StatusColors = Readonly<{
    connected: string;
    connecting: string;
    actionRequired: string;
    disconnected: string;
    error: string;
    default: string;
}>;

export function resolveConnectionHealthPresentation(
    health: ConnectionHealth,
    statusColors: StatusColors,
): ConnectionHealthPresentation {
    switch (health.kind) {
        case 'healthy':
            return {
                tone: 'positive',
                color: statusColors.connected,
                isPulsing: false,
                statusLabelKey: 'status.connected',
                machineLabelKey: 'status.online',
            };
        case 'connecting':
            return {
                tone: 'neutral',
                color: statusColors.connecting,
                isPulsing: true,
                statusLabelKey: 'status.connecting',
                machineLabelKey: 'status.unknown',
            };
        case 'server_error':
            return {
                tone: 'danger',
                color: statusColors.error,
                isPulsing: false,
                statusLabelKey: 'status.error',
                machineLabelKey: 'status.unknown',
            };
        case 'server_unreachable':
            return {
                tone: 'danger',
                color: statusColors.disconnected,
                isPulsing: false,
                statusLabelKey: 'status.disconnected',
                machineLabelKey: 'status.unknown',
            };
        case 'auth_required':
            return {
                tone: 'attention',
                color: statusColors.actionRequired,
                isPulsing: false,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.unknown',
            };
        case 'machine_offline':
            return {
                tone: 'attention',
                color: statusColors.actionRequired,
                isPulsing: false,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.offline',
            };
        case 'machine_not_ready':
            return {
                tone: 'attention',
                color: statusColors.actionRequired,
                isPulsing: false,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'status.online',
            };
        case 'no_machine':
            return {
                tone: 'attention',
                color: statusColors.actionRequired,
                isPulsing: false,
                statusLabelKey: 'status.actionRequired',
                machineLabelKey: 'newSession.noMachinesFound',
            };
        default:
            return {
                tone: 'neutral',
                color: statusColors.default,
                isPulsing: false,
                statusLabelKey: 'status.unknown',
                machineLabelKey: 'status.unknown',
            };
    }
}
