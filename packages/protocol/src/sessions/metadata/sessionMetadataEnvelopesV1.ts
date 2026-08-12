import { z } from 'zod';

import {
  openAccountScopedBlobCiphertext,
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { getGeneratedRuntimeDescriptorContributionV1 } from '../../agents/runtimeDescriptorContributionsV1.js';
import { resolveGeneratedSessionPresentationAgentIdV1 } from '../../agents/generated/sessionPresentationCompatV1.js';
import {
  ConnectedServiceIdSchema,
  PersistedConnectedServiceBindingsV1Schema,
} from '../../connect/connectedServiceBindings.js';
import { ConnectedServiceCredentialRevisionV1Schema } from '../../connect/connectedServiceSchemas.js';
import { PluginAgentExternalSessionLinkDataSchema } from '../../plugins/contributions/agentExternalSessions.js';
import { PluginSourceKindV1Schema } from '../../plugins/sourceSpecV1.js';
import { SessionAppliedModelV1Schema, SessionModelSelectionIntentV1Schema } from '../../providers/selection/v1.js';
import { SessionProviderBindingMetadataV1Schema } from '../../providers/sessions/bindingMetadataV1.js';
import {
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionOperationStateV1Schema,
  projectExternalSessionOperationSharedPresentationV1,
} from '../external/operationV1.js';
import { ExternalAgentObservationSnapshotV1Schema } from '../external/externalAgentObservationV1.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from '../external/linkedSessionMetadata.js';
import { ExternalSessionsSourceSchema } from '../external/sourceCatalog.js';
import { SessionRunnerRuntimeStateV1Schema } from '../control/sessionRunnerRuntimeV1.js';
import {
  SessionRuntimeActivityProjectionSchema,
  SessionRuntimeActivitySnapshotSchema,
} from '../runtime/activity/sessionRuntimeActivity.js';
import { SessionPendingQueueHoldV1Schema } from './sessionPendingQueueHoldV1.js';
import { ProviderAccountUsageRefsV1Schema } from './providerAccountUsageRefsV1.js';
import { SessionUsageLimitRecoveryV1Schema } from '../state/valueSchemas/usageLimitRecovery.js';
import { SessionRollbackTargetSchema } from '../rollback.js';
import { parseVoiceAgentRunMetadataV1 } from '../../voice/voiceAgentRunMetadataV1.js';
import { AgentSessionStartupInstructionsMarkerV1Schema } from '../../runtime/agentSessionStartupInstructionsV1.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { ContentPublicKeyFingerprintSchema } from '../../machines/identity/installationIdentity.js';

export const SESSION_METADATA_LAYOUT_VERSION_V1 = 1 as const;
export const SESSION_SHARED_METADATA_VERSION_V1 = 1 as const;
export const SESSION_OWNER_METADATA_VERSION_V1 = 1 as const;
export const SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND =
  'session_owner_metadata' as const;
export const SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND_BYTE_V1 = 10 as const;

const BoundedIdentifierSchema = z.string().trim().min(1).max(256);
const BoundedPresentationTextSchema = z.string().trim().min(1).max(2_048);
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SessionEnvelopeVersionSchema =
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SessionOpaqueCiphertextSchema = z.string().min(1).max(10_000_000);
const MAX_PUBLIC_COMPLETED_REQUESTS_V1 = 2_048;

export const SessionOwnerMetadataCiphertextV1Schema =
  SessionOpaqueCiphertextSchema.refine(isSessionOwnerMetadataCiphertextV1, {
    message: 'Expected canonical Session owner-metadata ciphertext',
  });
export type SessionOwnerMetadataCiphertextV1 = z.infer<
  typeof SessionOwnerMetadataCiphertextV1Schema
>;

export const SessionMetadataEnvelopeTupleV1Schema = z.object({
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  sharedMetadata: z.object({
    ciphertext: SessionOpaqueCiphertextSchema,
    version: SessionEnvelopeVersionSchema,
  }).strict(),
  ownerMetadata: z.object({
    ciphertext: SessionOwnerMetadataCiphertextV1Schema,
  }).strict(),
  agentState: z.object({
    ciphertext: SessionOpaqueCiphertextSchema.nullable(),
    version: SessionEnvelopeVersionSchema,
  }).strict(),
}).strict();
export type SessionMetadataEnvelopeTupleV1 = z.infer<
  typeof SessionMetadataEnvelopeTupleV1Schema
>;

const SessionMetadataSharedPatchV1Schema = z.object({
  ciphertext: SessionOpaqueCiphertextSchema,
  expectedVersion: SessionEnvelopeVersionSchema,
}).strict();

export const SessionMetadataOwnerMigrationPatchV1Schema = z.object({
  mode: z.literal('owner_migration'),
  expectedAccountEncryptionMode: AccountEncryptionModeSchema,
  expectedAccountContentPublicKeyFingerprint:
    ContentPublicKeyFingerprintSchema,
  source: z.object({
    metadataLayoutVersion: z.literal(0),
    metadata: z.object({
      version: SessionEnvelopeVersionSchema,
      ciphertext: SessionOpaqueCiphertextSchema,
    }).strict(),
    ownerMetadata: z.null(),
    agentState: z.object({
      version: SessionEnvelopeVersionSchema,
      ciphertext: SessionOpaqueCiphertextSchema.nullable(),
    }).strict(),
  }).strict(),
  target: z.object({
    metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    sharedMetadata: z.object({
      ciphertext: SessionOpaqueCiphertextSchema,
    }).strict(),
    ownerMetadata: z.object({
      ciphertext: SessionOwnerMetadataCiphertextV1Schema,
    }).strict(),
    agentState: z.object({
      ciphertext: SessionOpaqueCiphertextSchema.nullable(),
    }).strict(),
  }).strict(),
}).strict();
export type SessionMetadataOwnerMigrationPatchV1 = z.infer<
  typeof SessionMetadataOwnerMigrationPatchV1Schema
>;

export const SessionMetadataInactiveModelIntentExpectationV1Schema = z.object({
  kind: z.literal('inactive_model_intent'),
}).strict();
export type SessionMetadataInactiveModelIntentExpectationV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentExpectationV1Schema
>;

export const SessionMetadataInactiveModelIntentPatchV1Schema = z.object({
  inactiveModelIntent: z.object({
    metadata: SessionMetadataSharedPatchV1Schema,
    sessionExpectation:
      SessionMetadataInactiveModelIntentExpectationV1Schema,
  }).strict(),
}).strict();
export type SessionMetadataInactiveModelIntentPatchV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentPatchV1Schema
>;

export const SessionMetadataOwnerPatchV1Schema = z.object({
  mode: z.literal('owner'),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  expectedOwnerMetadataCiphertext:
    SessionOwnerMetadataCiphertextV1Schema,
  sharedMetadata: SessionMetadataSharedPatchV1Schema,
  ownerMetadata: z.object({
    ciphertext: SessionOwnerMetadataCiphertextV1Schema,
  }).strict(),
  agentState: z.object({
    ciphertext: SessionOpaqueCiphertextSchema.nullable(),
    expectedVersion: SessionEnvelopeVersionSchema,
  }).strict(),
}).strict();
export type SessionMetadataOwnerPatchV1 = z.infer<
  typeof SessionMetadataOwnerPatchV1Schema
>;

export const SessionMetadataInactiveModelIntentOwnerPatchV1Schema =
  SessionMetadataOwnerPatchV1Schema.extend({
    mode: z.literal('owner_inactive_model_intent'),
    sessionExpectation:
      SessionMetadataInactiveModelIntentExpectationV1Schema,
  });
export type SessionMetadataInactiveModelIntentOwnerPatchV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentOwnerPatchV1Schema
>;

export const SessionMetadataTuplePatchV1Schema = z.discriminatedUnion('mode', [
  SessionMetadataOwnerMigrationPatchV1Schema,
  SessionMetadataOwnerPatchV1Schema,
  z.object({
    mode: z.literal('shared_editor'),
    metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    sharedMetadata: SessionMetadataSharedPatchV1Schema,
  }).strict(),
]);
export type SessionMetadataTuplePatchV1 = z.infer<
  typeof SessionMetadataTuplePatchV1Schema
>;

export const SessionMetadataTuplePatchSuccessV1Schema = z.object({
  success: z.literal(true),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  sharedMetadata: z.object({
    version: SessionEnvelopeVersionSchema,
  }).strict(),
  agentState: z.object({
    version: SessionEnvelopeVersionSchema,
  }).strict().optional(),
}).strict();
export type SessionMetadataTuplePatchSuccessV1 = z.infer<
  typeof SessionMetadataTuplePatchSuccessV1Schema
>;

export const SessionMetadataVersionConflictV1Schema = z.object({
  code: z.literal('session_metadata_version_conflict'),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  sharedMetadata: z.object({
    version: SessionEnvelopeVersionSchema,
  }).strict(),
  agentState: z.object({
    version: SessionEnvelopeVersionSchema,
  }).strict().optional(),
}).strict();
export type SessionMetadataVersionConflictV1 = z.infer<
  typeof SessionMetadataVersionConflictV1Schema
>;

export const SessionMetadataActiveConflictV1Schema = z.object({
  code: z.literal('session_active'),
}).strict();
export type SessionMetadataActiveConflictV1 = z.infer<
  typeof SessionMetadataActiveConflictV1Schema
>;

export const SessionMetadataInactiveModelIntentPatchSuccessV1Schema =
  z.object({
    success: z.literal(true),
    metadata: z.object({
      version: SessionEnvelopeVersionSchema,
    }).strict(),
  }).strict();
export type SessionMetadataInactiveModelIntentPatchSuccessV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentPatchSuccessV1Schema
>;

export const SessionMetadataInactiveModelIntentVersionConflictV1Schema =
  z.object({
    success: z.literal(false),
    error: z.literal('version-mismatch'),
    metadata: z.object({
      version: SessionEnvelopeVersionSchema,
      value: z.string().nullable(),
    }).strict(),
  }).strict();
export type SessionMetadataInactiveModelIntentVersionConflictV1 = z.infer<
  typeof SessionMetadataInactiveModelIntentVersionConflictV1Schema
>;

const SessionMetadataSharedRecipientProjectionV1Schema = z.object({
  metadata: SessionOpaqueCiphertextSchema,
  metadataVersion: SessionEnvelopeVersionSchema,
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
  agentState: z.null(),
  agentStateVersion: SessionEnvelopeVersionSchema,
}).strict();

const SessionMetadataOwnerRecipientProjectionV1Schema =
  SessionMetadataSharedRecipientProjectionV1Schema.extend({
    ownerMetadata: SessionOwnerMetadataCiphertextV1Schema,
    agentState: SessionOpaqueCiphertextSchema.nullable(),
    agentStateVersion: SessionEnvelopeVersionSchema,
  }).strict();

/**
 * Layout-v1 recipient wire projection. A shared participant/public recipient
 * receives an explicit null Agent-state tombstone at the authoritative version
 * so an older full-state cache cannot survive the layout boundary. Only the
 * owner branch may carry a non-null full Agent-state ciphertext, and it also
 * requires the owner envelope.
 */
export const SessionMetadataRecipientProjectionV1Schema = z.union([
  SessionMetadataOwnerRecipientProjectionV1Schema,
  SessionMetadataSharedRecipientProjectionV1Schema,
]);
export type SessionMetadataRecipientProjectionV1 = z.infer<
  typeof SessionMetadataRecipientProjectionV1Schema
>;

export const SessionSharedSummaryV1Schema = z.object({
  text: BoundedPresentationTextSchema,
  updatedAt: TimestampSchema,
}).strict();
export type SessionSharedSummaryV1 = z.infer<
  typeof SessionSharedSummaryV1Schema
>;

export const SessionSharedAgentPresentationV1Schema = z.object({
  agentId: BoundedIdentifierSchema,
  label: z.string().trim().min(1).max(256).optional(),
}).strict();
export type SessionSharedAgentPresentationV1 = z.infer<
  typeof SessionSharedAgentPresentationV1Schema
>;

export const SessionPublicCompletedRequestV1Schema = z.object({
  tool: BoundedIdentifierSchema,
  kind: z.string().trim().min(1).max(128).optional(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema,
  status: z.enum(['canceled', 'denied', 'approved']),
}).strict();
export type SessionPublicCompletedRequestV1 = z.infer<
  typeof SessionPublicCompletedRequestV1Schema
>;

export const SessionPublicAgentStateV1Schema = z.object({
  completedRequests: z.record(
    z.string().trim().min(1).max(512),
    SessionPublicCompletedRequestV1Schema,
  ).refine(
    (completedRequests) =>
      Object.keys(completedRequests).length <= MAX_PUBLIC_COMPLETED_REQUESTS_V1,
    { message: 'completedRequests exceeds the v1 projection limit' },
  ),
}).strict();
export type SessionPublicAgentStateV1 = z.infer<
  typeof SessionPublicAgentStateV1Schema
>;

/**
 * The sole recipient-safe Session.metadata envelope. It intentionally has no
 * passthrough behavior: additive fields require an explicit schema/projector
 * decision before they can cross a share boundary.
 */
export const SessionSharedMetadataV1Schema = z.object({
  v: z.literal(SESSION_SHARED_METADATA_VERSION_V1),
  summary: SessionSharedSummaryV1Schema.optional(),
  agentPresentation: SessionSharedAgentPresentationV1Schema.optional(),
  externalSessionOperationPresentationV1:
    ExternalSessionOperationSharedPresentationV1Schema.optional(),
  publicAgentState: SessionPublicAgentStateV1Schema.optional(),
}).strict();
export type SessionSharedMetadataV1 = z.infer<
  typeof SessionSharedMetadataV1Schema
>;

const OptionalOwnerStringSchema = z.string().max(100_000).nullable();
const OptionalOwnerIdentifierSchema = z.string().trim().min(1).max(2_000).nullable();

const SessionOwnerWorkspaceV1Schema = z.object({
  path: OptionalOwnerStringSchema.optional(),
  host: OptionalOwnerStringSchema.optional(),
  version: OptionalOwnerStringSchema.optional(),
  name: OptionalOwnerStringSchema.optional(),
  os: OptionalOwnerStringSchema.optional(),
  machineId: OptionalOwnerIdentifierSchema.optional(),
  profileId: OptionalOwnerIdentifierSchema.optional(),
  homeDir: OptionalOwnerStringSchema.optional(),
  happyHomeDir: OptionalOwnerStringSchema.optional(),
  happyLibDir: OptionalOwnerStringSchema.optional(),
  happyToolsDir: OptionalOwnerStringSchema.optional(),
  flavor: OptionalOwnerIdentifierSchema.optional(),
  projectId: OptionalOwnerIdentifierSchema.optional(),
  workspaceId: OptionalOwnerIdentifierSchema.optional(),
  workspaceLocationId: OptionalOwnerIdentifierSchema.optional(),
  workspaceCheckoutId: OptionalOwnerIdentifierSchema.optional(),
}).strict();

export const SessionOwnerRuntimeDescriptorV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  backendMode: BoundedIdentifierSchema.nullable().optional(),
  providerSessionId: OptionalOwnerIdentifierSchema.optional(),
  backendId: OptionalOwnerIdentifierSchema.optional(),
  provenance: OptionalOwnerIdentifierSchema.optional(),
  home: z.enum(['user', 'connectedService']).nullable().optional(),
  connectedServiceId: OptionalOwnerIdentifierSchema.optional(),
  connectedServiceProfileId: OptionalOwnerIdentifierSchema.optional(),
  connectedServiceGroupId: OptionalOwnerIdentifierSchema.optional(),
  homePath: OptionalOwnerStringSchema.optional(),
  serverBaseUrl: OptionalOwnerStringSchema.optional(),
  serverBaseUrlExplicit: z.boolean().optional(),
  resumeStrategy: z.enum([
    'sessionFileBySessionId',
    'sessionFileAbsolutePreferred',
  ]).nullable().optional(),
  sessionFile: OptionalOwnerStringSchema.optional(),
}).strict();
export type SessionOwnerRuntimeDescriptorV1 = z.infer<
  typeof SessionOwnerRuntimeDescriptorV1Schema
>;

const GenericPluginRuntimeDescriptorSourceV1Schema = z.object({
  kind: PluginSourceKindV1Schema,
}).strict();

const GenericRuntimeDescriptorHandleIdentityV1Schema = z.object({
  backendId: BoundedIdentifierSchema,
  agentId: BoundedIdentifierSchema,
}).strict();

const GenericPluginRuntimeDescriptorEnvelopeAgentV1Schema = z.object({
  backendMode: BoundedIdentifierSchema,
  providerSessionId: OptionalOwnerIdentifierSchema.optional(),
  agentExtra: z.object({
    owner: z.literal('happier'),
    schemaId: z.literal('happier.pluginRuntimeDescriptorExtra'),
    v: z.literal(1),
    runtimeHandle: GenericRuntimeDescriptorHandleIdentityV1Schema.extend({
      provenance: z.enum(['first_party', 'external']),
      source: GenericPluginRuntimeDescriptorSourceV1Schema,
    }).strict(),
  }).strict(),
}).strict();

const GenericHostSessionRuntimeDescriptorEnvelopeAgentV1Schema = z.object({
  backendMode: BoundedIdentifierSchema,
  providerSessionId: OptionalOwnerIdentifierSchema.optional(),
  agentExtra: z.object({
    owner: z.literal('happier'),
    schemaId: z.literal('happier.hostSessionRuntimeIdentity'),
    v: z.literal(1),
    runtimeHandle: GenericRuntimeDescriptorHandleIdentityV1Schema.extend({
      provenance: z.enum(['first_party', 'external', 'configured']),
    }).strict(),
  }).strict(),
}).strict();

const GenericPluginProjectedRuntimeDescriptorAgentV1Schema =
  z.object({
    backendMode: BoundedIdentifierSchema,
    providerSessionId: OptionalOwnerIdentifierSchema.optional(),
    backendId: BoundedIdentifierSchema,
    provenance: z.enum(['first_party', 'external', 'configured']),
  }).strict();

const SessionOwnerExternalSourceV1Schema = ExternalSessionsSourceSchema;

const SessionOwnerFollowPolicyV1Schema = z.object({
  v: z.literal(1),
  policy: z.enum(['attached_only', 'background_follow']),
  updatedAtMs: TimestampSchema.optional(),
}).strict();

const SessionOwnerExternalSessionLinkV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  machineId: BoundedIdentifierSchema,
  remoteSessionId: z.string().trim().min(1).max(20_000),
  source: SessionOwnerExternalSourceV1Schema,
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema.optional(),
  linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
  linkedAtMs: TimestampSchema.optional(),
  lastKnownActivityAtMs: TimestampSchema.optional(),
  followPolicyV1: SessionOwnerFollowPolicyV1Schema.optional(),
  codexBackendMode: BoundedIdentifierSchema.optional(),
  runtimeDescriptorV1: SessionOwnerRuntimeDescriptorV1Schema.optional(),
}).strict();

const SessionOwnerDirectSessionLinkV1Schema = z.object({
  v: z.literal(1),
  providerId: BoundedIdentifierSchema,
  machineId: BoundedIdentifierSchema,
  remoteSessionId: z.string().trim().min(1).max(20_000),
  source: SessionOwnerExternalSourceV1Schema,
  linkedAtMs: TimestampSchema.optional(),
  lastKnownActivityAtMs: TimestampSchema.optional(),
  followPolicyV1: SessionOwnerFollowPolicyV1Schema.optional(),
  codexBackendMode: BoundedIdentifierSchema.optional(),
  agentRuntimeDescriptorV1: SessionOwnerRuntimeDescriptorV1Schema.optional(),
}).strict();

const SessionOwnerNativeSessionV1Schema = z.object({
  runtimeDescriptorV1: SessionOwnerRuntimeDescriptorV1Schema.optional(),
  claudeSessionId: OptionalOwnerIdentifierSchema.optional(),
  codexSessionId: OptionalOwnerIdentifierSchema.optional(),
  geminiSessionId: OptionalOwnerIdentifierSchema.optional(),
  grokSessionId: OptionalOwnerIdentifierSchema.optional(),
  opencodeSessionId: OptionalOwnerIdentifierSchema.optional(),
  auggieSessionId: OptionalOwnerIdentifierSchema.optional(),
  qwenSessionId: OptionalOwnerIdentifierSchema.optional(),
  kimiSessionId: OptionalOwnerIdentifierSchema.optional(),
  kiloSessionId: OptionalOwnerIdentifierSchema.optional(),
  kiroSessionId: OptionalOwnerIdentifierSchema.optional(),
  ohMyPiSessionId: OptionalOwnerIdentifierSchema.optional(),
  piSessionId: OptionalOwnerIdentifierSchema.optional(),
  copilotSessionId: OptionalOwnerIdentifierSchema.optional(),
  cursorSessionId: OptionalOwnerIdentifierSchema.optional(),
  antigravitySessionId: OptionalOwnerIdentifierSchema.optional(),
  claudeTranscriptPath: OptionalOwnerStringSchema.optional(),
  claudeLastCheckpointId: OptionalOwnerIdentifierSchema.optional(),
  claudeLastAssistantUuid: OptionalOwnerIdentifierSchema.optional(),
  codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  opencodeBackendMode: z.enum(['server', 'acp']).optional(),
  opencodeServerBaseUrl: OptionalOwnerStringSchema.optional(),
  opencodeServerBaseUrlExplicit: z.literal(true).optional(),
  auggieAllowIndexing: z.boolean().optional(),
  piSessionFile: OptionalOwnerStringSchema.optional(),
  providerSessionInfoV1: z.object({
    v: z.literal(1),
    provider: z.string().trim().min(1).max(128),
    sessionId: z.string().min(1).max(1_024),
    observedAt: TimestampSchema,
    title: z.string().trim().min(1).max(1_024).nullable().optional(),
    updatedAt: z.string().datetime({ offset: true }).max(64).nullable().optional(),
  }).strict().optional(),
  tag: OptionalOwnerIdentifierSchema.optional(),
  externalSessionV1: SessionOwnerExternalSessionLinkV1Schema.optional(),
  directSessionV1: SessionOwnerDirectSessionLinkV1Schema.optional(),
}).strict();

const SessionOwnerSlashCommandDetailV1Schema = z.object({
  command: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
}).strict();

const SessionOwnerScalarValueV1Schema = z.union([
  z.string().max(20_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const SessionOwnerTerminalV1Schema = z.object({
  mode: z.enum(['plain', 'tmux', 'zellij', 'windows_terminal', 'windows_console']).optional(),
  requested: z.enum([
    'plain',
    'tmux',
    'zellij',
    'hidden',
    'windows_terminal',
    'console',
  ]).optional(),
  fallbackReason: z.string().max(20_000).optional(),
  controlServiceabilityV1: z.object({
    v: z.literal(1),
    attachmentId: z.string().max(2_000).optional(),
    state: z.enum(['servable', 'recoverable_unservable', 'unknown']),
    observedAt: z.number().finite(),
    reason: z.string().max(20_000).optional(),
    retired: z.boolean().optional(),
  }).strict().optional(),
  tmux: z.object({
    target: z.string().max(20_000),
    tmpDir: OptionalOwnerStringSchema.optional(),
  }).strict().optional(),
  windows: z.object({
    host: z.enum(['windows_terminal', 'console']),
    windowId: z.string().max(2_000).optional(),
    pid: z.number().int().optional(),
    title: z.string().max(20_000).optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === undefined && value.controlServiceabilityV1?.retired !== true) {
    context.addIssue({
      code: 'custom',
      path: ['mode'],
      message: 'Mode-less terminal metadata requires a retired attachment',
    });
  }
});

const SessionOwnerModeCatalogItemV1Schema = z.object({
  id: BoundedIdentifierSchema,
  name: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
}).strict();
const SessionOwnerModeCatalogV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  updatedAt: TimestampSchema,
  currentModeId: BoundedIdentifierSchema,
  availableModes: z.array(SessionOwnerModeCatalogItemV1Schema).max(2_048),
}).strict();

const SessionOwnerCatalogValueOptionV1Schema = z.object({
  value: SessionOwnerScalarValueV1Schema,
  name: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
}).strict();
const SessionOwnerModelOptionV1Schema = z.object({
  id: BoundedIdentifierSchema,
  name: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  category: z.string().max(2_000).optional(),
  type: BoundedIdentifierSchema,
  currentValue: SessionOwnerScalarValueV1Schema,
  options: z.array(SessionOwnerCatalogValueOptionV1Schema).max(2_048).optional(),
  // Producer-declared; see AgentModelOptionOverrideRule. These envelopes are strict, so an
  // undeclared field would reject the WHOLE owner metadata rather than drop the rule.
  overridesWhenOn: AgentModelOptionOverrideRuleSchema.optional(),
}).strict();
const SessionOwnerModelCatalogItemV1Schema = z.object({
  id: BoundedIdentifierSchema,
  name: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  extendedContextModelId: BoundedIdentifierSchema.optional(),
  modelOptions: z.array(SessionOwnerModelOptionV1Schema).max(2_048).optional(),
}).strict();
const SessionOwnerModelCatalogV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  updatedAt: TimestampSchema,
  currentModelId: BoundedIdentifierSchema,
  availableModels: z.array(SessionOwnerModelCatalogItemV1Schema).max(2_048),
}).strict();

const SessionOwnerConfigOptionGroupV1Schema = z.object({
  id: BoundedIdentifierSchema,
  name: z.string().trim().min(1).max(2_000),
  options: z.array(SessionOwnerCatalogValueOptionV1Schema).max(2_048),
}).strict();
const SessionOwnerConfigOptionV1Schema = z.object({
  id: BoundedIdentifierSchema,
  name: z.string().trim().min(1).max(2_000),
  description: z.string().max(20_000).optional(),
  category: z.string().max(2_000).optional(),
  type: BoundedIdentifierSchema,
  currentValue: SessionOwnerScalarValueV1Schema,
  options: z.array(SessionOwnerCatalogValueOptionV1Schema).max(2_048).optional(),
  groups: z.array(SessionOwnerConfigOptionGroupV1Schema).max(2_048).optional(),
}).strict();
const SessionOwnerConfigCatalogV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  updatedAt: TimestampSchema,
  configOptions: z.array(SessionOwnerConfigOptionV1Schema).max(2_048),
}).strict();

const SessionOwnerModeOverrideV1Schema = z.object({
  v: z.literal(1),
  updatedAt: z.number().finite(),
  modeId: z.string().max(20_000).nullable(),
}).strict();
const SessionOwnerConfigOverridesV1Schema = z.object({
  v: z.literal(1),
  updatedAt: z.number().finite(),
  overrides: z.record(
    z.string().trim().min(1).max(2_000),
    z.object({
      updatedAt: z.number().finite(),
      value: SessionOwnerScalarValueV1Schema,
    }).strict(),
  ),
}).strict();

const SessionOwnerAgentRuntimeFacetsV1Schema = z.object({
  v: z.literal(1),
  transcriptSource: z.object({
    supported: z.literal(true),
    followLeaseSupported: z.literal(true).optional(),
  }).strict().optional(),
}).strict();

const SessionOwnerCapabilitySupportV1Schema = z.object({
  supported: z.boolean(),
}).strict();
const SessionOwnerAgentRuntimeCapabilitiesV1Schema = z.object({
  executionRun: z.object({
    supported: z.boolean(),
    structuredOutputRecovery: z.object({
      plan: z.enum(['loose-sections', 'none']).optional(),
      delegate: z.enum([
        'loose-deliverables',
        'loose-deliverables-with-single-fallback',
        'none',
      ]).optional(),
    }).strict().optional(),
  }).strict().nullable().optional(),
  backend: z.object({
    executionRun: z.object({
      supported: z.boolean(),
      structuredOutputRecovery: z.object({
        plan: z.enum(['loose-sections', 'none']).optional(),
        delegate: z.enum([
          'loose-deliverables',
          'loose-deliverables-with-single-fallback',
          'none',
        ]).optional(),
      }).strict().optional(),
    }).strict(),
    session: z.object({
      media: z.object({
        acceptsImageInput: SessionOwnerCapabilitySupportV1Schema,
        emitsSessionMedia: z.object({
          supported: z.boolean(),
          mediaKinds: z.array(z.literal('image')).optional(),
          sources: z.array(z.enum([
            'provider-generated',
            'tool-output',
            'acp-content',
            'mcp-content',
          ])).optional(),
          storage: z.literal('session-media-file').optional(),
        }).strict(),
        nativeImageGeneration: z.object({
          supported: z.boolean(),
          mediaKinds: z.array(z.literal('image')).optional(),
          streamingPartials: z.boolean().optional(),
        }).strict(),
      }).strict(),
      contextCompaction: z.object({
        events: z.object({
          supported: z.boolean(),
          phases: z.array(z.enum([
            'started',
            'progress',
            'completed',
            'failed',
            'cancelled',
          ])).optional(),
          tokenCounts: z.boolean().optional(),
          progress: z.boolean().optional(),
        }).strict(),
        manualTrigger: z.object({
          supported: z.boolean(),
          transport: z.enum(['native-runtime-hook', 'raw-provider-command']).optional(),
          acceptsInstructions: z.boolean().optional(),
        }).strict(),
        transcriptInference: SessionOwnerCapabilitySupportV1Schema,
      }).strict(),
    }).strict(),
  }).strict().optional(),
}).strict();

const SessionOwnerRollbackRangesV1Schema = z.object({
  v: z.literal(1),
  updatedAt: z.number().finite(),
  ranges: z.array(z.object({
    target: SessionRollbackTargetSchema,
    startSeqInclusive: z.number().int().nonnegative(),
    endSeqInclusive: z.number().int().nonnegative(),
    rolledBackAt: z.number().finite(),
  }).strict().refine(
    (value) => value.endSeqInclusive >= value.startSeqInclusive,
    { path: ['endSeqInclusive'], message: 'Invalid rollback range' },
  )).max(20_000),
}).strict();

const SessionOwnerMcpSelectionV1Schema = z.object({
  v: z.literal(1),
  managedServersEnabled: z.boolean(),
  forceIncludeServerIds: z.array(BoundedIdentifierSchema).max(2_048),
  forceExcludeServerIds: z.array(BoundedIdentifierSchema).max(2_048),
}).strict();

const SessionOwnerRuntimeV1Schema = z.object({
  externalSessionOperationV1: ExternalSessionOperationStateV1Schema.optional(),
  terminal: SessionOwnerTerminalV1Schema.optional(),
  tools: z.array(z.string().max(2_000)).max(4_096).optional(),
  slashCommands: z.array(z.string().max(2_000)).max(4_096).optional(),
  slashCommandDetails: z.array(SessionOwnerSlashCommandDetailV1Schema).max(4_096).optional(),
  permissionMode: BoundedIdentifierSchema.optional(),
  permissionModeUpdatedAt: TimestampSchema.optional(),
  hostPid: z.number().int().nonnegative().optional(),
  startedFromDaemon: z.boolean().optional(),
  startedBy: z.enum(['daemon', 'terminal']).optional(),
  sessionLogPath: OptionalOwnerStringSchema.optional(),
  lifecycleState: z.string().max(2_000).optional(),
  lifecycleStateSince: TimestampSchema.optional(),
  archivedBy: z.string().max(2_000).optional(),
  archiveReason: z.string().max(20_000).optional(),
  sessionUsageLimitRecoveryV1: SessionUsageLimitRecoveryV1Schema.optional(),
  sessionRunnerRuntimeV1: SessionRunnerRuntimeStateV1Schema.optional(),
  sessionPendingQueueHoldV1: SessionPendingQueueHoldV1Schema.optional(),
  providerBindingV1: SessionProviderBindingMetadataV1Schema.optional(),
  modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.optional(),
  sessionAppliedModelV1: SessionAppliedModelV1Schema.optional(),
  externalAgentObservationV1: ExternalAgentObservationSnapshotV1Schema.optional(),
  acpSessionModesV1: SessionOwnerModeCatalogV1Schema.optional(),
  sessionModesV1: SessionOwnerModeCatalogV1Schema.optional(),
  acpSessionModelsV1: SessionOwnerModelCatalogV1Schema.optional(),
  sessionModelsV1: SessionOwnerModelCatalogV1Schema.optional(),
  acpConfigOptionsV1: SessionOwnerConfigCatalogV1Schema.optional(),
  sessionConfigOptionsV1: SessionOwnerConfigCatalogV1Schema.optional(),
  modelOverrideV1: z.object({
    v: z.literal(1),
    updatedAt: z.number().finite(),
    modelId: z.string().max(20_000).nullable(),
  }).strict().optional(),
  acpSessionModeOverrideV1: SessionOwnerModeOverrideV1Schema.optional(),
  sessionModeOverrideV1: SessionOwnerModeOverrideV1Schema.optional(),
  acpConfigOptionOverridesV1: SessionOwnerConfigOverridesV1Schema.optional(),
  sessionConfigOptionOverridesV1: SessionOwnerConfigOverridesV1Schema.optional(),
  acpConfiguredBackendV1: z.object({
    v: z.literal(1),
    updatedAt: z.number().finite(),
    backendId: BoundedIdentifierSchema,
    title: z.string().trim().min(1).max(2_000),
  }).strict().optional(),
  agentRuntimeCapabilitiesV1: SessionOwnerAgentRuntimeCapabilitiesV1Schema.optional(),
  agentRuntimeFacetsV1: SessionOwnerAgentRuntimeFacetsV1Schema.optional(),
  mcpSelectionV1: SessionOwnerMcpSelectionV1Schema.optional(),
  runtimeActivity: z.union([
    SessionRuntimeActivitySnapshotSchema,
    SessionRuntimeActivityProjectionSchema,
  ]).optional(),
}).strict();

const SessionOwnerConnectedServicesV1Schema = z.object({
  connectedServices: PersistedConnectedServiceBindingsV1Schema.optional(),
  connectedServicesUpdatedAt: TimestampSchema.optional(),
  connectedServiceMaterializationIdentityV1: z.object({
    v: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    createdAt: TimestampSchema,
    source: z.string().trim().min(1).max(64).optional(),
  }).strict().optional(),
  providerAccountUsageRefsV1: ProviderAccountUsageRefsV1Schema.optional(),
  connectedServicePendingAuthGroupGenerationsV1: z.object({
    v: z.literal(1),
    entries: z.array(z.object({
      kind: z.literal('provider_adopted_generation'),
      providerAdoptedTarget: z.object({
        serviceId: ConnectedServiceIdSchema,
        groupId: BoundedIdentifierSchema,
        profileId: BoundedIdentifierSchema,
        generation: z.number().int().nonnegative(),
        credentialRevision: ConnectedServiceCredentialRevisionV1Schema.nullable(),
        proof: z.object({
          status: z.literal('verified'),
          source: BoundedIdentifierSchema,
          providerAccountId: OptionalOwnerIdentifierSchema.optional(),
          activeAccountId: OptionalOwnerIdentifierSchema.optional(),
          sharedAuthSurfaceId: OptionalOwnerIdentifierSchema.optional(),
          credentialRevision: ConnectedServiceCredentialRevisionV1Schema.optional(),
        }).strict().refine(
          (proof) =>
            proof.providerAccountId !== undefined
            || proof.activeAccountId !== undefined
            || proof.sharedAuthSurfaceId !== undefined
            || proof.credentialRevision !== undefined,
          { message: 'Generation proof requires an exact identity' },
        ),
      }).strict(),
      proofStrength: z.literal('exact'),
      updatedAtMs: TimestampSchema,
    }).strict()).max(20_000),
  }).strict().optional(),
  claudeSubscriptionAccessTokenRefreshV1: z.object({
    v: z.literal(1),
    mode: z.enum(['daemon_callback', 'unavailable']),
  }).strict().optional(),
  connectedServiceAccessTokenRefreshV1: z.object({
    v: z.literal(1),
    mode: z.enum(['daemon_callback', 'unavailable']),
    serviceIds: z.array(ConnectedServiceIdSchema).max(64),
  }).strict().optional(),
}).strict();

const SessionOwnerExternalHistoryImportV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  importedAtMs: TimestampSchema,
  source: SessionOwnerExternalSourceV1Schema,
  linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
}).strict();

const SessionOwnerHistoryV1Schema = z.object({
  externalHistoryImportV1: SessionOwnerExternalHistoryImportV1Schema.optional(),
  acpHistoryImportV1: z.object({
    v: z.literal(1),
    agentId: BoundedIdentifierSchema,
    remoteSessionId: z.string().trim().min(1).max(20_000),
    importedAt: TimestampSchema,
    lastImportedFingerprint: z.string().max(20_000).optional(),
  }).strict().optional(),
  sessionRollbackRangesV1: SessionOwnerRollbackRangesV1Schema.optional(),
  forkV1: z.object({
    v: z.literal(1),
    parentSessionId: BoundedIdentifierSchema,
    parentCutoffSeqInclusive: z.number().int().nonnegative(),
    createdAtMs: TimestampSchema,
    strategy: z.string().trim().min(1).max(256),
    agentHint: z.object({
      agentId: BoundedIdentifierSchema.optional(),
      backendMode: BoundedIdentifierSchema.optional(),
      agentSessionId: OptionalOwnerIdentifierSchema.optional(),
    }).strict().optional(),
  }).strict().optional(),
  replaySeedV1: z.object({
    v: z.literal(1),
    seedText: z.string().max(1_000_000),
    sourceSessionId: BoundedIdentifierSchema,
    sourceCutoffSeqInclusive: z.number().int().nonnegative(),
    createdAtMs: TimestampSchema,
    appliedToLocalId: OptionalOwnerIdentifierSchema.optional(),
    appliedAtMs: TimestampSchema.optional(),
  }).strict().optional(),
  forkInitialPromptV1: z.object({
    v: z.literal(1),
    text: z.string().max(1_000_000),
    createdAtMs: TimestampSchema,
    sourceMessageId: OptionalOwnerIdentifierSchema.optional(),
    appliedAtMs: TimestampSchema.optional(),
  }).strict().optional(),
  sessionInitialPromptV1: z.object({
    v: z.literal(1),
    text: z.string().max(1_000_000),
    mode: z.enum(['replace', 'append']),
    createdAtMs: TimestampSchema,
    sourceMessageIds: z.array(BoundedIdentifierSchema).max(20_000).optional(),
    sourceSessionId: OptionalOwnerIdentifierSchema.optional(),
  }).strict().optional(),
  sessionMediaContinuityV1: z.object({
    v: z.literal(1),
    sourceSessionId: BoundedIdentifierSchema,
    sourceCutoffSeqInclusive: z.number().int().nonnegative(),
    referencedWorkspacePaths: z.array(z.string().max(100_000)).max(20_000),
  }).strict().optional(),
}).strict();

const SessionOwnerWorkStateItemV1Schema = z.object({
  id: BoundedIdentifierSchema,
  kind: z.enum(['goal', 'task', 'todo']),
  origin: z.enum(['vendor', 'happier', 'derived']),
  status: z.enum(['pending', 'active', 'paused', 'blocked', 'complete', 'cancelled', 'unknown']),
  title: z.string().trim().min(1).max(4_000),
  summary: z.string().trim().max(8_000).optional(),
  backendId: BoundedIdentifierSchema.optional(),
  agentId: BoundedIdentifierSchema.optional(),
  vendorRef: BoundedIdentifierSchema.optional(),
  order: z.number().int().nonnegative().optional(),
  parentId: BoundedIdentifierSchema.optional(),
  priority: z.string().max(256).optional(),
  progress: z.number().finite().min(0).max(1).optional(),
  statusReason: z.enum(['blocked', 'usageLimited', 'budgetLimited', 'interrupted']).optional(),
  goalCapabilities: z.object({
    canEdit: z.boolean().optional(),
    canStop: z.boolean().optional(),
    canClear: z.boolean().optional(),
  }).strict().optional(),
  tokenBudget: z.number().finite().positive().nullable().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  timeUsedSeconds: z.number().finite().nonnegative().optional(),
  createdAt: TimestampSchema.optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();

const SessionOwnerWorkStateV1Schema = z.object({
  v: z.literal(1),
  backendId: BoundedIdentifierSchema,
  agentId: BoundedIdentifierSchema.optional(),
  updatedAt: TimestampSchema,
  items: z.array(SessionOwnerWorkStateItemV1Schema).max(20_000),
  primaryItemId: OptionalOwnerIdentifierSchema.optional(),
  truncated: z.object({
    reason: z.enum(['item_limit', 'provider_limit']),
    omittedCount: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

const SessionOwnerWorkflowRunHeadlineV1Schema = z.object({
  runId: BoundedIdentifierSchema,
  title: z.string().trim().min(1).max(4_000),
  status: z.enum(['active', 'complete', 'failed', 'stopped', 'blocked', 'cancelled', 'unknown']),
  statusReason: z.literal('interrupted').optional(),
  workflowToolUseId: BoundedIdentifierSchema.optional(),
  updatedAt: TimestampSchema,
  recordRevision: z.string().trim().regex(/^\d+$/),
  recordUpdatedAt: TimestampSchema,
  totalAgents: z.number().int().nonnegative(),
  completedAgents: z.number().int().nonnegative(),
  failedAgents: z.number().int().nonnegative().optional(),
  blockedAgents: z.number().int().nonnegative().optional(),
}).strict();

const SessionOwnerWorkV1Schema = z.object({
  sessionWorkStateV1: SessionOwnerWorkStateV1Schema.optional(),
  sessionWorkflowActivityHeadlineV1: z.object({
    v: z.literal(1),
    backendId: BoundedIdentifierSchema,
    agentId: BoundedIdentifierSchema.optional(),
    updatedAt: TimestampSchema,
    primaryRunId: OptionalOwnerIdentifierSchema.optional(),
    activeRuns: z.array(SessionOwnerWorkflowRunHeadlineV1Schema).max(20_000),
    recentRuns: z.array(SessionOwnerWorkflowRunHeadlineV1Schema).max(20_000).optional(),
    truncated: z.object({
      reason: z.literal('run_limit'),
      omittedCount: z.number().int().nonnegative(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const SessionOwnerBackendTargetV1Schema = z.union([
  z.object({
    kind: z.literal('builtInAgent'),
    agentId: BoundedIdentifierSchema,
  }).strict(),
  z.object({
    kind: z.literal('configuredAcpBackend'),
    backendId: BoundedIdentifierSchema,
  }).strict(),
]);
const SessionOwnerBackendTargetV2Schema = z.object({
  kind: z.literal('backend'),
  backendId: BoundedIdentifierSchema,
  configuredBackendId: BoundedIdentifierSchema.optional(),
  sourceKind: z.enum(['built_in', 'configured']).optional(),
}).strict();
const SessionOwnerResumeHandleV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider_session.v1'),
    backendTarget: SessionOwnerBackendTargetV2Schema,
    providerSessionId: z.string().trim().min(1).max(20_000),
  }).strict(),
  z.object({
    kind: z.literal('voice_agent_sessions.v1'),
    backendTarget: SessionOwnerBackendTargetV2Schema,
    chatProviderSessionId: z.string().trim().min(1).max(20_000),
    commitProviderSessionId: z.string().trim().min(1).max(20_000),
  }).strict(),
]);

const SessionOwnerSystemV1Schema = z.object({
  systemSessionV1: z.object({
    v: z.literal(1),
    key: z.string().trim().min(1).max(2_000),
    hidden: z.boolean().optional(),
  }).strict().optional(),
  voiceAgentRunV1: z.object({
    v: z.literal(1),
    runId: BoundedIdentifierSchema,
    backendId: BoundedIdentifierSchema,
    backendTarget: SessionOwnerBackendTargetV1Schema.optional(),
    resumeHandle: SessionOwnerResumeHandleV1Schema.nullable(),
    updatedAtMs: TimestampSchema,
    transcriptContractVersion: z.number().int().nonnegative(),
    welcomedEpoch: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  voiceConversationScopeV1: z.discriminatedUnion('kind', [
    z.object({ v: z.literal(1), kind: z.literal('voice_home') }).strict(),
    z.object({
      v: z.literal(1),
      kind: z.literal('session_root'),
      sessionRootId: BoundedIdentifierSchema,
    }).strict(),
  ]).optional(),
  voiceConversationBindingV1: z.object({
    v: z.literal(1),
    adapterId: BoundedIdentifierSchema,
    controlSessionId: BoundedIdentifierSchema,
    transcriptMode: z.enum(['native_session', 'synthetic']),
    targetSessionId: OptionalOwnerIdentifierSchema,
    updatedAt: z.number().finite(),
  }).strict().optional(),
  voiceAgentStartupInstructionsV1:
    AgentSessionStartupInstructionsMarkerV1Schema.optional(),
}).strict();

const SessionOwnerHandoffV1Schema = z.object({
  handoffV1: z.object({
    v: z.literal(1),
    sourceMachineId: BoundedIdentifierSchema,
    targetMachineId: BoundedIdentifierSchema,
    agentId: BoundedIdentifierSchema,
    sessionStorageBefore: z.enum(['direct', 'persisted']),
    sessionStorageAfter: z.enum(['direct', 'persisted']),
    transportStrategy: z.enum(['direct_peer', 'server_routed_stream']),
    completedAtMs: TimestampSchema,
    sourceWorkspaceRootPath: OptionalOwnerStringSchema.optional(),
    targetWorkspaceRootPath: OptionalOwnerStringSchema.optional(),
  }).strict().optional(),
  acpTransportV1: z.object({
    v: z.literal(1),
    agentId: BoundedIdentifierSchema,
  }).strict().optional(),
}).strict();

const SessionOwnerCursorsV1Schema = z.object({
  externalSessionAttentionV1: z.object({
    v: z.literal(1),
    observedProgressToken: z.string().max(20_000).optional(),
    viewedProgressToken: z.string().max(20_000).optional(),
    observedAtMs: TimestampSchema.optional(),
    viewedAtMs: TimestampSchema.optional(),
  }).strict().optional(),
  readStateV1: z.object({
    v: z.literal(1),
    sessionSeq: z.number().int().nonnegative(),
    pendingActivityAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }).strict().optional(),
  discardedCommittedMessageLocalIds: z.array(z.string().max(2_000)).max(20_000).optional(),
  locallyConsumedUserMessageSeqsV1: z.array(z.number().int().nonnegative()).max(20_000).optional(),
}).strict();

/**
 * Strict plaintext inside the account/domain encrypted owner ciphertext.
 * Categories are deliberately disjoint; there is no raw metadata carrier.
 */
export const SessionOwnerMetadataV1Schema = z.object({
  v: z.literal(SESSION_OWNER_METADATA_VERSION_V1),
  workspace: SessionOwnerWorkspaceV1Schema.optional(),
  nativeSession: SessionOwnerNativeSessionV1Schema.optional(),
  runtime: SessionOwnerRuntimeV1Schema.optional(),
  connectedServices: SessionOwnerConnectedServicesV1Schema.optional(),
  history: SessionOwnerHistoryV1Schema.optional(),
  handoff: SessionOwnerHandoffV1Schema.optional(),
  cursors: SessionOwnerCursorsV1Schema.optional(),
  work: SessionOwnerWorkV1Schema.optional(),
  system: SessionOwnerSystemV1Schema.optional(),
}).strict();
export type SessionOwnerMetadataV1 = z.infer<
  typeof SessionOwnerMetadataV1Schema
>;

const {
  runtimeActivity: _sessionOwnerRuntimeActivity,
  ...SessionOwnerCompatibilityRuntimeShapeV1
} = SessionOwnerRuntimeV1Schema.shape;

const SessionOwnerCompatibilityRuntimeDescriptorV1Schema = z.object({
  v: z.literal(1),
  agentId: BoundedIdentifierSchema,
  agent: z.object({
    backendMode: BoundedIdentifierSchema.nullable().optional(),
    providerSessionId: OptionalOwnerIdentifierSchema.optional(),
    backendId: OptionalOwnerIdentifierSchema.optional(),
    provenance: OptionalOwnerIdentifierSchema.optional(),
    home: z.enum(['user', 'connectedService']).nullable().optional(),
    connectedServiceId: OptionalOwnerIdentifierSchema.optional(),
    connectedServiceProfileId: OptionalOwnerIdentifierSchema.optional(),
    connectedServiceGroupId: OptionalOwnerIdentifierSchema.optional(),
    homePath: OptionalOwnerStringSchema.optional(),
    serverBaseUrl: OptionalOwnerStringSchema.optional(),
    serverBaseUrlExplicit: z.boolean().optional(),
    resumeStrategy: z.enum([
      'sessionFileBySessionId',
      'sessionFileAbsolutePreferred',
    ]).nullable().optional(),
    sessionFile: OptionalOwnerStringSchema.optional(),
  }).strict(),
}).strict();

/**
 * Local-only compatibility metadata consumed by current owner workflows.
 * This schema is intentionally separate from both encrypted envelope schemas:
 * its flattened shape must never be serialized back as shared metadata.
 */
export const SessionOwnerCompatibilityViewV1Schema = z.object({
  summary: SessionSharedSummaryV1Schema.optional(),
  agentPresentation: SessionSharedAgentPresentationV1Schema.optional(),
  externalSessionOperationPresentationV1:
    ExternalSessionOperationSharedPresentationV1Schema.optional(),
  ...SessionOwnerWorkspaceV1Schema.shape,
  path: z.string().max(100_000),
  host: z.string().max(100_000),
  homeDir: z.string().max(100_000),
  happyHomeDir: z.string().max(100_000),
  happyLibDir: z.string().max(100_000),
  happyToolsDir: z.string().max(100_000),
  ...SessionOwnerNativeSessionV1Schema.shape,
  runtimeDescriptorV1:
    SessionOwnerCompatibilityRuntimeDescriptorV1Schema.optional(),
  ...SessionOwnerCompatibilityRuntimeShapeV1,
  runtimeActivityState:
    SessionRuntimeActivityProjectionSchema.shape.state.optional(),
  runtimeActivityActiveCount:
    SessionRuntimeActivityProjectionSchema.shape.activeCount.optional(),
  runtimeActivityObservedAt:
    SessionRuntimeActivityProjectionSchema.shape.observedAt.optional(),
  runtimeActivityRevision:
    SessionRuntimeActivityProjectionSchema.shape.revision.optional(),
  ...SessionOwnerConnectedServicesV1Schema.shape,
  ...SessionOwnerHistoryV1Schema.shape,
  ...SessionOwnerHandoffV1Schema.shape,
  ...SessionOwnerCursorsV1Schema.shape,
  ...SessionOwnerWorkV1Schema.shape,
  ...SessionOwnerSystemV1Schema.shape,
}).strict();
export type SessionOwnerCompatibilityViewV1 = z.infer<
  typeof SessionOwnerCompatibilityViewV1Schema
>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function readRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function projectSummary(metadata: UnknownRecord): SessionSharedSummaryV1 | null {
  const parsed = SessionSharedSummaryV1Schema.safeParse(metadata.summary);
  return parsed.success ? parsed.data : null;
}

function projectAgentPresentation(
  metadata: UnknownRecord,
): SessionSharedAgentPresentationV1 | null {
  const explicit = SessionSharedAgentPresentationV1Schema.safeParse(
    metadata.agentPresentation,
  );
  if (explicit.success) return explicit.data;

  const runtimeDescriptor = readRecord(metadata.runtimeDescriptorV1);
  const legacyRuntimeDescriptor = readRecord(metadata.agentRuntimeDescriptorV1);
  const externalSession = readRecord(metadata.externalSessionV1);
  const directSession = readRecord(metadata.directSessionV1);
  const parsed = SessionSharedAgentPresentationV1Schema.safeParse({
    agentId:
      runtimeDescriptor?.agentId
      ?? legacyRuntimeDescriptor?.agentId
      ?? legacyRuntimeDescriptor?.providerId
      ?? externalSession?.agentId
      ?? directSession?.providerId
      ?? resolveGeneratedSessionPresentationAgentIdV1(metadata),
  });
  return parsed.success ? parsed.data : null;
}

function projectOperationPresentation(metadata: UnknownRecord) {
  const ownerState = ExternalSessionOperationStateV1Schema.safeParse(
    metadata[EXTERNAL_SESSION_OPERATION_METADATA_KEY],
  );
  if (ownerState.success) {
    return projectExternalSessionOperationSharedPresentationV1(
      ownerState.data.progress,
    );
  }
  const presentation =
    ExternalSessionOperationSharedPresentationV1Schema.safeParse(
      metadata[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
    );
  return presentation.success ? presentation.data : null;
}

function projectPublicAgentState(
  agentStateInput: unknown,
): SessionPublicAgentStateV1 | null {
  const agentState = readRecord(agentStateInput);
  const completedRequests = readRecord(agentState?.completedRequests);
  if (!completedRequests) return null;

  const projectedEntries: Array<[string, SessionPublicCompletedRequestV1]> = [];
  for (const [requestId, requestInput] of Object.entries(completedRequests)) {
    if (projectedEntries.length >= MAX_PUBLIC_COMPLETED_REQUESTS_V1) break;
    const request = readRecord(requestInput);
    if (!request) continue;
    const parsed = SessionPublicCompletedRequestV1Schema.safeParse({
      tool: request.tool,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      createdAt: request.createdAt,
      completedAt: request.completedAt,
      status: request.status,
    });
    if (!parsed.success || requestId.trim().length === 0 || requestId.length > 512) {
      continue;
    }
    projectedEntries.push([requestId, parsed.data]);
  }
  if (projectedEntries.length === 0) return null;
  return SessionPublicAgentStateV1Schema.parse({
    completedRequests: Object.fromEntries(projectedEntries),
  });
}

/**
 * The sole legacy/current input projector into the recipient-safe envelope.
 * Unknown, malformed, and owner-authority facts are dropped by construction.
 */
export function projectSessionSharedMetadataV1(params: Readonly<{
  metadata: unknown;
  agentState?: unknown;
}>): SessionSharedMetadataV1 {
  const metadata = readRecord(params.metadata) ?? {};
  const summary = projectSummary(metadata);
  const agentPresentation = projectAgentPresentation(metadata);
  const externalSessionOperationPresentationV1 =
    projectOperationPresentation(metadata);
  const publicAgentState = projectPublicAgentState(params.agentState);

  return SessionSharedMetadataV1Schema.parse({
    v: SESSION_SHARED_METADATA_VERSION_V1,
    ...(summary ? { summary } : {}),
    ...(agentPresentation ? { agentPresentation } : {}),
    ...(externalSessionOperationPresentationV1
      ? { externalSessionOperationPresentationV1 }
      : {}),
    ...(publicAgentState ? { publicAgentState } : {}),
  });
}

/**
 * Strict, pure owner-only adapter into the current flattened metadata model.
 * The public Agent-state projection is deliberately excluded because it is
 * not legacy Session metadata and the owner already reads full Agent state.
 */
export function projectSessionOwnerCompatibilityViewV1(
  params: Readonly<{
    sharedMetadata: unknown;
    ownerMetadata: unknown;
  }>,
): SessionOwnerCompatibilityViewV1 {
  const sharedMetadata = SessionSharedMetadataV1Schema.parse(
    params.sharedMetadata,
  );
  const ownerMetadata = SessionOwnerMetadataV1Schema.parse(
    params.ownerMetadata,
  );
  const descriptor = ownerMetadata.nativeSession?.runtimeDescriptorV1;
  const runtimeDescriptorV1 = descriptor
    ? {
        v: descriptor.v,
        agentId: descriptor.agentId,
        agent: {
          ...(descriptor.backendMode !== undefined
            ? { backendMode: descriptor.backendMode }
            : {}),
          ...(descriptor.providerSessionId !== undefined
            ? { providerSessionId: descriptor.providerSessionId }
            : {}),
          ...(descriptor.backendId !== undefined
            ? { backendId: descriptor.backendId }
            : {}),
          ...(descriptor.provenance !== undefined
            ? { provenance: descriptor.provenance }
            : {}),
          ...(descriptor.home !== undefined ? { home: descriptor.home } : {}),
          ...(descriptor.connectedServiceId !== undefined
            ? { connectedServiceId: descriptor.connectedServiceId }
            : {}),
          ...(descriptor.connectedServiceProfileId !== undefined
            ? {
                connectedServiceProfileId:
                  descriptor.connectedServiceProfileId,
              }
            : {}),
          ...(descriptor.connectedServiceGroupId !== undefined
            ? { connectedServiceGroupId: descriptor.connectedServiceGroupId }
            : {}),
          ...(descriptor.homePath !== undefined
            ? { homePath: descriptor.homePath }
            : {}),
          ...(descriptor.serverBaseUrl !== undefined
            ? { serverBaseUrl: descriptor.serverBaseUrl }
            : {}),
          ...(descriptor.serverBaseUrlExplicit !== undefined
            ? { serverBaseUrlExplicit: descriptor.serverBaseUrlExplicit }
            : {}),
          ...(descriptor.resumeStrategy !== undefined
            ? { resumeStrategy: descriptor.resumeStrategy }
            : {}),
          ...(descriptor.sessionFile !== undefined
            ? { sessionFile: descriptor.sessionFile }
            : {}),
        },
      }
    : undefined;
  const {
    runtimeDescriptorV1: _ownerRuntimeDescriptorV1,
    ...nativeSession
  } = ownerMetadata.nativeSession ?? {};
  const {
    runtimeActivity,
    ...runtime
  } = ownerMetadata.runtime ?? {};

  return SessionOwnerCompatibilityViewV1Schema.parse({
    ...(sharedMetadata.summary
      ? { summary: sharedMetadata.summary }
      : {}),
    ...(sharedMetadata.agentPresentation
      ? { agentPresentation: sharedMetadata.agentPresentation }
      : {}),
    ...(sharedMetadata.externalSessionOperationPresentationV1
      ? {
          externalSessionOperationPresentationV1:
            sharedMetadata.externalSessionOperationPresentationV1,
        }
      : {}),
    ...(ownerMetadata.workspace ?? {}),
    path: ownerMetadata.workspace?.path ?? '',
    host: ownerMetadata.workspace?.host ?? '',
    homeDir: ownerMetadata.workspace?.homeDir ?? '',
    happyHomeDir: ownerMetadata.workspace?.happyHomeDir ?? '',
    happyLibDir: ownerMetadata.workspace?.happyLibDir ?? '',
    happyToolsDir: ownerMetadata.workspace?.happyToolsDir ?? '',
    ...nativeSession,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...runtime,
    ...(runtimeActivity
      ? {
          runtimeActivityState: runtimeActivity.state,
          runtimeActivityActiveCount: runtimeActivity.activeCount,
          ...('observedAt' in runtimeActivity
            ? { runtimeActivityObservedAt: runtimeActivity.observedAt }
            : {}),
          ...('revision' in runtimeActivity
            ? { runtimeActivityRevision: runtimeActivity.revision }
            : {}),
        }
      : {}),
    ...(ownerMetadata.connectedServices ?? {}),
    ...(ownerMetadata.history ?? {}),
    ...(ownerMetadata.handoff ?? {}),
    ...(ownerMetadata.cursors ?? {}),
    ...(ownerMetadata.work ?? {}),
    ...(ownerMetadata.system ?? {}),
  });
}

const SHARED_ONLY_METADATA_KEYS = new Set([
  'summary',
  'agentPresentation',
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
]);
const WORKSPACE_OWNER_KEYS = [
  'path',
  'host',
  'version',
  'name',
  'os',
  'machineId',
  'profileId',
  'homeDir',
  'happyHomeDir',
  'happyLibDir',
  'happyToolsDir',
  'flavor',
  'projectId',
  'workspaceId',
  'workspaceLocationId',
  'workspaceCheckoutId',
] as const;
const NATIVE_SESSION_SCALAR_OWNER_KEYS = [
  'claudeSessionId',
  'codexSessionId',
  'geminiSessionId',
  'grokSessionId',
  'opencodeSessionId',
  'auggieSessionId',
  'qwenSessionId',
  'kimiSessionId',
  'kiloSessionId',
  'kiroSessionId',
  'ohMyPiSessionId',
  'piSessionId',
  'copilotSessionId',
  'cursorSessionId',
  'antigravitySessionId',
  'claudeTranscriptPath',
  'claudeLastCheckpointId',
  'claudeLastAssistantUuid',
  'codexBackendMode',
  'opencodeBackendMode',
  'opencodeServerBaseUrl',
  'opencodeServerBaseUrlExplicit',
  'auggieAllowIndexing',
  'tag',
  'piSessionFile',
  'providerSessionInfoV1',
] as const;
const RUNTIME_OWNER_KEYS = [
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  'terminal',
  'tools',
  'slashCommands',
  'slashCommandDetails',
  'permissionMode',
  'permissionModeUpdatedAt',
  'hostPid',
  'startedFromDaemon',
  'startedBy',
  'sessionLogPath',
  'lifecycleState',
  'lifecycleStateSince',
  'archivedBy',
  'archiveReason',
  'sessionUsageLimitRecoveryV1',
  'sessionRunnerRuntimeV1',
  'sessionPendingQueueHoldV1',
  'providerBindingV1',
  'modelSelectionIntentV1',
  'sessionAppliedModelV1',
  'externalAgentObservationV1',
  'runtimeActivityState',
  'runtimeActivityActiveCount',
  'runtimeActivityObservedAt',
  'runtimeActivityRevision',
  'acpSessionModesV1',
  'sessionModesV1',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
  'modelOverrideV1',
  'acpSessionModeOverrideV1',
  'sessionModeOverrideV1',
  'acpConfigOptionOverridesV1',
  'sessionConfigOptionOverridesV1',
  'acpConfiguredBackendV1',
  'agentRuntimeCapabilitiesV1',
  'agentRuntimeFacetsV1',
  'mcpSelectionV1',
] as const;
const CONNECTED_SERVICE_OWNER_KEYS = [
  'connectedServices',
  'connectedServicesUpdatedAt',
  'connectedServiceMaterializationIdentityV1',
  'providerAccountUsageRefsV1',
  'connectedServicePendingAuthGroupGenerationsV1',
  'claudeSubscriptionAccessTokenRefreshV1',
  'connectedServiceAccessTokenRefreshV1',
] as const;
const HISTORY_OWNER_KEYS = [
  'externalHistoryImportV1',
  'acpHistoryImportV1',
  'sessionRollbackRangesV1',
  'forkV1',
  'replaySeedV1',
  'forkInitialPromptV1',
  'sessionInitialPromptV1',
  'sessionMediaContinuityV1',
] as const;
const WORK_OWNER_KEYS = [
  'sessionWorkStateV1',
  'sessionWorkflowActivityHeadlineV1',
  'sessionGoalV1',
  'codexGoalV1',
] as const;
const SYSTEM_OWNER_KEYS = [
  'systemSessionV1',
  'hiddenSystemSession',
  'voiceAgentRunV1',
  'voiceConversationScopeV1',
  'voiceConversationBindingV1',
  'voiceAgentStartupInstructionsV1',
] as const;
const HANDOFF_OWNER_KEYS = ['handoffV1', 'acpTransportV1'] as const;
const CURSOR_OWNER_KEYS = [
  'externalSessionAttentionV1',
  'readStateV1',
  'discardedCommittedMessageLocalIds',
  'locallyConsumedUserMessageSeqsV1',
] as const;

const REMOVAL_ONLY_OWNER_KEYS = new Set([
  'runtimeActivitySourceClass',
]);

function copyPresentKeys(
  source: UnknownRecord,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
}

function hasOnlyKeys(record: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function normalizeOwnerRuntimeDescriptorV1(
  input: unknown,
): SessionOwnerRuntimeDescriptorV1 | null {
  const descriptor = readRecord(input);
  if (!descriptor || descriptor.v !== 1) return null;
  const canonicalAgentId = typeof descriptor.agentId === 'string'
    ? descriptor.agentId.trim()
    : '';
  const legacyAgentId = typeof descriptor.providerId === 'string'
    ? descriptor.providerId.trim()
    : '';
  if (canonicalAgentId && legacyAgentId && canonicalAgentId !== legacyAgentId) {
    return null;
  }
  const agentId = canonicalAgentId || legacyAgentId;
  if (!agentId) return null;

  const outerKeys = new Set(['v', 'agentId', 'providerId', 'agent', 'provider']);
  const agent = readRecord(descriptor.agent) ?? readRecord(descriptor.provider);
  const parsedHostEnvelopeAgent =
    GenericHostSessionRuntimeDescriptorEnvelopeAgentV1Schema.safeParse(agent);
  if (parsedHostEnvelopeAgent.success) {
    if (!hasOnlyKeys(descriptor, outerKeys)) return null;
    const runtimeHandle =
      parsedHostEnvelopeAgent.data.agentExtra.runtimeHandle;
    if (runtimeHandle.agentId !== agentId) return null;
    const parsedHost = SessionOwnerRuntimeDescriptorV1Schema.safeParse({
      v: 1,
      agentId,
      backendMode: parsedHostEnvelopeAgent.data.backendMode,
      providerSessionId: parsedHostEnvelopeAgent.data.providerSessionId,
      backendId: runtimeHandle.backendId,
      provenance: runtimeHandle.provenance,
    });
    return parsedHost.success ? parsedHost.data : null;
  }

  const contribution = getGeneratedRuntimeDescriptorContributionV1(agentId);
  if (contribution) {
    // The generated contribution owns both deployed alias compatibility and
    // strict unknown-field rejection. This envelope only narrows its canonical
    // output into the encrypted owner schema.
    const canonical = readRecord(
      contribution.readStrictCanonicalDescriptor(input),
    );
    if (!canonical) return null;
    const presentCanonical = Object.fromEntries(
      Object.entries(canonical).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );
    const parsed = SessionOwnerRuntimeDescriptorV1Schema.safeParse({
      v: 1,
      ...presentCanonical,
    });
    return parsed.success ? parsed.data : null;
  }

  if (!hasOnlyKeys(descriptor, outerKeys)) return null;
  if (!agent) return null;
  if (agent.agentExtra !== undefined) {
    const parsedEnvelopeAgent =
      GenericPluginRuntimeDescriptorEnvelopeAgentV1Schema.safeParse(agent);
    if (!parsedEnvelopeAgent.success) return null;
    const runtimeHandle =
      parsedEnvelopeAgent.data.agentExtra.runtimeHandle;
    if (runtimeHandle.agentId !== agentId) return null;
    const parsedGeneric = SessionOwnerRuntimeDescriptorV1Schema.safeParse({
      v: 1,
      agentId,
      backendMode: parsedEnvelopeAgent.data.backendMode,
      providerSessionId: parsedEnvelopeAgent.data.providerSessionId,
      backendId: runtimeHandle.backendId,
      provenance: runtimeHandle.provenance,
    });
    return parsedGeneric.success ? parsedGeneric.data : null;
  }

  const parsedProjectedAgent =
    GenericPluginProjectedRuntimeDescriptorAgentV1Schema.safeParse(agent);
  if (!parsedProjectedAgent.success) return null;
  const parsedProjected = SessionOwnerRuntimeDescriptorV1Schema.safeParse({
    v: 1,
    agentId,
    ...parsedProjectedAgent.data,
  });
  return parsedProjected.success ? parsedProjected.data : null;
}

function normalizeExternalSessionLink(
  input: unknown,
): z.infer<typeof SessionOwnerExternalSessionLinkV1Schema> | null {
  const record = readRecord(input);
  if (!record) return null;
  const runtimeDescriptorV1 = record.runtimeDescriptorV1 === undefined
    ? undefined
    : normalizeOwnerRuntimeDescriptorV1(record.runtimeDescriptorV1);
  if (record.runtimeDescriptorV1 !== undefined && !runtimeDescriptorV1) return null;
  const parsed = SessionOwnerExternalSessionLinkV1Schema.safeParse({
    ...record,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeDirectSessionLink(
  input: unknown,
): z.infer<typeof SessionOwnerDirectSessionLinkV1Schema> | null {
  const record = readRecord(input);
  if (!record) return null;
  const agentRuntimeDescriptorV1 = record.agentRuntimeDescriptorV1 === undefined
    ? undefined
    : normalizeOwnerRuntimeDescriptorV1(record.agentRuntimeDescriptorV1);
  if (record.agentRuntimeDescriptorV1 !== undefined && !agentRuntimeDescriptorV1) return null;
  const parsed = SessionOwnerDirectSessionLinkV1Schema.safeParse({
    ...record,
    ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeAgentVocabularyRecord(
  input: unknown,
  legacyKey: 'providerId' | 'provider',
): Record<string, unknown> | null {
  const record = readRecord(input);
  if (!record) return null;
  const canonicalAgentId = typeof record.agentId === 'string'
    ? record.agentId.trim()
    : '';
  const legacyAgentId = typeof record[legacyKey] === 'string'
    ? String(record[legacyKey]).trim()
    : '';
  if (
    (!canonicalAgentId && !legacyAgentId)
    || (canonicalAgentId && legacyAgentId && canonicalAgentId !== legacyAgentId)
  ) {
    return null;
  }
  const { [legacyKey]: _legacyAgentId, ...rest } = record;
  return {
    ...rest,
    agentId: canonicalAgentId || legacyAgentId,
  };
}

const SESSION_CATALOG_METADATA_KEYS = [
  'acpSessionModesV1',
  'sessionModesV1',
  'acpSessionModelsV1',
  'sessionModelsV1',
  'acpConfigOptionsV1',
  'sessionConfigOptionsV1',
] as const;

export type CreateSessionOwnerMetadataV1Result =
  | Readonly<{ ok: true; ownerMetadata: SessionOwnerMetadataV1 }>
  | Readonly<{
      ok: false;
      error: 'unsupported_owner_metadata';
      unsupportedFields: readonly string[];
    }>;

export function createSessionOwnerMetadataV1(params: Readonly<{
  metadata: unknown;
}>): CreateSessionOwnerMetadataV1Result {
  const metadata = readRecord(params.metadata);
  if (!metadata) {
    return {
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: ['$'],
    };
  }

  const supportedKeys = new Set<string>([
    ...SHARED_ONLY_METADATA_KEYS,
    ...WORKSPACE_OWNER_KEYS,
    ...NATIVE_SESSION_SCALAR_OWNER_KEYS,
    ...RUNTIME_OWNER_KEYS,
    ...CONNECTED_SERVICE_OWNER_KEYS,
    ...HISTORY_OWNER_KEYS,
    ...HANDOFF_OWNER_KEYS,
    ...CURSOR_OWNER_KEYS,
    ...WORK_OWNER_KEYS,
    ...SYSTEM_OWNER_KEYS,
    ...REMOVAL_ONLY_OWNER_KEYS,
    'runtimeDescriptorV1',
    'agentRuntimeDescriptorV1',
    'externalSessionV1',
    'directSessionV1',
    'directSessionAttentionV1',
  ]);
  const unsupportedFields = Object.keys(metadata)
    .filter((key) => !supportedKeys.has(key));

  const runtimeDescriptorInput = metadata.runtimeDescriptorV1
    ?? metadata.agentRuntimeDescriptorV1;
  const runtimeDescriptorV1 = runtimeDescriptorInput === undefined
    ? undefined
    : normalizeOwnerRuntimeDescriptorV1(runtimeDescriptorInput);
  if (runtimeDescriptorInput !== undefined && !runtimeDescriptorV1) {
    unsupportedFields.push(
      metadata.runtimeDescriptorV1 !== undefined
        ? 'runtimeDescriptorV1'
        : 'agentRuntimeDescriptorV1',
    );
  }
  const externalSessionV1 = metadata.externalSessionV1 === undefined
    ? undefined
    : normalizeExternalSessionLink(metadata.externalSessionV1);
  if (metadata.externalSessionV1 !== undefined && !externalSessionV1) {
    unsupportedFields.push('externalSessionV1');
  }
  const directSessionV1 = metadata.directSessionV1 === undefined
    ? undefined
    : normalizeDirectSessionLink(metadata.directSessionV1);
  if (metadata.directSessionV1 !== undefined && !directSessionV1) {
    unsupportedFields.push('directSessionV1');
  }

  const workspaceInput = copyPresentKeys(metadata, WORKSPACE_OWNER_KEYS);
  const nativeSessionInput = {
    ...copyPresentKeys(metadata, NATIVE_SESSION_SCALAR_OWNER_KEYS),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    ...(externalSessionV1 ? { externalSessionV1 } : {}),
    ...(directSessionV1 ? { directSessionV1 } : {}),
  };
  const runtimeInput = copyPresentKeys(metadata, RUNTIME_OWNER_KEYS);
  for (const key of SESSION_CATALOG_METADATA_KEYS) {
    if (metadata[key] === undefined) continue;
    const normalized = normalizeAgentVocabularyRecord(
      metadata[key],
      'provider',
    );
    if (normalized) runtimeInput[key] = normalized;
    else unsupportedFields.push(key);
  }
  const runtimeActivityFields = [
    'runtimeActivityState',
    'runtimeActivityActiveCount',
    'runtimeActivityObservedAt',
    'runtimeActivityRevision',
  ] as const;
  const presentRuntimeActivityFields = runtimeActivityFields.filter((key) =>
    Object.hasOwn(runtimeInput, key));
  if (presentRuntimeActivityFields.length > 0) {
    const hasProjection = presentRuntimeActivityFields.some((key) =>
      key === 'runtimeActivityObservedAt' || key === 'runtimeActivityRevision');
    const activityInput = hasProjection
      ? {
          state: runtimeInput.runtimeActivityState,
          activeCount: runtimeInput.runtimeActivityActiveCount,
          observedAt: runtimeInput.runtimeActivityObservedAt,
          revision: runtimeInput.runtimeActivityRevision,
        }
      : {
          state: runtimeInput.runtimeActivityState,
          activeCount: runtimeInput.runtimeActivityActiveCount,
        };
    const activitySchema = hasProjection
      ? SessionRuntimeActivityProjectionSchema
      : SessionRuntimeActivitySnapshotSchema;
    const activity = activitySchema.safeParse(activityInput);
    if (activity.success) {
      runtimeInput.runtimeActivity = activity.data;
    } else {
      unsupportedFields.push(...presentRuntimeActivityFields);
    }
    for (const key of runtimeActivityFields) delete runtimeInput[key];
  }
  const connectedServicesInput = copyPresentKeys(
    metadata,
    CONNECTED_SERVICE_OWNER_KEYS,
  );
  if (
    connectedServicesInput.connectedServiceMaterializationIdentityV1
    && typeof connectedServicesInput.connectedServiceMaterializationIdentityV1 === 'object'
  ) {
    const identity = {
      ...(connectedServicesInput.connectedServiceMaterializationIdentityV1 as Record<string, unknown>),
    };
    if (!Object.hasOwn(identity, 'createdAt') && typeof identity.createdAtMs === 'number') {
      identity.createdAt = identity.createdAtMs;
      delete identity.createdAtMs;
    }
    connectedServicesInput.connectedServiceMaterializationIdentityV1 = identity;
  }
  const historyInput = copyPresentKeys(metadata, HISTORY_OWNER_KEYS);
  if (metadata.externalHistoryImportV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.externalHistoryImportV1,
      'providerId',
    );
    if (normalized) historyInput.externalHistoryImportV1 = normalized;
    else unsupportedFields.push('externalHistoryImportV1');
  }
  if (metadata.acpHistoryImportV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.acpHistoryImportV1,
      'provider',
    );
    if (normalized) historyInput.acpHistoryImportV1 = normalized;
    else unsupportedFields.push('acpHistoryImportV1');
  }
  const handoffInput = copyPresentKeys(metadata, HANDOFF_OWNER_KEYS);
  if (metadata.handoffV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.handoffV1,
      'providerId',
    );
    if (normalized) handoffInput.handoffV1 = normalized;
    else unsupportedFields.push('handoffV1');
  }
  if (metadata.acpTransportV1 !== undefined) {
    const normalized = normalizeAgentVocabularyRecord(
      metadata.acpTransportV1,
      'provider',
    );
    if (normalized) handoffInput.acpTransportV1 = normalized;
    else unsupportedFields.push('acpTransportV1');
  }
  const cursorsInput = copyPresentKeys(metadata, CURSOR_OWNER_KEYS);
  if (metadata.directSessionAttentionV1 !== undefined) {
    if (metadata.externalSessionAttentionV1 !== undefined) {
      unsupportedFields.push('directSessionAttentionV1');
    } else {
      cursorsInput.externalSessionAttentionV1 =
        metadata.directSessionAttentionV1;
    }
  }
  const workInput = copyPresentKeys(metadata, [
    'sessionWorkStateV1',
    'sessionWorkflowActivityHeadlineV1',
  ]);
  const legacyGoalInput = metadata.sessionGoalV1 ?? metadata.codexGoalV1;
  if (legacyGoalInput !== undefined) {
    if (metadata.sessionWorkStateV1 !== undefined) {
      // The canonical state already owns the same facts; remove the legacy alias.
    } else {
      const legacyGoal = z.object({
        objective: z.string().trim().min(1).max(4_000).optional(),
        title: z.string().trim().min(1).max(4_000).optional(),
        status: z.enum([
          'pending',
          'active',
          'paused',
          'blocked',
          'complete',
          'cancelled',
          'unknown',
        ]).optional(),
        statusReason: z.enum([
          'blocked',
          'usageLimited',
          'budgetLimited',
          'interrupted',
        ]).optional(),
        createdAt: TimestampSchema.optional(),
        startedAt: TimestampSchema.optional(),
        completedAt: TimestampSchema.optional(),
        updatedAt: TimestampSchema.optional(),
        tokenBudget: z.number().finite().positive().nullable().optional(),
        tokensUsed: z.number().int().nonnegative().optional(),
        timeUsedSeconds: z.number().finite().nonnegative().optional(),
      }).strict().safeParse(legacyGoalInput);
      const title = legacyGoal.success
        ? legacyGoal.data.objective ?? legacyGoal.data.title
        : undefined;
      if (!legacyGoal.success || !title) {
        unsupportedFields.push(
          metadata.sessionGoalV1 !== undefined ? 'sessionGoalV1' : 'codexGoalV1',
        );
      } else {
        const updatedAt = legacyGoal.data.updatedAt ?? 0;
        const backendId =
          runtimeDescriptorV1?.agentId
          ?? resolveGeneratedSessionPresentationAgentIdV1(metadata)
          ?? 'codex';
        workInput.sessionWorkStateV1 = {
          v: 1,
          backendId,
          agentId: runtimeDescriptorV1?.agentId,
          updatedAt,
          primaryItemId: 'goal:legacy',
          items: [{
            id: 'goal:legacy',
            kind: 'goal',
            origin: 'vendor',
            status: legacyGoal.data.status ?? 'active',
            title,
            updatedAt,
            ...(legacyGoal.data.statusReason
              ? { statusReason: legacyGoal.data.statusReason }
              : {}),
            ...(legacyGoal.data.createdAt !== undefined
              ? { createdAt: legacyGoal.data.createdAt }
              : {}),
            ...(legacyGoal.data.startedAt !== undefined
              ? { startedAt: legacyGoal.data.startedAt }
              : {}),
            ...(legacyGoal.data.completedAt !== undefined
              ? { completedAt: legacyGoal.data.completedAt }
              : {}),
            ...(legacyGoal.data.tokenBudget !== undefined
              ? { tokenBudget: legacyGoal.data.tokenBudget }
              : {}),
            ...(legacyGoal.data.tokensUsed !== undefined
              ? { tokensUsed: legacyGoal.data.tokensUsed }
              : {}),
            ...(legacyGoal.data.timeUsedSeconds !== undefined
              ? { timeUsedSeconds: legacyGoal.data.timeUsedSeconds }
              : {}),
          }],
        };
      }
    }
  }
  const systemInput = copyPresentKeys(metadata, SYSTEM_OWNER_KEYS);
  delete systemInput.hiddenSystemSession;
  if (
    metadata.hiddenSystemSession !== undefined
    && metadata.systemSessionV1 === undefined
  ) {
    if (typeof metadata.hiddenSystemSession !== 'boolean') {
      unsupportedFields.push('hiddenSystemSession');
    } else if (metadata.hiddenSystemSession) {
      systemInput.systemSessionV1 = {
        v: 1,
        key: 'legacy-hidden-system-session',
        hidden: true,
      };
    }
  }
  if (metadata.voiceAgentRunV1 !== undefined) {
    const voiceAgentRun = readRecord(metadata.voiceAgentRunV1);
    const allowedVoiceAgentRunKeys = new Set([
      'v',
      'runId',
      'backendId',
      'backendTarget',
      'resumeHandle',
      'updatedAtMs',
      'transcriptContractVersion',
      'welcomedEpoch',
      'streamId',
    ]);
    if (!voiceAgentRun || !hasOnlyKeys(voiceAgentRun, allowedVoiceAgentRunKeys)) {
      unsupportedFields.push('voiceAgentRunV1');
    } else {
      const canonicalVoiceAgentRun =
        parseVoiceAgentRunMetadataV1(voiceAgentRun);
      if (!canonicalVoiceAgentRun) {
        unsupportedFields.push('voiceAgentRunV1');
      } else {
        const resumeHandle = canonicalVoiceAgentRun.resumeHandle;
        const strictResumeHandle = resumeHandle === null
          ? null
          : SessionOwnerResumeHandleV1Schema.safeParse(
              resumeHandle.kind === 'provider_session.v1'
                ? {
                    kind: resumeHandle.kind,
                    backendTarget: resumeHandle.backendTarget,
                    providerSessionId: resumeHandle.providerSessionId,
                  }
                : resumeHandle.kind === 'voice_agent_sessions.v1'
                  ? {
                      kind: resumeHandle.kind,
                      backendTarget: resumeHandle.backendTarget,
                      chatProviderSessionId: resumeHandle.chatProviderSessionId,
                      commitProviderSessionId: resumeHandle.commitProviderSessionId,
                    }
                  : null,
            );
        systemInput.voiceAgentRunV1 = {
          ...canonicalVoiceAgentRun,
          resumeHandle: strictResumeHandle === null
            ? null
            : strictResumeHandle.success
              ? strictResumeHandle.data
              : null,
        };
      }
    }
  }

  const categoryInputs = [
    ['workspace', SessionOwnerWorkspaceV1Schema, workspaceInput],
    ['nativeSession', SessionOwnerNativeSessionV1Schema, nativeSessionInput],
    ['runtime', SessionOwnerRuntimeV1Schema, runtimeInput],
    ['connectedServices', SessionOwnerConnectedServicesV1Schema, connectedServicesInput],
    ['history', SessionOwnerHistoryV1Schema, historyInput],
    ['handoff', SessionOwnerHandoffV1Schema, handoffInput],
    ['cursors', SessionOwnerCursorsV1Schema, cursorsInput],
    ['work', SessionOwnerWorkV1Schema, workInput],
    ['system', SessionOwnerSystemV1Schema, systemInput],
  ] as const;
  const ownerMetadata: Record<string, unknown> = {
    v: SESSION_OWNER_METADATA_VERSION_V1,
  };
  for (const [category, schema, input] of categoryInputs) {
    if (Object.keys(input).length === 0) continue;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      unsupportedFields.push(
        ...parsed.error.issues.map((issue) =>
          `${category}.${issue.path.join('.') || '$'}`),
      );
      continue;
    }
    ownerMetadata[category] = parsed.data;
  }

  const deduplicatedUnsupportedFields = [...new Set(unsupportedFields)].sort();
  if (deduplicatedUnsupportedFields.length > 0) {
    return {
      ok: false,
      error: 'unsupported_owner_metadata',
      unsupportedFields: deduplicatedUnsupportedFields,
    };
  }
  return {
    ok: true,
    ownerMetadata: SessionOwnerMetadataV1Schema.parse(ownerMetadata),
  };
}

export function sealSessionOwnerMetadataV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ownerMetadata: SessionOwnerMetadataV1;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  const ownerMetadata = SessionOwnerMetadataV1Schema.parse(
    params.ownerMetadata,
  );
  return sealAccountScopedBlobCiphertext({
    kind: SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND,
    material: params.material,
    payload: ownerMetadata,
    randomBytes: params.randomBytes,
  });
}

export function openSessionOwnerMetadataV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): SessionOwnerMetadataV1 | null {
  const opened = openAccountScopedBlobCiphertext({
    kind: SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND,
    material: params.material,
    ciphertext: params.ciphertext,
  });
  if (
    !opened
    || opened.format !== 'account_scoped_v1'
    || opened.kindTag !== 'canonical'
  ) {
    return null;
  }
  const parsed = SessionOwnerMetadataV1Schema.safeParse(opened.value);
  return parsed.success ? parsed.data : null;
}

export function isSessionOwnerMetadataCiphertextV1(
  ciphertext: string,
): boolean {
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(ciphertext, 'base64');
  } catch {
    return false;
  }
  if (encodeBase64(decoded, 'base64') !== ciphertext) {
    return false;
  }
  return readAccountScopedCiphertextKindByte(ciphertext)
    === SESSION_OWNER_METADATA_ACCOUNT_SCOPED_KIND_BYTE_V1;
}

export function rewrapSessionOwnerMetadataV1(params: Readonly<{
  sourceMaterial: AccountScopedCryptoMaterial;
  targetMaterial: AccountScopedCryptoMaterial;
  ciphertext: string;
  randomBytes: (length: number) => Uint8Array;
}>): string | null {
  const ownerMetadata = openSessionOwnerMetadataV1({
    material: params.sourceMaterial,
    ciphertext: params.ciphertext,
  });
  if (!ownerMetadata) return null;
  return sealSessionOwnerMetadataV1({
    material: params.targetMaterial,
    ownerMetadata,
    randomBytes: params.randomBytes,
  });
}
