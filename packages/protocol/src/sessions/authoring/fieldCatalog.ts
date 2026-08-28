import { z } from 'zod';

import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { RuntimeDescriptorV1Schema } from '../metadata/runtimeDescriptorV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../metadata/metadataOverridesV1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../metadata/windowsTerminalWindowName.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import {
  ConnectedServiceBindingsV1Schema,
} from '../../connect/connectedServiceBindings.js';
import { defineSessionAuthoringFields } from './fieldDefinition.js';
import { AutomationTriggerDefinitionSchema } from '../../automations/automationTriggerDefinition.js';
import {
  SessionAuthoringCheckoutCreationDraftV1Schema,
  SessionAuthoringTerminalV1Schema,
} from './creationFieldsV1.js';
import { SessionExecutionTargetV1Schema } from '../creation/sessionExecutionTargetV1.js';
import { SessionOrganizationPlacementV1Schema } from '../creation/sessionSpawnNewResultV1.js';

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

export const SyncedSessionAuthoringTerminalV1Schema = z.object({
  mode: z.enum(['integrated', 'plain', 'tmux', 'windows_terminal', 'windows_console']).optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const SyncedSessionAuthoringConnectedServicesV1Schema = ConnectedServiceBindingsV1Schema;

export const SessionAuthoringAutomationTriggerDraftV1Schema = z.object({
  clientId: z.string().trim().min(1),
  kind: z.enum(['schedule', 'pluginEvent', 'sessionLifecycle']),
  persisted: z.null(),
  enabled: z.boolean(),
  definition: AutomationTriggerDefinitionSchema.nullable(),
}).strict().superRefine((trigger, context) => {
  if (trigger.definition !== null && trigger.definition.kind !== trigger.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['definition', 'kind'],
      message: 'Automation trigger row kind must match its definition',
    });
  }
});

export const SessionAuthoringAutomationV1Schema = z.object({
  enabled: z.boolean(),
  name: z.string(),
  description: z.string(),
  triggers: z.array(SessionAuthoringAutomationTriggerDraftV1Schema),
}).strict().superRefine((automation, context) => {
  const clientIds = new Set<string>();
  automation.triggers.forEach((trigger, index) => {
    if (clientIds.has(trigger.clientId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['triggers', index, 'clientId'],
        message: 'Automation trigger client identities must be unique',
      });
    }
    clientIds.add(trigger.clientId);
  });
});

/**
 * Reader-only values emitted by the current `remote-dev` predecessor's synced
 * Session-draft catalog. Current writers continue to derive their fields from
 * `draftStorage: 'sync'`, which excludes `modelId` and rejects `manual`.
 * Remove this adapter when predecessor-persisted Session drafts are no longer
 * a supported input to dev readers.
 */
export const PredecessorSessionDraftModelIdV1Schema = z.string().trim().min(1).nullable();
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
    draftStorage: 'sync',
    contexts: [...TEMPLATE_CONTEXTS],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
  },
  executionTarget: {
    schema: SessionExecutionTargetV1Schema.nullable(),
    description: 'Exact server-qualified execution target for a not-yet-created session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession', 'automationExistingSession'],
    defaultSurface: 'hidden',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
      automationExistingSession: 'inherited',
    },
    default: null,
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
  organizationPlacement: {
    schema: SessionOrganizationPlacementV1Schema,
    description: 'Creation-time Account folder and tag placement for a new session.',
    storageClass: 'template',
    draftStorage: 'sync',
    contexts: ['newSession', 'automationNewSession'],
    defaultSurface: 'chip+section',
    defaultEditabilityByContext: {
      newSession: 'editable',
      automationNewSession: 'editable',
    },
    default: { folderId: null, tagIds: [] },
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
  agentTarget: {
    schema: AgentExecutionTargetV1Schema.nullable(),
    description: 'Canonical executable Agent contribution selected for the authored session.',
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
  runtimeDescriptorV1: {
    schema: RuntimeDescriptorV1Schema.nullable(),
    description: 'Opaque Agent-owned runtime selection bound to the selected Agent.',
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
