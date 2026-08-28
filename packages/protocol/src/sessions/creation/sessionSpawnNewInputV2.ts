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
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from '../messages/sessionInputAuthoringV1.js';
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

const SESSION_SPAWN_ENVIRONMENT_VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_SPAWN_FORBIDDEN_ENVIRONMENT_VARIABLE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Raw daemon launch environment admitted only at the V2 Session-create
 * boundary. Its key grammar matches the existing daemon spawn validator;
 * field bounds reuse the established Session-handoff envelope and launch
 * profile entry ceiling so invalid input cannot reach process spawning.
 */
const SessionSpawnEnvironmentVariablesV1Schema = z.record(
  z.string()
    .min(1)
    .max(128)
    .regex(SESSION_SPAWN_ENVIRONMENT_VARIABLE_KEY_PATTERN)
    .refine(
      (key) => !SESSION_SPAWN_FORBIDDEN_ENVIRONMENT_VARIABLE_KEYS.has(key),
      'Invalid environment variable name',
    ),
  z.string().max(16 * 1024),
).superRefine((environmentVariables, context) => {
  if (Object.keys(environmentVariables).length > 256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Too many environment variables',
    });
  }
});

/**
 * One Message-owned input admitted before the new Session runtime may start.
 * The creation key owns retry identity, so this shape carries content only;
 * callers cannot establish a second Message idempotency owner.
 */
export const SessionSpawnNewInitialInputV1Schema = z.object({
  text: z.string().optional(),
  attachments: PluginSessionInputAttachmentsV1Schema.optional(),
}).strict().superRefine(requireSessionInputContent);
export type SessionSpawnNewInitialInputV1 = z.infer<typeof SessionSpawnNewInitialInputV1Schema>;

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
  initialInput: SessionSpawnNewInitialInputV1Schema.optional(),
  environmentVariables: SessionSpawnEnvironmentVariablesV1Schema.optional(),
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
  initialInput: true,
  environmentVariables: true,
}).strict();

export type SessionServerStartSpawnDraftV1 = Omit<
  SessionSpawnNewInputV2,
  'creationKey' | 'initialInput' | 'environmentVariables'
>;
