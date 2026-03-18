import { z } from 'zod';

import { BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { SessionMcpSelectionV1Schema } from '../mcpServers/sessionSelectionV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../sessionMetadata/metadataOverridesV1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../sessionMetadata/windowsRemoteSessionLaunchMode.js';
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

export const SessionAuthoringTerminalV1Schema = z.object({
  mode: z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  }).optional(),
}).strict();

export const SessionAuthoringAutomationV1Schema = z.object({
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  scheduleKind: z.enum(['interval', 'cron']),
  everyMinutes: z.number().int().min(1).max(24 * 60),
  cronExpr: z.string(),
  timezone: z.string().nullable(),
}).strict();

export const SessionAuthoringCodexBackendModeSchema = z.enum(['mcp', 'acp', 'appServer']);

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
  targetType: {
    schema: z.enum(['new_session', 'existing_session']),
    description: 'Whether authored intent launches a new session or targets an existing session.',
    storageClass: 'template',
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
  modelId: {
    schema: z.string().trim().min(1).nullable(),
    description: 'Selected model id for the authored session/runtime.',
    storageClass: 'template',
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
  modelUpdatedAt: {
    schema: z.number().int().nullable(),
    description: 'Timestamp for the last model change authored into the session configuration.',
    storageClass: 'derived',
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
  mcpSelection: {
    schema: SessionMcpSelectionV1Schema.nullable(),
    description: 'Managed/unmanaged MCP selection authored for the session.',
    storageClass: 'template',
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
