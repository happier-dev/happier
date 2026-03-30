import type { MachineListStatus } from '@/components/sessions/guidance/gettingStartedModel';

export type ConnectionSocketStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'idle';

export type ConnectionHealthKind =
    | 'healthy'
    | 'connecting'
    | 'server_unreachable'
    | 'auth_required'
    | 'server_error'
    | 'no_machine'
    | 'machine_offline'
    | 'machine_not_ready';

export type ConnectionHealthStatusLabelKey =
    | 'status.connected'
    | 'status.connecting'
    | 'status.disconnected'
    | 'status.error'
    | 'status.actionRequired'
    | 'status.unknown';

export type ConnectionHealthMachineLabelKey =
    | 'status.online'
    | 'status.offline'
    | 'status.unknown'
    | 'newSession.noMachinesFound';

export type ConnectionHealthMachineGroup = Readonly<{
    machineCount: number | null;
    onlineCount: number | null;
    readyCount?: number | null;
    status: MachineListStatus;
}>;

export type ConnectionHealth = Readonly<{
    kind: ConnectionHealthKind;
    machineCount: number;
    onlineCount: number;
    hasUnknownMachines: boolean;
    socketStatus: ConnectionSocketStatus;
}>;

export type ConnectionHealthPresentation = Readonly<{
    tone: 'positive' | 'attention' | 'danger' | 'neutral';
    color: string;
    isPulsing: boolean;
    statusLabelKey: ConnectionHealthStatusLabelKey;
    machineLabelKey: ConnectionHealthMachineLabelKey;
}>;
