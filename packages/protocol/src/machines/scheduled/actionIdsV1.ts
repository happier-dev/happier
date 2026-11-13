export const MACHINE_SCHEDULED_ACTION_IDS = ['machines.scheduled.list', 'machines.scheduled.watch'] as const;
export type MachineScheduledActionId = typeof MACHINE_SCHEDULED_ACTION_IDS[number];
