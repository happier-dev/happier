import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { MachineVitalsAlertEpisodeV1Schema } from '../../machines/vitals/machineVitalsHistoryV1.js';
import { WorkspaceAddressV1Schema, WorkspaceAddressV2Schema } from '../../workspaces/workspaceRefV1.js';
import { QualifiedProjectTrustProjectV1Schema } from '../../workspaces/projectSetup/projectTrustRowV1.js';
import { ActionOperationIdentifierV1Schema } from '../../actions/operations/identifierV1.js';

import { SessionStopRecordV1Schema } from '../../machines/guard/sessionGuardStateV1.js';
import { ConnectedAccountServiceKeySchema, ConnectedServiceAuthGroupIdSchema, ConnectedServiceProfileIdSchema } from '../../connect/connectedServiceBindings.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { ConnectedServiceCredentialRefreshFailureKindV1Schema } from '../../connect/connectedServiceSchemas.js';

export const MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 = '@happier/machine/service-observed' as const;
const id = () => z.string().check(z.minLength(1));
const timestamp = () => z.number().check(z.int(), z.nonnegative());
/** Closed producer facts; native output and credentials never enter this bridge. */
export const BackupOutcomeEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('backup'), serverId: id(), machineId: id(), environmentId: id(), operationId: id(),
  state: z.enum(['succeeded', 'failed']), occurredAt: timestamp(), errorCode: z.nullable(id()),
  originRunId: z.optional(ActionOperationIdentifierV1Schema),
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
  originRunId: z.optional(ActionOperationIdentifierV1Schema),
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
export const GuardStoppedEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('guard_stop'), serverId: id(), machineId: id(), sessionId: id(),
  at: SessionStopRecordV1Schema.shape.at, settledAt: SessionStopRecordV1Schema.shape.settledAt,
  rule: SessionStopRecordV1Schema.shape.rule,
}));
export type GuardStoppedEventV1 = z.infer<typeof GuardStoppedEventV1Schema>;
export const ConnectedServiceQuotaEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('connected_service_quota'), serverId: id(), machineId: id(),
  serviceId: ConnectedAccountServiceKeySchema, groupId: ConnectedServiceAuthGroupIdSchema,
  profileId: z.nullable(ConnectedServiceProfileIdSchema), phase: z.enum(['blocked', 'recovered']),
  cycleId: z.nullable(id()), issueFingerprint: id(), occurredAt: timestamp(), limitCategory: z.literal('usage_limit'),
}));
export type ConnectedServiceQuotaEventV1 = z.infer<typeof ConnectedServiceQuotaEventV1Schema>;
export const ConnectedServiceCredentialHealthEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('credential_health'), serverId: id(), machineId: id(), account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  status: z.enum(['needs_reauth', 'refresh_failed_retryable']),
  reason: z.nullable(ConnectedServiceCredentialRefreshFailureKindV1Schema), occurredAt: timestamp(),
}));
export type ConnectedServiceCredentialHealthEventV1 = z.infer<typeof ConnectedServiceCredentialHealthEventV1Schema>;
/** Setup publication consumes the Project owner's redacted settlement, never command output. */
const projectSetupFields = () => ({ workspace: WorkspaceAddressV2Schema,
  project: QualifiedProjectTrustProjectV1Schema, operationId: ActionOperationIdentifierV1Schema,
  originRunId: z.optional(ActionOperationIdentifierV1Schema) });
export const ProjectSetupSettledEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.strictObject({ ...projectSetupFields(), outcome: z.literal('finished') }),
  z.strictObject({ ...projectSetupFields(), outcome: z.literal('failed'), errorCode: id() }),
]));
export type ProjectSetupSettledEventV1 = z.infer<typeof ProjectSetupSettledEventV1Schema>;
const ProjectSetupSettledObservationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('projectSetupSettled'), serverId: id(), machineId: id(), occurredAt: timestamp(),
  settlement: ProjectSetupSettledEventV1Schema,
}));
export const MachineServiceObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  BackupOutcomeEventV1Schema, MachinePressureEventV1Schema, WorktreeRemovedObservationV1Schema,
  GuardStoppedEventV1Schema, ConnectedServiceQuotaEventV1Schema, ConnectedServiceCredentialHealthEventV1Schema, ProjectSetupSettledObservationV1Schema,
]));
export type MachineServiceObservationV1 = z.infer<typeof MachineServiceObservationV1Schema>;
export const BackupOutcomeEventV1ProtocolSchema = projectZodProtocolSchema(BackupOutcomeEventV1Schema);
export const MachinePressureEventV1ProtocolSchema = projectZodProtocolSchema(MachinePressureEventV1Schema);
export const WorktreeRemovedEventV1ProtocolSchema = projectZodProtocolSchema(WorktreeRemovedEventV1Schema);
export const GuardStoppedEventV1ProtocolSchema = projectZodProtocolSchema(GuardStoppedEventV1Schema);
export const ConnectedServiceQuotaEventV1ProtocolSchema = projectZodProtocolSchema(ConnectedServiceQuotaEventV1Schema);
export const ConnectedServiceCredentialHealthEventV1ProtocolSchema = projectZodProtocolSchema(ConnectedServiceCredentialHealthEventV1Schema);
export const ProjectSetupSettledEventV1ProtocolSchema = projectZodProtocolSchema(ProjectSetupSettledEventV1Schema);
