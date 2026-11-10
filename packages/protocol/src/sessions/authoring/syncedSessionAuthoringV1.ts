import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';

/**
 * Immutable `server-v0.2.11` synchronized authoring projection.
 *
 * This released projection stays in a dependency-light leaf so compatibility
 * readers do not initialize the current authoring catalog and its dependencies.
 * `opaqueIdentifier.js` is a zod-only leaf and keeps that property.
 */
const ReleasedBackendTargetRefV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('builtInAgent'), agentId: z.string().check(z.minLength(1)) }),
  z.object({ kind: z.literal('configuredAcpBackend'), backendId: z.string().check(z.minLength(1)) }),
]));
const ReleasedConnectedServiceProfileIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/)));
const ReleasedConnectedServiceAuthGroupIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(64), z.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)));
const ReleasedConnectedServiceIdV1Schema = lazyZodSchema(() => z.enum([
  'openai-codex',
  'openai',
  'anthropic',
  'claude-subscription',
  'gemini',
  'github',
]));
const ReleasedConnectedServiceBindingV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ source: z.literal('native') }),
  z.strictObject({
    source: z.literal('connected'),
    selection: z._default(z.optional(z.literal('profile')), 'profile'),
    profileId: ReleasedConnectedServiceProfileIdV1Schema,
  }),
  z.strictObject({
    source: z.literal('connected'),
    selection: z.literal('group'),
    groupId: ReleasedConnectedServiceAuthGroupIdV1Schema,
    profileId: z.optional(ReleasedConnectedServiceProfileIdV1Schema),
  }),
]));
const ReleasedConnectedServiceBindingsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  bindingsByServiceId: z._default(z.partialRecord(
    ReleasedConnectedServiceIdV1Schema,
    ReleasedConnectedServiceBindingV1Schema,
  ), {}),
}));
const ReleasedSessionAuthoringCheckoutCreationDraftV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('git_worktree'),
  displayName: z.string().check(z.trim(), z.minLength(1)),
  baseRef: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  branchMode: z.optional(z.enum(['new', 'existing'])),
}));
const ReleasedSyncedSessionAuthoringTerminalV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.optional(z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console'])),
  tmux: z.optional(z.strictObject({
    sessionName: z.optional(z.string()),
    isolated: z.optional(z.boolean()),
  })),
}));
const ReleasedSessionAuthoringAutomationV1Schema = lazyZodSchema(() => z.strictObject({
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  scheduleKind: z.enum(['interval', 'cron', 'manual']),
  everyMinutes: z.number().check(z.int(), z.minimum(1), z.maximum(24 * 60)),
  cronExpr: z.string(),
  timezone: z.nullable(z.string()),
}));

export const SyncedSessionAuthoringValueV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  serverId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  targetType: z.enum(['new_session', 'existing_session']),
  directory: z.string().check(z.trim(), z.minLength(1)),
  checkoutCreationDraft: z.nullable(ReleasedSessionAuthoringCheckoutCreationDraftV1Schema),
  agentId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  backendTarget: z.nullable(ReleasedBackendTargetRefV1Schema),
  transcriptStorage: z.nullable(z.enum(['persisted', 'direct'])),
  profileId: z.nullable(z.string()),
  // Agent-issued and opaque: the released wire shape is a plain string, and the
  // reader's job is presence, not canonicalization.
  resumeSessionId: z.nullable(NonBlankOpaqueIdentifierSchema),
  permissionMode: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  modelId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  mcpSelection: z.nullable(SessionMcpSelectionV1Schema),
  connectedServices: z.nullable(ReleasedConnectedServiceBindingsV1Schema),
  terminal: z.nullable(ReleasedSyncedSessionAuthoringTerminalV1Schema),
  windowsRemoteSessionLaunchMode: z.nullable(z.enum(['hidden', 'windows_terminal', 'console'])),
  windowsRemoteSessionConsole: z.nullable(z.enum(['hidden', 'visible'])),
  windowsTerminalWindowName: z.nullable(z.pipe(z.unknown(), z.transform((value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || new Set(['new', '-1', 'last', '0']).has(trimmed.toLowerCase())) return 'happier';
    return trimmed;
  }))),
  codexBackendMode: z.nullable(z.enum(['mcp', 'acp', 'appServer'])),
  acpSessionModeId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  automation: z.nullable(ReleasedSessionAuthoringAutomationV1Schema),
}));

export const SYNCED_SESSION_AUTHORING_FIELD_IDS_V1 = Object.freeze(
  Object.keys(SyncedSessionAuthoringValueV1Schema.shape) as Array<keyof typeof SyncedSessionAuthoringValueV1Schema.shape>,
);
export type SyncedSessionAuthoringFieldIdV1 = (typeof SYNCED_SESSION_AUTHORING_FIELD_IDS_V1)[number];
export const SyncedSessionAuthoringFieldIdV1Schema = lazyZodSchema(() => z.enum(
  SYNCED_SESSION_AUTHORING_FIELD_IDS_V1 as [SyncedSessionAuthoringFieldIdV1, ...SyncedSessionAuthoringFieldIdV1[]],
));
export type SyncedSessionAuthoringValueV1 = z.output<typeof SyncedSessionAuthoringValueV1Schema>;
