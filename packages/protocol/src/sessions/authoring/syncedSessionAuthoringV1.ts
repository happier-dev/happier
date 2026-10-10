import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';

/**
 * Immutable `server-v0.2.11` synchronized authoring projection.
 *
 * This released projection stays in a dependency-light leaf so compatibility
 * readers do not initialize the current authoring catalog and its dependencies.
 * `opaqueIdentifier.js` is a zod-only leaf and keeps that property.
 */
const ReleasedBackendTargetRefV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('builtInAgent'), agentId: z.string().min(1) }),
  z.object({ kind: z.literal('configuredAcpBackend'), backendId: z.string().min(1) }),
]));
const ReleasedConnectedServiceProfileIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/));
const ReleasedConnectedServiceAuthGroupIdV1Schema = lazyZodSchema(() => z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/));
const ReleasedConnectedServiceIdV1Schema = lazyZodSchema(() => z.enum([
  'openai-codex',
  'openai',
  'anthropic',
  'claude-subscription',
  'gemini',
  'github',
]));
const ReleasedConnectedServiceBindingV1Schema = lazyZodSchema(() => z.union([
  z.object({ source: z.literal('native') }).strict(),
  z.object({
    source: z.literal('connected'),
    selection: z.literal('profile').optional().default('profile'),
    profileId: ReleasedConnectedServiceProfileIdV1Schema,
  }).strict(),
  z.object({
    source: z.literal('connected'),
    selection: z.literal('group'),
    groupId: ReleasedConnectedServiceAuthGroupIdV1Schema,
    profileId: ReleasedConnectedServiceProfileIdV1Schema.optional(),
  }).strict(),
]));
const ReleasedConnectedServiceBindingsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  bindingsByServiceId: z.partialRecord(
    ReleasedConnectedServiceIdV1Schema,
    ReleasedConnectedServiceBindingV1Schema,
  ).default({}),
}).strict());
const ReleasedSessionAuthoringCheckoutCreationDraftV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('git_worktree'),
  displayName: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).nullable(),
  branchMode: z.enum(['new', 'existing']).optional(),
}).strict());
const ReleasedSessionMcpSelectionV1Schema = lazyZodSchema(() => z.preprocess(
  (raw) => (!raw || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw),
  z.object({
    v: z.literal(1).default(1),
    managedServersEnabled: z.boolean().default(true),
    forceIncludeServerIds: z.array(z.string().min(1)).default([]),
    forceExcludeServerIds: z.array(z.string().min(1)).default([]),
  }),
).transform((value) => ({
  ...value,
  forceIncludeServerIds: [...new Set(value.forceIncludeServerIds)],
  forceExcludeServerIds: [...new Set(value.forceExcludeServerIds)],
})));
const ReleasedSyncedSessionAuthoringTerminalV1Schema = lazyZodSchema(() => z.object({
  mode: z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
  }).strict().optional(),
}).strict());
const ReleasedSessionAuthoringAutomationV1Schema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  scheduleKind: z.enum(['interval', 'cron', 'manual']),
  everyMinutes: z.number().int().min(1).max(24 * 60),
  cronExpr: z.string(),
  timezone: z.string().nullable(),
}).strict());

export const SyncedSessionAuthoringValueV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1).nullable().optional(),
  serverId: z.string().trim().min(1).nullable().optional(),
  targetType: z.enum(['new_session', 'existing_session']),
  directory: z.string().trim().min(1),
  checkoutCreationDraft: ReleasedSessionAuthoringCheckoutCreationDraftV1Schema.nullable(),
  agentId: z.string().trim().min(1).nullable(),
  backendTarget: ReleasedBackendTargetRefV1Schema.nullable(),
  transcriptStorage: z.enum(['persisted', 'direct']).nullable(),
  profileId: z.string().nullable(),
  // Agent-issued and opaque: the released wire shape is a plain string, and the
  // reader's job is presence, not canonicalization.
  resumeSessionId: NonBlankOpaqueIdentifierSchema.nullable(),
  permissionMode: z.string().trim().min(1).nullable(),
  modelId: z.string().trim().min(1).nullable(),
  mcpSelection: ReleasedSessionMcpSelectionV1Schema.nullable(),
  connectedServices: ReleasedConnectedServiceBindingsV1Schema.nullable(),
  terminal: ReleasedSyncedSessionAuthoringTerminalV1Schema.nullable(),
  windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).nullable(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).nullable(),
  windowsTerminalWindowName: z.unknown().transform((value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || new Set(['new', '-1', 'last', '0']).has(trimmed.toLowerCase())) return 'happier';
    return trimmed;
  }).nullable(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).nullable(),
  acpSessionModeId: z.string().trim().min(1).nullable(),
  automation: ReleasedSessionAuthoringAutomationV1Schema.nullable(),
}).strict());

export const SYNCED_SESSION_AUTHORING_FIELD_IDS_V1 = Object.freeze(
  Object.keys(SyncedSessionAuthoringValueV1Schema.shape) as Array<keyof typeof SyncedSessionAuthoringValueV1Schema.shape>,
);
export type SyncedSessionAuthoringFieldIdV1 = (typeof SYNCED_SESSION_AUTHORING_FIELD_IDS_V1)[number];
export const SyncedSessionAuthoringFieldIdV1Schema = lazyZodSchema(() => z.enum(
  SYNCED_SESSION_AUTHORING_FIELD_IDS_V1 as [SyncedSessionAuthoringFieldIdV1, ...SyncedSessionAuthoringFieldIdV1[]],
));
export type SyncedSessionAuthoringValueV1 = typeof SyncedSessionAuthoringValueV1Schema['_output'];
