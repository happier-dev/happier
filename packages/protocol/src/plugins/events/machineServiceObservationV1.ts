import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { MachineVitalsAlertEpisodeV1Schema } from '../../machines/vitals/machineVitalsHistoryV1.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { QualifiedProjectTrustProjectV1Schema } from '../../workspaces/projectSetup/projectTrustRowV1.js';
import { ActionOperationIdentifierV1Schema } from '../../actions/operations/identifierV1.js';

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
/** Captured before deletion or retirement; paths remain in private host evidence. */
export const WorktreeRemovedEventV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: z.nullable(WorkspaceAddressV1Schema),
  project: z.nullable(QualifiedProjectTrustProjectV1Schema),
  machineId: WorkspaceAddressV1Schema.shape.machineId,
  operationId: ActionOperationIdentifierV1Schema,
  worktreePath: WorkspaceAddressV1Schema.shape.rootPath,
  outcome: z.literal('removed'),
  removalKind: z.enum(['deleted', 'retired']),
}).check(z.superRefine((event, context) => {
  if (event.workspace === null && event.project !== null) context.addIssue({ code: 'custom', message: 'An unassociated removal has no Project' });
})));
export type WorktreeRemovedEventV1 = z.infer<typeof WorktreeRemovedEventV1Schema>;
const WorktreeRemovedObservationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('worktreeRemoved'), serverId: id(), occurredAt: timestamp(), removal: WorktreeRemovedEventV1Schema,
}));
export const MachineServiceObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BackupOutcomeEventV1Schema, MachinePressureEventV1Schema, WorktreeRemovedObservationV1Schema,
]));
export type MachineServiceObservationV1 = z.infer<typeof MachineServiceObservationV1Schema>;
export const BackupOutcomeEventV1ProtocolSchema = projectZodProtocolSchema(BackupOutcomeEventV1Schema);
export const MachinePressureEventV1ProtocolSchema = projectZodProtocolSchema(MachinePressureEventV1Schema);
export const WorktreeRemovedEventV1ProtocolSchema = projectZodProtocolSchema(WorktreeRemovedEventV1Schema);
