import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { AgentSessionConfigurationSnapshotV1Schema } from '../../runtime/agentSessionV1.js';
import { AgentPermissionIntentV1Schema, AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { SessionAuthoringCheckoutCreationDraftV1Schema, SessionAuthoringTerminalV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema } from './sessionSpawnNewResultV1.js';
import { MachinePoolSelectionOriginV1Schema } from '../../machines/pools/v1.js';
import { SessionTeamCredentialBindingIntentsV1Schema } from '../../teams/credentials/sessionBindingIntentV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionAuthoringSelectionFieldsV1 } from '../authoring/selectionFieldsV1.js';

/** Ordinary launch selections, below input/trigger/host-authority composition. */
export const SessionSpawnNewSelectionV2BaseSchema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionToolPolicyShapeV1,
  executionTarget: SessionExecutionTargetV1Schema,
  placementOrigin: z.optional(MachinePoolSelectionOriginV1Schema),
  directory: SessionDirectoryIntentV1Schema,
  organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema),
  agentTarget: AgentExecutionTargetV1Schema,
  roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  modelSelection: z.optional(SessionModelSelectionV1Schema),
  profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  approvalProfileId: z.optional(SessionAuthoringSelectionFieldsV1.approvalProfileId),
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  permissionMode: z.optional(asProtocolZod(AgentPermissionIntentV1Schema)),
  agentModeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  configuration: z.optional(AgentSessionConfigurationSnapshotV1Schema),
  connectedServices: z.optional(ConnectedServiceBindingsV2IngressSchema),
  capabilitySelection: z.optional(SessionCapabilitySelectionAuthoringV1Schema),
  transcriptStorage: z.optional(z.enum(['persisted', 'direct'])),
  terminal: z.optional(SessionAuthoringTerminalV1Schema),
  checkoutCreationDraft: z.optional(z.nullable(SessionAuthoringCheckoutCreationDraftV1Schema)),
  title: z.optional(z.string().check(z.trim(), z.minLength(1))),
  memoryEnabled: z.optional(z.boolean()),
  primaryTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema),
}));
export const SessionSpawnNewSelectionV2Schema = lazyZodSchema(() =>
  SessionSpawnNewSelectionV2BaseSchema.check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));
export type SessionSpawnNewSelectionV2 = z.infer<typeof SessionSpawnNewSelectionV2Schema>;
