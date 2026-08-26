import { z } from 'zod';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { CODEX_BACKEND_MODES } from '../../agents/generated/runtime/descriptors/codex.js';
import { AcpConfigOptionOverridesV1Schema } from '../metadata/metadataOverridesV1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../metadata/windowsTerminalWindowName.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../../connect/connectedServiceBindings.js';
import { defineSessionAuthoringFields } from './fieldDefinition.js';

type SessionAuthoringJsonPrimitive = null | string | number | boolean;
export interface SessionAuthoringJsonObject {
  readonly [key: string]: SessionAuthoringJsonValue;
}
export type SessionAuthoringJsonArray = ReadonlyArray<SessionAuthoringJsonValue>;
export type SessionAuthoringJsonValue =
  | SessionAuthoringJsonPrimitive
  | SessionAuthoringJsonArray
  | SessionAuthoringJsonObject;

const SessionAuthoringJsonValueSchema: z.ZodType<SessionAuthoringJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(SessionAuthoringJsonValueSchema),
    z.record(z.string(), SessionAuthoringJsonValueSchema),
  ]),
);

export const SessionAuthoringCheckoutCreationDraftV1Schema = z.object({
  kind: z.literal('git_worktree'),
  displayName: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).nullable(),
  branchMode: z.enum(['new', 'existing']).optional(),
}).strict();

const SessionAuthoringWindowsTerminalV1Schema = z.object({
  launchMode: WindowsRemoteSessionLaunchModeSchema.optional(),
  console: z.enum(['hidden', 'visible']).optional(),
  windowName: WindowsTerminalWindowNameSchema.optional(),
}).strict();

export const SessionAuthoringTerminalV1Schema = z.object({
  mode: z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  }).strict().optional(),
  windows: SessionAuthoringWindowsTerminalV1Schema.optional(),
}).strict();

export const SyncedSessionAuthoringTerminalV1Schema = z.object({
  mode: z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const SyncedSessionAuthoringConnectedServicesV1Schema = z.object({
  v: z.literal(1),
  bindingsByServiceId: z.partialRecord(ConnectedServiceIdSchema, z.union([
    z.object({ source: z.literal('native') }).strict(),
    z.object({
      source: z.literal('connected'),
      selection: z.literal('profile').optional().default('profile'),
      profileId: ConnectedServiceProfileIdSchema,
    }).strict(),
    z.object({
      source: z.literal('connected'),
      selection: z.literal('group'),
      groupId: ConnectedServiceAuthGroupIdSchema,
      profileId: ConnectedServiceProfileIdSchema.optional(),
    }).strict(),
  ])).default({}),
}).strict();

export const SessionAuthoringAutomationV1Schema = z.object({
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  scheduleKind: z.enum(['interval', 'cron']),
  everyMinutes: z.number().int().min(1).max(24 * 60),
  cronExpr: z.string(),
  timezone: z.string().nullable(),
}).passthrough();

/**
 * Reader-only values emitted by the current `remote-dev` predecessor's synced
 * Session-draft catalog. Current writers continue to derive their fields from
 * `draftStorage: 'sync'`, which excludes `modelId` and rejects `manual`.
 * Remove this adapter when predecessor-persisted Session drafts are no longer
 * a supported input to dev readers.
 */
export const PredecessorSessionDraftModelIdV1Schema = z.string().trim().min(1).nullable();
export const PredecessorSessionDraftManualAutomationV1Schema = z.object({
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  scheduleKind: z.literal('manual'),
  everyMinutes: z.number().int().min(1).max(24 * 60),
  cronExpr: z.string(),
  timezone: z.string().nullable(),
}).strict();

export const SessionAuthoringCodexBackendModeSchema = z.enum(CODEX_BACKEND_MODES);

const ALL_AUTHORING_CONTEXTS = [
  'newSession',
  'liveSession',
  'automationNewSession',
  'automationExistingSession',
] as const;


const TEMPLATE_CONTEXTS = [
  'newSession',
  'automationNewSession',
  'automationExistingSession',
] as const;

const LIVE_ONLY_CONTEXTS = [
  'liveSession',
] as const;

export const SESSION_AUTHORING_FIELD_CATALOG = defineSessionAuthoringFields({
  machineId: {
    schema: z.string().trim().min(1).nullable().optional(),
    description: 'Selected execution machine for a not-yet-created session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: null,
  },
  serverId: {
    schema: z.string().trim().min(1).nullable().optional(),
    description: 'Selected server scope for a not-yet-created session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: null,
  },
  targetType: {
    schema: z.enum(['new_session', 'existing_session']),
    description: 'Whether authored intent launches a new session or targets an existing session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...TEMPLATE_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
  },
  directory: {
    schema: z.string().trim().min(1),
    description: 'Primary working directory for the authored session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...TEMPLATE_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
  },
  checkoutCreationDraft: {
    schema: SessionAuthoringCheckoutCreationDraftV1Schema.nullable(),
    description: 'Worktree creation draft persisted in authoring state before session creation.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...TEMPLATE_CONTEXTS],
    defaultSurface: 'chip+section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  prompt: {
    schema: z.string(),
    description: 'Primary prompt/body authored for the session or automation.',
    storageClass: 'template',
    draftStorage: 'composer',
    contexts: [...TEMPLATE_CONTEXTS, ...LIVE_ONLY_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'editable',
    },
    default: '',
  },
  displayText: {
    schema: z.string(),
    description: 'Display-safe prompt text when the rendered message differs from raw prompt input.',
    storageClass: 'derived',
    draftStorage: 'exclude',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'editable',
    },
    default: '',
  },
  agentId: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Selected built-in agent id when targeting a built-in backend.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  backendTarget: {
    schema: BackendTargetRefSchema.nullable(),
    description: 'Canonical backend target reference for built-in and configured backends.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  transcriptStorage: {
    schema: z.enum(['persisted', 'direct']).nullable(),
    description: 'Requested transcript storage mode for the authored session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  profileId: {
    schema: z.string().nullable(),
    description: 'Selected profile id to apply when the authored session starts.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  environmentVariables: {
    schema: z.record(z.string(), z.string()).nullable(),
    description: 'Explicit environment-variable overrides applied to the authored session.',
    storageClass: 'template',
    draftStorage: 'exclude',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  resumeSessionId: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Requested resume session id when session start should attach/reuse an existing runner.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: null,
  },
  permissionMode: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Selected permission mode persisted as authored session intent.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'editable',
    },
    default: null,
  },
  permissionModeUpdatedAt: {
    schema: z.number().int().nullable(),
    description: 'Timestamp for the last permission-mode change authored into the session configuration.',
    storageClass: 'derived',
    draftStorage: 'exclude',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'editable',
    },
    default: null,
  },
  modelSelection: {
    schema: SessionModelSelectionV1Schema.nullable().default(null),
    description: 'Explicit target-bound model selection; null means the agent default/automatic model.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'editable',
    },
    default: null,
  },
  modelId: {
    schema: z.string().trim().min(1).nullable().optional(),
    description: 'Read-only compatibility field for legacy authored model ids. New writers use modelSelection.',
    storageClass: 'derived',
    draftStorage: 'exclude',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'hidden',
      liveSession: 'hidden',
      automationNewSession: 'hidden',
      automationExistingSession: 'hidden',
    },
  },
  modelUpdatedAt: {
    schema: z.number().int().nullable().optional(),
    description: 'Read-only compatibility timestamp for legacy authored model ids.',
    storageClass: 'derived',
    draftStorage: 'exclude',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'hidden',
      liveSession: 'hidden',
      automationNewSession: 'hidden',
      automationExistingSession: 'hidden',
    },
  },
  mcpSelection: {
    schema: SessionMcpSelectionV1Schema.nullable(),
    description: 'Managed/unmanaged MCP selection authored for the session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  connectedServices: {
    schema: SessionAuthoringJsonValueSchema.nullable(),
    description: 'Connected-services binding payload authored for the session runtime.',
    storageClass: 'template',
    draftStorage: 'sync',
    draftSchema: SyncedSessionAuthoringConnectedServicesV1Schema.nullable(),
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  terminal: {
    schema: SessionAuthoringTerminalV1Schema.nullable(),
    description: 'Terminal/runtime attach preferences authored for the session.',
    storageClass: 'template',
    draftStorage: 'sync',
    draftSchema: SyncedSessionAuthoringTerminalV1Schema.nullable(),
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  windowsRemoteSessionLaunchMode: {
    schema: WindowsRemoteSessionLaunchModeSchema.nullable(),
    description: 'Windows remote-session launch mode for authored sessions on Windows.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: null,
  },
  windowsRemoteSessionConsole: {
    schema: z.enum(['hidden', 'visible']).nullable(),
    description: 'Windows console visibility setting for authored sessions.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: null,
  },
  windowsTerminalWindowName: {
    schema: WindowsTerminalWindowNameSchema.nullable(),
    description: 'Windows Terminal named window target for authored Windows remote sessions.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: null,
  },
  codexBackendMode: {
    schema: SessionAuthoringCodexBackendModeSchema.nullable(),
    description: 'Transitional Codex-specific runtime mode. Keep in compatibility/adapters, not as a permanent generic runtime abstraction.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  acpSessionModeId: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Selected ACP session mode id for providers/runtime kinds that expose session modes.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'chip',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  sessionConfigOptionOverrides: {
    schema: AcpConfigOptionOverridesV1Schema.nullable(),
    description: 'Structured session configuration-option overrides authored for the session runtime.',
    storageClass: 'template',
    draftStorage: 'exclude',
    contexts: [...ALL_AUTHORING_CONTEXTS],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      liveSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  existingSessionId: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Bound existing-session target id for existing-session automations and related authoring contexts.',
    storageClass: 'inheritedOnly',
    draftStorage: 'exclude',
    contexts: ['automationExistingSession'],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  sessionEncryptionMode: {
    schema: z.enum(['e2ee', 'plain']).nullable(),
    description: 'Storage-encryption mode for authored existing-session automation targets.',
    storageClass: 'inheritedOnly',
    draftStorage: 'exclude',
    contexts: ['automationExistingSession'],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      automationExistingSession: 'inherited',
    },
    default: null,
  },
  sessionEncryptionKeyBase64: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Optional data key required to re-open encrypted existing-session targets.',
    storageClass: 'inheritedOnly',
    draftStorage: 'exclude',
    contexts: ['automationExistingSession'],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  sessionEncryptionVariant: {
    schema: z.literal('dataKey').nullable(),
    description: 'Encryption key variant for existing-session automation targets.',
    storageClass: 'inheritedOnly',
    draftStorage: 'exclude',
    contexts: ['automationExistingSession'],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      automationExistingSession: 'hidden',
    },
    default: null,
  },
  automation: {
    schema: SessionAuthoringAutomationV1Schema.nullable(),
    description: 'Inline automation metadata attached to the current authored session intent.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession', 'automationExistingSession'],
    defaultSurface: 'section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'editable',
    },
    default: null,
  },
});
