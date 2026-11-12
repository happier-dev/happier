import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { MachineVitalsAlertEpisodeV1Schema } from '../../machines/vitals/machineVitalsHistoryV1.js';

export const MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 = '@happier/machine/service-observed' as const;
const id = () => z.string().check(z.minLength(1));
const timestamp = () => z.number().check(z.int(), z.nonnegative());
/** Closed producer facts; native output and credentials never enter this bridge. */
export const BackupOutcomeEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('backup'), serverId: id(), machineId: id(), environmentId: id(), operationId: id(),
  state: z.enum(['succeeded', 'failed']), occurredAt: timestamp(), errorCode: z.nullable(id()),
}));
export type BackupOutcomeEventV1 = z.infer<typeof BackupOutcomeEventV1Schema>;
export const MachinePressureEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pressure'), serverId: id(), machineId: id(), episode: MachineVitalsAlertEpisodeV1Schema,
  since: timestamp(),
}));
export type MachinePressureEventV1 = z.infer<typeof MachinePressureEventV1Schema>;
export const MachineServiceObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BackupOutcomeEventV1Schema, MachinePressureEventV1Schema,
]));
export type MachineServiceObservationV1 = z.infer<typeof MachineServiceObservationV1Schema>;
export const BackupOutcomeEventV1ProtocolSchema = projectZodProtocolSchema(BackupOutcomeEventV1Schema);
export const MachinePressureEventV1ProtocolSchema = projectZodProtocolSchema(MachinePressureEventV1Schema);
