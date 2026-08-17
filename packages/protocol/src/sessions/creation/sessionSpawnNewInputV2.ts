import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ConnectedServiceBindingsV1Schema } from '../../connect/connectedServiceBindings.js';
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
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringTerminalV1Schema,
} from '../authoring/fieldCatalog.js';
import { SessionCreationKeyV1Schema } from './sessionCreationIdentityV1.js';
import { SessionSpawnSourceContextV1Schema } from './sessionSpawnSourceContextV1.js';
import {
  SessionExecutionTargetV1Schema,
  SessionOrganizationPlacementV1Schema,
} from './sessionSpawnNewResultV1.js';

/**
 * The sole public request for an ordinary authored hosted Session. Legacy flat
 * spawn fields are normalized before this boundary and are never accepted as a
 * second canonical creation vocabulary.
 */
export const SessionSpawnNewInputV2Schema = z.object({
  creationKey: SessionCreationKeyV1Schema.optional(),
  executionTarget: SessionExecutionTargetV1Schema,
  directory: z.string().trim().min(1),
  organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
  agentTarget: AgentExecutionTargetV1Schema,
  modelSelection: SessionModelSelectionV1Schema.optional(),
  profileId: z.string().trim().min(1).optional(),
  permissionMode: asProtocolZod(AgentPermissionIntentV1Schema).optional(),
  agentModeId: z.string().trim().min(1).optional(),
  configuration: AgentSessionConfigurationSnapshotV1Schema.optional(),
  connectedServices: ConnectedServiceBindingsV1Schema.optional(),
  mcpSelection: SessionMcpSelectionV1Schema.optional(),
  transcriptStorage: z.enum(['persisted', 'direct']).optional(),
  terminal: SessionAuthoringTerminalV1Schema.optional(),
  checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1Schema.nullable().optional(),
  title: z.string().trim().min(1).optional(),
  initialMessage: z.string().trim().min(1).optional(),
  agentSessionStartupInstructionsV1: AgentSessionStartupInstructionsV1Schema.optional(),
  /**
   * Create this Session as a continuation of an existing one. Because this
   * schema is `.strict()`, a daemon that predates the field REJECTS the request
   * instead of silently dropping the source recipe — operation-scoped safe
   * degradation, not compatibility by silent ignore.
   */
  sourceContext: SessionSpawnSourceContextV1Schema.optional(),
}).strict();

export type SessionSpawnNewInputV2 = z.infer<typeof SessionSpawnNewInputV2Schema>;

/**
 * Browser-safe omission of host-sealed creation facts. The daemon-only
 * server-start transport consumes this exact projection without owning a
 * second Session input schema.
 */
export const SessionServerStartSpawnDraftV1Schema = SessionSpawnNewInputV2Schema.omit({
  creationKey: true,
  initialMessage: true,
}).strict();

export type SessionServerStartSpawnDraftV1 = Omit<
  SessionSpawnNewInputV2,
  'creationKey' | 'initialMessage'
>;
