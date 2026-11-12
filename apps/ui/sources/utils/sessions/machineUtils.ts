export { isMachineOnline, readMachineOnlineGraceMsFromEnv, readMachineStatusNextRefreshAtMs } from '@/sync/domains/machines/reachability/machinePresence';

export type MachinePresenceCounts = Readonly<{ online: number; offline: number; unknown: number }>;

export { getMachineDisplayName, resolveMachineDisplayNames } from './machineDisplayNames';
