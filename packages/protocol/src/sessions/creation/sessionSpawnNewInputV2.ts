import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import {
  AgentSessionConfigurationSnapshotV1Schema,
} from '../../runtime/agentSessionV1.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import {
  AgentSessionStartupInstructionsV1Schema,
} from '../../runtime/agentSessionStartupInstructionsV1.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from '../messages/sessionInputAuthoringV1.js';
import { RawIngressStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
import { ReviewCommentDraftMessageV1Schema } from '../../messages/structured/reviewCommentsV1.js';
import {
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringTerminalV1Schema,
} from '../authoring/creationFieldsV1.js';
export { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
export type { SessionAuthoringCheckoutCreationDraftV1 } from '../authoring/creationFieldsV1.js';
import { SessionCreationKeyV1Schema } from './sessionCreationIdentityV1.js';
import { SessionSpawnSourceContextV1Schema } from './sessionSpawnSourceContextV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema } from './sessionSpawnNewResultV1.js';
import { MachinePoolSelectionOriginV1Schema } from '../../machines/pools/v1.js';
import { SessionInitialAccessDraftV1Schema } from '../access/sessionInitialAccessDraftV1.js';
import { SessionReportsToV1Schema } from '../relations/sessionReportsToV1.js';
import { SessionTeamCredentialBindingIntentsV1Schema } from '../../teams/credentials/sessionBindingIntentV1.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionInitialTriggerV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { SessionIdentityAdditionsV1Schema } from '../identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../context/sessionContextV1.js';
import { SessionManagedCreationV1Schema } from './sessionCreationCorrespondenceV1.js';

/**
 * One Message-owned input admitted before the new Session runtime may start.
 * The creation key owns retry identity, so this shape carries content only;
 * callers cannot establish a second Message idempotency owner.
 */
export const SessionSpawnNewInitialInputV1Schema = lazyZodSchema(() => z.object({
  text: z.string().optional(),
  attachments: PluginSessionInputAttachmentsV1Schema.optional(),
  /** Composer references and semantic attachments before a Session exists. */
  structuredInput: RawIngressStructuredInputV1Schema.optional(),
  /** Session-independent drafts; spawn settlement adds the new Session ID. */
  reviewComments: z.object({
    comments: z.array(ReviewCommentDraftMessageV1Schema),
    displayText: z.string().min(1),
  }).strict().optional(),
}).strict().superRefine(requireSessionInputContent));
export type SessionSpawnNewInitialInputV1 = z.infer<typeof SessionSpawnNewInitialInputV1Schema>;

/**
 * The sole public request for an ordinary authored hosted Session. Legacy flat
 * spawn fields are normalized before this boundary and are never accepted as a
 * second canonical creation vocabulary.
 */
export const SessionSpawnNewInputV2BaseSchema = lazyZodSchema(() => z.object({
  creationKey: SessionCreationKeyV1Schema.optional(),
  executionTarget: SessionExecutionTargetV1Schema,
  placementOrigin: MachinePoolSelectionOriginV1Schema.optional(),
  directory: SessionDirectoryIntentV1Schema,
  organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
  agentTarget: AgentExecutionTargetV1Schema,
  roleId: z.string().trim().min(1).optional(),
  modelSelection: SessionModelSelectionV1Schema.optional(),
  profileId: z.string().trim().min(1).optional(),
  /** Value-free Saved Secret binding overrides for this launch only. */
  secretReferenceOverlay: SecretReferenceOverlayV1Schema.optional(),
  permissionMode: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
  agentModeId: z.string().trim().min(1).optional(),
  configuration: AgentSessionConfigurationSnapshotV1Schema.optional(),
  connectedServices: ConnectedServiceBindingsV2IngressSchema.optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
  terminal: SessionAuthoringTerminalV1Schema.optional(),
  checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1Schema.nullable().optional(),
  title: z.string().trim().min(1).optional(),
  /** Host-owned identity facts persisted at ordinary Session birth. */
  identity: SessionIdentityAdditionsV1Schema.optional(),
  /** Host-verified resource this Session was created with; never current Controller authority. */
  managedCreation: SessionManagedCreationV1Schema.optional(),
  /** Admitted kind preference or explicit draft choice; omission uses the birth kind default. */
  memoryEnabled: z.boolean().optional(),
  /** Complete selected Session context committed before its first preparation. */
  promptStack: SessionPromptStackV1Schema.optional(),
  initialInput: SessionSpawnNewInitialInputV1Schema.optional(),
  initialTriggers: z.array(z.lazy(() => SessionInitialTriggerV1Schema)).optional(),
  initialAccess: SessionInitialAccessDraftV1Schema.optional(),
  reportsTo: SessionReportsToV1Schema.optional(),
  primaryTeamId: z.string().min(1).nullable().optional(),
  /** Complete slot-keyed Team credential selection batch for the fresh Session commit. */
  teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.optional(),
  agentSessionStartupInstructionsV1: AgentSessionStartupInstructionsV1Schema.optional(),
  /**
   * Create this Session as a continuation of an existing one. Because this
   * schema is `.strict()`, a daemon that predates the field REJECTS the request
   * instead of silently dropping the source recipe — operation-scoped safe
   * degradation, not compatibility by silent ignore.
   */
  sourceContext: SessionSpawnSourceContextV1Schema.optional(),
  /**
   * Raw launch environment forwarded verbatim to the spawned process. Only the
   * CLI's direct-to-daemon path may carry it: the browser-safe server-start
   * draft below omits it so values never enter server-visible creation state.
   * Bounds match the handoff resume plan's environment contract.
   */
  environmentVariables: z.record(z.string().min(1).max(128), z.string().max(16 * 1024)).optional(),
}).strict());

export const SessionSpawnNewInputV2Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema
  .superRefine(refineSessionDirectoryIntentCheckoutV1));

export type SessionSpawnNewInputV2 = z.infer<typeof SessionSpawnNewInputV2Schema>;

/**
 * Browser-safe omission of host-sealed creation facts. The daemon-only
 * server-start transport consumes this exact projection without owning a
 * second Session input schema.
 */
export const SessionServerStartSpawnDraftV1Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.omit({
  creationKey: true,
  initialInput: true,
  environmentVariables: true,
}).strict().superRefine(refineSessionDirectoryIntentCheckoutV1));

export type SessionServerStartSpawnDraftV1 = Omit<
  SessionSpawnNewInputV2,
  'creationKey' | 'initialInput' | 'environmentVariables'
>;
