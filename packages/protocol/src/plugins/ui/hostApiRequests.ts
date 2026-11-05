import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { AutomationEventSourceInstanceIdV1Schema } from '../../automations/automationEventJsonBoundsV1.js';
import { SessionIdentityAdditionsV1Schema } from '../../sessions/identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../../sessions/context/sessionContextV1.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { ActionSessionAddressV1Schema } from '../../actions/sessionTargetV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { PendingLocalIdSchema } from '../../sessions/pending/pendingLocalId.js';

import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  QualifiedConnectedAccountIdSchema,
  QualifiedConnectedAccountRefSchema,
} from '../../connect/qualifiedConnectedAccountPersistence.js';
import { PluginUiJsonValueV1Schema, type PluginUiJsonValueV1 } from '../contributions/ui/json.js';
import { measureSerializedStrictPluginJsonUtf8Bytes } from '../contributions/strictJsonValue.js';
import { PluginUiHostApiRequestMethodV1Schema } from './hostApiDefinition.js';
import {
  ComposerDecorationResultV1Schema,
  ComposerDecorationSetV1Schema,
  ComposerFocusResultV1Schema,
  ComposerInputLockRequestV1Schema,
  ComposerReadResultV1Schema,
  ComposerRefV1Schema,
  ComposerSnapshotV1Schema,
  ComposerTransactionResultV1Schema,
  ComposerTransactionV1Schema,
} from './composer.js';
import {
  ComposerAttachmentAuthorValueV1Schema,
  ComposerAttachmentValueV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
} from '../../runtime/input/composerAttachmentV1.js';
import {
  ComposerContentHandleV1Schema,
  ComposerContentInspectRequestV1Schema,
  ComposerContentInspectWireResultV1Schema,
  ComposerContentPickMediaRequestV1Schema,
} from '../../runtime/input/composerContentV1.js';
import {
  PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1,
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1,
  PluginUiInstanceKeyV1Schema,
  PluginUiLaunchInputV1Schema,
  PluginUiSubPathV1Schema,
  PluginUiSurfacePresentationV1Schema,
  normalizePluginUiSubPathV1,
} from './semanticCommands.js';
import { PluginUiSurfaceContextV1Schema } from './surfaceContext.js';
import { CurrentUiContextSnapshotV1Schema, PluginUiContextEnrichmentV1Schema } from './currentUiContext.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { defineProtocolCanonicalJsonValue } from '../actions/protocolComposableSchema.js';
import {
  PluginTargetedContributionSelectionV1Schema,
  PluginUiTargetedContributionOperationV1Schema,
} from './targetedContributions.js';
import { SessionServerStartSpawnDraftV1Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { ReviewStartInputSchema } from '../../reviews/reviewStart.js';
import {
  SessionAwarenessLifecycleV1Schema,
  SessionAwarenessOperationalPrimaryV1Schema,
  SessionAwarenessRuntimeV1Schema,
  SessionAwarenessWorkspaceV1Schema,
} from '../../sessions/awareness/projectionV1.js';
import { ProjectKeyV1Schema } from '../../workspaces/workspaceRefV1.js';
import { PluginUiNewSessionSeedOriginV1Schema } from './newSessionSeedOrigin.js';
import { VoiceTrackedSessionAddressV1Schema } from '../../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { InboxItemAttentionTypeV1Schema } from '../../sessions/follow/sessionFollowPolicyV1.js';
import { PluginUiIconTokenV1Schema } from '../contributions/ui/tokens.js';
export { PluginUiNewSessionSeedOriginV1Schema, StoredPluginUiNewSessionSeedOriginV1Schema,
  type PluginUiNewSessionSeedOriginV1 } from './newSessionSeedOrigin.js';

/** Authoring intent only. Source setup and trigger writes still require explicit submission. */
export const PluginUiOpenAutomationEventRequestV1Schema = lazyZodSchema(() => z.strictObject({
  eventRef: asProtocolZod(PluginContributionIdentityV1Schema),
  sourceInstanceId: z.optional(AutomationEventSourceInstanceIdV1Schema),
  monitoringMachineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  connectedAccount: z.optional(asProtocolZod(QualifiedConnectedAccountRefSchema)),
  setupInput: z.record(z.string(), PluginUiJsonValueV1Schema),
}));
export type PluginUiOpenAutomationEventRequestV1 = z.infer<typeof PluginUiOpenAutomationEventRequestV1Schema>;

/** The mounted Account supplies Home authority; author input supplies only an exact lookup key. */
export const PluginUiRevealSessionInputRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
}));
export type PluginUiRevealSessionInputRequestV1 = z.infer<typeof PluginUiRevealSessionInputRequestV1Schema>;

export {
  PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1,
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1,
  PluginUiInstanceKeyV1Schema,
  PluginUiLaunchInputV1Schema,
  PluginUiSemanticCommandV1Schema,
  PluginUiSemanticExecuteActionCommandV1Schema,
  PluginUiSemanticOpenSurfaceCommandV1Schema,
  PluginUiResolvedSemanticCommandV1Schema,
  PluginUiResolvedSemanticExecuteActionCommandV1Schema,
  PluginUiResolvedSemanticOpenSurfaceCommandV1Schema,
  PluginUiSubPathV1Schema,
  normalizePluginUiSemanticCommandV1,
  normalizePluginUiSubPathV1,
} from './semanticCommands.js';
export type {
  PluginUiInstanceKeyV1,
  PluginUiLaunchInputV1,
  PluginUiResolvedSemanticCommandV1,
  PluginUiResolvedSemanticExecuteActionCommandV1,
  PluginUiResolvedSemanticOpenSurfaceCommandV1,
  PluginUiSemanticCommandV1,
  PluginUiSemanticExecuteActionCommandV1,
  PluginUiSemanticOpenSurfaceCommandV1,
  PluginUiSubPathV1,
} from './semanticCommands.js';

export const PluginUiHostApiErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'unavailable',
  'denied',
  'invalid_payload',
  'unsupported_method',
  'stale_surface',
  'expired_resource',
  'timeout',
  'internal_error',
]));

/**
 * Generic first-terminal result for a mount whose host placement explicitly
 * requested ephemeral input. It is never persisted and carries no authority.
 */
export const PluginUiEphemeralInputSettlementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('completed'),
    input: PluginUiJsonValueV1Schema,
  }),
  z.strictObject({ kind: z.literal('cancelled') }),
]));
export type PluginUiEphemeralInputSettlementV1 = z.infer<
  typeof PluginUiEphemeralInputSettlementV1Schema
>;
export type PluginUiHostApiErrorCodeV1 =
  z.infer<typeof PluginUiHostApiErrorCodeV1Schema>;

/**
 * A typed mounted-host failure. This is distinct from an Action result: plugin
 * Action JSON is allowed to carry a `code` member with the same spelling.
 */
export const PluginUiHostApiErrorPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  // The deciding owner's code, including domain refusals. The coarse Host API
  // vocabulary above remains available for failures decided at that boundary.
  code: z.string().check(z.trim(), z.minLength(1)),
  layer: z.optional(z.enum(['target', 'accountSelection', 'executionSelection', 'transport', 'source', 'artifact', 'registration', 'policy', 'input', 'approval', 'host'])),
  phase: z.optional(z.enum(['admission', 'preparation', 'activation', 'invocation', 'settlement'])),
  retryable: z.optional(z.boolean()),
  message: z.optional(z.string().check(z.trim(), z.minLength(1))),
  diagnostics: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
}));
export type PluginUiHostApiErrorPayloadV1 =
  z.infer<typeof PluginUiHostApiErrorPayloadV1Schema>;

/**
 * One mount-bound replacement or clear of the caller's semantic current-UI
 * enrichment. The mounted host owns identity binding and opaque command-handle
 * allocation; the author can only send closed semantic data or clear it.
 */
export const PluginUiPublishCurrentUiContextRequestV1Schema = lazyZodSchema(() => z.strictObject({
  enrichment: zMini.nullable(PluginUiContextEnrichmentV1Schema),
}));
export type PluginUiPublishCurrentUiContextRequestV1 =
  z.infer<typeof PluginUiPublishCurrentUiContextRequestV1Schema>;

const ComposerRefV1ZodSchema = lazyZodSchema(() => asProtocolZod(ComposerRefV1Schema));

/** `activeComposer` has no request payload; an absent focused composer is null. */
export const PluginUiActiveComposerResultV1Schema = lazyZodSchema(() => zMini.nullable(ComposerRefV1ZodSchema));
export type PluginUiActiveComposerResultV1 =
  z.infer<typeof PluginUiActiveComposerResultV1Schema>;

export const PluginUiReadComposerRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ref: ComposerRefV1ZodSchema,
}));
export type PluginUiReadComposerRequestV1 =
  z.infer<typeof PluginUiReadComposerRequestV1Schema>;
export const PluginUiReadComposerResultV1Schema = ComposerReadResultV1Schema;
export type PluginUiReadComposerResultV1 =
  z.infer<typeof PluginUiReadComposerResultV1Schema>;

/** Watch establishment returns through the shared subscription acknowledgement. */
export const PluginUiWatchComposerRequestV1Schema = PluginUiReadComposerRequestV1Schema;
export type PluginUiWatchComposerRequestV1 =
  z.infer<typeof PluginUiWatchComposerRequestV1Schema>;
export const PluginUiWatchComposerEventV1Schema = ComposerSnapshotV1Schema;
export type PluginUiWatchComposerEventV1 =
  z.infer<typeof PluginUiWatchComposerEventV1Schema>;

export const PluginUiApplyComposerRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ref: ComposerRefV1ZodSchema,
  transaction: ComposerTransactionV1Schema,
}));
export type PluginUiApplyComposerRequestV1 =
  z.infer<typeof PluginUiApplyComposerRequestV1Schema>;
export const PluginUiApplyComposerResultV1Schema = ComposerTransactionResultV1Schema;
export type PluginUiApplyComposerResultV1 =
  z.infer<typeof PluginUiApplyComposerResultV1Schema>;

export const PluginUiFocusComposerRequestV1Schema = PluginUiReadComposerRequestV1Schema;
export type PluginUiFocusComposerRequestV1 =
  z.infer<typeof PluginUiFocusComposerRequestV1Schema>;
export const PluginUiFocusComposerResultV1Schema = ComposerFocusResultV1Schema;
export type PluginUiFocusComposerResultV1 =
  z.infer<typeof PluginUiFocusComposerResultV1Schema>;

export const PluginUiSetComposerDecorationsRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ref: ComposerRefV1ZodSchema,
  key: z.string().check(z.trim(), z.minLength(1)),
  decorations: zMini.nullable(ComposerDecorationSetV1Schema),
}));
export type PluginUiSetComposerDecorationsRequestV1 =
  z.infer<typeof PluginUiSetComposerDecorationsRequestV1Schema>;
export const PluginUiSetComposerDecorationsResultV1Schema = ComposerDecorationResultV1Schema;
export type PluginUiSetComposerDecorationsResultV1 =
  z.infer<typeof PluginUiSetComposerDecorationsResultV1Schema>;

export const PluginUiAcquireComposerInputLockRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ref: ComposerRefV1ZodSchema,
  request: ComposerInputLockRequestV1Schema,
}));
export type PluginUiAcquireComposerInputLockRequestV1 =
  z.infer<typeof PluginUiAcquireComposerInputLockRequestV1Schema>;

/** Selection is host-bound to the exact Composer and mounted contribution. */
export const PluginUiPickComposerMediaRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ref: ComposerRefV1ZodSchema,
  request: ComposerContentPickMediaRequestV1Schema,
}));
export type PluginUiPickComposerMediaRequestV1 =
  z.infer<typeof PluginUiPickComposerMediaRequestV1Schema>;
export const PluginUiPickComposerMediaResultV1Schema = ComposerContentHandleV1Schema;
export type PluginUiPickComposerMediaResultV1 =
  z.infer<typeof PluginUiPickComposerMediaResultV1Schema>;

/** Inspection reads bounded bytes through the incumbent transfer carrier, never a path or transfer session. */
export const PluginUiInspectComposerContentRequestV1Schema = lazyZodSchema(() => z.strictObject({
  handle: ComposerContentHandleV1Schema,
  request: ComposerContentInspectRequestV1Schema,
}));
export type PluginUiInspectComposerContentRequestV1 =
  z.infer<typeof PluginUiInspectComposerContentRequestV1Schema>;
export const PluginUiInspectComposerContentResultV1Schema = ComposerContentInspectWireResultV1Schema;
export type PluginUiInspectComposerContentResultV1 =
  z.infer<typeof PluginUiInspectComposerContentResultV1Schema>;

/** Release is idempotent at the transfer-owned stage owner; callers carry only the opaque claim. */
export const PluginUiReleaseComposerContentRequestV1Schema = lazyZodSchema(() => z.strictObject({
  handle: ComposerContentHandleV1Schema,
}));
export type PluginUiReleaseComposerContentRequestV1 =
  z.infer<typeof PluginUiReleaseComposerContentRequestV1Schema>;

/**
 * The shared answer vocabulary for one pending Session permission request.
 * The mounted host maps it through the same decision owner the Session UI's
 * footer uses; it is not a second permission authority.
 */
export const PluginUiSessionPermissionAnswerV1Schema = lazyZodSchema(() => z.enum(['allowOnce', 'allowForSession', 'deny']));
export type PluginUiSessionPermissionAnswerV1 =
  z.infer<typeof PluginUiSessionPermissionAnswerV1Schema>;

/**
 * One pending permission request as the plugin UI sees it: what the Agent wants
 * to run, when it asked, and which answers this viewer may give (empty when the
 * viewer may not approve for this Session).
 */
export const PluginUiSessionPendingPermissionV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.trim(), z.minLength(1)),
  toolName: z.string().check(z.trim(), z.minLength(1)),
  summary: z.string(),
  command: z.optional(z.string().check(z.minLength(1))),
  createdAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  answers: z.array(PluginUiSessionPermissionAnswerV1Schema),
}));
export type PluginUiSessionPendingPermissionV1 =
  z.infer<typeof PluginUiSessionPendingPermissionV1Schema>;

/**
 * The live state of one Session this Account's client can open. Lifecycle,
 * runtime, operational state, title and workspace are the canonical Session
 * awareness projection's own fields. Work presentation comes from the host's
 * shared Work owner, including report-aware settlement. Both objects are closed.
 */
export const PluginUiSessionStateV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  // Exact mounted Account scope, not the client's currently focused Home.
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  title: z.optional(z.string().check(z.minLength(1))),
  /** Catalog presentation only; unknown identity stays absent rather than selecting a default Agent. */
  agent: z.optional(z.strictObject({
    agentId: z.string().check(z.trim(), z.minLength(1)),
    displayName: z.string().check(z.trim(), z.minLength(1)),
    /** Exact package target for the public BrandMark owner, when the catalog knows it. */
    brand: z.optional(z.strictObject({ pluginId: asProtocolZod(PluginIdSchema) })),
  })),
  lifecycle: SessionAwarenessLifecycleV1Schema,
  runtime: SessionAwarenessRuntimeV1Schema,
  operational: SessionAwarenessOperationalPrimaryV1Schema,
  workStatus: z.strictObject({
    state: z.string(),
    bucket: z.enum(['needs_you', 'working', 'finished', 'idle', 'offline']),
    tone: z.enum(['neutral', 'attention', 'danger']),
    attentionType: z.nullable(InboxItemAttentionTypeV1Schema),
    word: z.string(),
    glyph: z.optional(PluginUiIconTokenV1Schema),
  }),
  workspace: zMini.optional(SessionAwarenessWorkspaceV1Schema),
  pendingPermissions: z.array(PluginUiSessionPendingPermissionV1Schema),
  /** Absent on older mounted hosts; absence never means read or empty. */
  hasUnreadMessages: z.optional(z.boolean()),
  latestActivity: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ready'), text: z.string(), createdAt: z.number().check(z.int(), z.nonnegative()) }),
    z.strictObject({ kind: z.literal('empty') }),
    z.strictObject({ kind: z.literal('hidden') }),
    z.strictObject({ kind: z.literal('unavailable') }),
  ])),
}));
export type PluginUiSessionStateV1 = z.infer<typeof PluginUiSessionStateV1Schema>;

export const PluginUiReadSessionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginUiReadSessionRequestV1 = z.infer<typeof PluginUiReadSessionRequestV1Schema>;
/** `null` is a Session this Account's client cannot reach, never an error. */
export const PluginUiReadSessionResultV1Schema = lazyZodSchema(() => z.nullable(PluginUiSessionStateV1Schema));
export type PluginUiReadSessionResultV1 = z.infer<typeof PluginUiReadSessionResultV1Schema>;

/** Qualified presentation lookup only; Account authority belongs to the mounted host. */
export const PluginUiReadMachineDisplayNameRequestV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginUiReadMachineDisplayNameRequestV1 = z.infer<typeof PluginUiReadMachineDisplayNameRequestV1Schema>;
/** Unknown or out-of-scope identities disclose no Machine content. */
export const PluginUiReadMachineDisplayNameResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), displayName: z.string() }),
  z.strictObject({ status: z.literal('unavailable') }),
]));
export type PluginUiReadMachineDisplayNameResultV1 = z.infer<typeof PluginUiReadMachineDisplayNameResultV1Schema>;

/**
 * A Session watch is the same bounded invalidation signal as `watchResource`:
 * events are `PluginUiResourceSubscriptionEventV1`, and `readSession` remains
 * the one snapshot authority.
 */
export const PluginUiWatchSessionRequestV1Schema = PluginUiReadSessionRequestV1Schema;
export type PluginUiWatchSessionRequestV1 = z.infer<typeof PluginUiWatchSessionRequestV1Schema>;

export const PluginUiRespondToSessionPermissionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  requestId: z.string().check(z.trim(), z.minLength(1)),
  answer: PluginUiSessionPermissionAnswerV1Schema,
}));
export type PluginUiRespondToSessionPermissionRequestV1 =
  z.infer<typeof PluginUiRespondToSessionPermissionRequestV1Schema>;

export const PluginUiRespondToSessionPermissionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('answered') }),
  z.strictObject({
    status: z.literal('refused'),
    reason: z.enum(['sessionUnavailable', 'requestNotPending', 'answerUnavailable']),
  }),
]));
export type PluginUiRespondToSessionPermissionResultV1 =
  z.infer<typeof PluginUiRespondToSessionPermissionResultV1Schema>;

/**
 * Diagnostic data is part of the public mounted Host API, not a daemon-only
 * introspection record. Keep this grammar beside the request vocabulary so the
 * wire error envelope, mounted UI host, and SDK fixture all decode the exact
 * same author payload.
 */
const PluginUiHostApiDiagnosticContributionRefV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  localId: z.string().check(z.trim(), z.minLength(1)),
}));
export const PluginUiHostApiDiagnosticRemediationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('retry') }),
  z.strictObject({ kind: z.literal('openSettings'), path: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('selectAccount'), service: PluginUiHostApiDiagnosticContributionRefV1Schema }),
  z.strictObject({ kind: z.literal('installDependency'), dependencyId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('openUrl'), url: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type PluginUiHostApiDiagnosticRemediationV1 =
  z.infer<typeof PluginUiHostApiDiagnosticRemediationV1Schema>;

/** A plugin diagnostic must remain bounded before a mounted host logs it. */
export const PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1 = 8 * 1024;
export const PluginUiHostApiDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.string().check(z.trim(), z.minLength(1)),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.optional(z.string()),
  details: zMini.optional(PluginUiJsonValueV1Schema),
  remediation: z.optional(PluginUiHostApiDiagnosticRemediationV1Schema),
}).check(z.superRefine((value, context) => {
  if (
    measureSerializedStrictPluginJsonUtf8Bytes(
      value,
      'diagnostic',
      PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1,
    )
    > PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1
  ) {
    context.addIssue({
      code: "custom",
      message: `Plugin UI diagnostic exceeds the ${PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1}-byte UTF-8 limit.`,
    });
  }
})));
export type PluginUiHostApiDiagnosticV1 =
  z.infer<typeof PluginUiHostApiDiagnosticV1Schema>;

/** The public utility-effect payloads remain strict even though their effects are host-owned. */
export const PluginUiHostApiWriteClipboardRequestV1Schema = lazyZodSchema(() => z.strictObject({
  value: z.string(),
}));
export type PluginUiHostApiWriteClipboardRequestV1 =
  z.infer<typeof PluginUiHostApiWriteClipboardRequestV1Schema>;

export const PluginUiHostApiOpenExternalLinkRequestV1Schema = lazyZodSchema(() => z.strictObject({
  url: z.string(),
}));
export type PluginUiHostApiOpenExternalLinkRequestV1 =
  z.infer<typeof PluginUiHostApiOpenExternalLinkRequestV1Schema>;

/**
 * A destination is always an exact qualified contribution reference. The caller
 * can never smuggle a host route, machine, Resource, or ambient plugin identity
 * through it.
 */
export const PluginUiDestinationReferenceV1Schema = PluginContributionIdentityV1Schema;
export type PluginUiDestinationReferenceV1 = PluginContributionIdentityV1;

/**
 * A resolved contributed Action reference is always exact. Declarative
 * selectors and mounted-action normalization consume this form after their
 * caller binding has been established.
 */
export const PluginUiQualifiedActionReferenceV1Schema = PluginContributionIdentityV1Schema;
export type PluginUiQualifiedActionReferenceV1 = PluginContributionIdentityV1;

/**
 * The raw mounted host request accepts a bare action string because that string
 * may name either a host ActionSpec or a caller-local contributed Action. Keep
 * it raw: the mounted dispatcher classifies host ActionSpecs before invoking
 * contributed-action normalization. The refinement deliberately preserves the
 * original string instead of trimming it, so the downstream canonical owners
 * retain their existing exact-id semantics.
 */
const PluginUiMountedBareActionReferenceV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, 'Mounted Action references must not be blank.')));
export const PluginUiMountedActionReferenceV1Schema = lazyZodSchema(() => z.union([
  PluginUiMountedBareActionReferenceV1Schema,
  asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
]));
export type PluginUiMountedActionReferenceV1 =
  z.infer<typeof PluginUiMountedActionReferenceV1Schema>;

/**
 * Bind a mounted contributed Action reference to the host-stamped caller.
 *
 * This is intentionally not ActionSpec classification: callers invoke it only
 * after the canonical ActionSpec owner has declined a bare string. A bare
 * reference then belongs to the mounted plugin, while an exact qualified
 * reference preserves its target plugin.
 */
export function normalizePluginUiMountedContributedActionReferenceV1(
  input: unknown,
): PluginUiQualifiedActionReferenceV1 | null {
  const parsed = z.strictObject({
    callerPluginId: asProtocolZod(PluginIdSchema),
    action: PluginUiMountedActionReferenceV1Schema,
  }).safeParse(input);
  if (!parsed.success) return null;

  const reference = typeof parsed.data.action === 'string'
    ? { pluginId: parsed.data.callerPluginId, localId: parsed.data.action }
    : parsed.data.action;
  const normalized = PluginUiQualifiedActionReferenceV1Schema.safeParse(reference);
  return normalized.success ? Object.freeze(normalized.data) : null;
}

/**
 * The mounted open request carries concrete bounded values. It is intentionally
 * not the declarative selector schema below: a renderer cannot turn a document
 * path into a caller-selected route or an arbitrary JSON channel.
 */
export const PluginUiOpenSurfaceRequestV1Schema = lazyZodSchema(() => z.strictObject({
  destination: asProtocolZod(PluginUiDestinationReferenceV1Schema),
  input: zMini.optional(PluginUiLaunchInputV1Schema),
  subPath: zMini.optional(PluginUiSubPathV1Schema),
  instanceKey: zMini.optional(PluginUiInstanceKeyV1Schema),
  presentation: zMini.optional(PluginUiSurfacePresentationV1Schema),
}));
export type PluginUiOpenSurfaceRequestV1 =
  z.infer<typeof PluginUiOpenSurfaceRequestV1Schema>;

/**
 * Open Happier's canonical Connected Accounts experience.
 *
 * The request names semantic identity only. It cannot carry an app route,
 * arbitrary query parameters, credential material, or a plugin surface id.
 * Account focus is valid only beside its exact service because connected
 * account ids are qualified by the producing contribution.
 */
export const PluginUiOpenConnectedAccountsRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({}),
  z.strictObject({
    service: asProtocolZod(PluginContributionIdentityV1Schema),
    accountId: zMini.optional(asProtocolZod(QualifiedConnectedAccountIdSchema)),
    purpose: zMini.optional(QualifiedConnectedAccountPurposeV1Schema),
  }),
]));
export type PluginUiOpenConnectedAccountsRequestV1 =
  z.infer<typeof PluginUiOpenConnectedAccountsRequestV1Schema>;

/** Account references only. Older hosts acknowledge navigation without a result. */
export const PluginUiOpenConnectedAccountsResultV1Schema = lazyZodSchema(() => z.pipe(
  z.transform(value => value === null ? undefined : value),
  z.optional(z.union([
    z.strictObject({ kind: z.enum(['connected', 'selected']), account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
    z.strictObject({ kind: z.literal('dismissed') }),
  ])),
));
export type PluginUiOpenConnectedAccountsResultV1 =
  z.infer<typeof PluginUiOpenConnectedAccountsResultV1Schema>;

/**
 * Same-page location replacement, and the one page-internal Back step it may
 * declare.
 *
 * This is deliberately NOT `openSurface`. An open selects a destination and
 * pushes a history entry, which is the right contract for "take me somewhere"
 * and the wrong one for "the thing I am already looking at is now filtered
 * differently": a page whose every keystroke pushed would bury the user's real
 * previous screen under its own interaction trail.
 *
 * `backLocation` is the page-internal Back participant. It is a LOCATION rather
 * than a callback because a callback cannot be answered synchronously across a
 * transport, and a Back whose outcome depends on an in-flight round trip is the
 * kind of bug a user cannot describe. Declaring it here, atomically with the
 * replacement it belongs to, means the host can decide Back from a fact it
 * already holds and the user always sees the location change that resulted.
 * Absent means this page location has no Back step of its own.
 */
export const PluginUiReplacePageLocationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  subPath: PluginUiSubPathV1Schema,
  backLocation: zMini.optional(PluginUiSubPathV1Schema),
}));
export type PluginUiReplacePageLocationRequestV1 =
  z.infer<typeof PluginUiReplacePageLocationRequestV1Schema>;

/**
 * The host's settlement: the page location that is now current.
 *
 * It carries no echo of the request and no history fact, because the caller
 * must not be able to conclude anything about navigation it does not own. A
 * caller that replaced to `a` and is told `b` has been superseded and should
 * render `b`.
 */
export const PluginUiReplacePageLocationResultV1Schema = lazyZodSchema(() => z.strictObject({
  subPath: PluginUiSubPathV1Schema,
}));
export type PluginUiReplacePageLocationResultV1 =
  z.infer<typeof PluginUiReplacePageLocationResultV1Schema>;

/** Action dispatch is distinct from navigation and has no destination arm. */
export const PluginUiExecuteActionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  action: PluginUiMountedActionReferenceV1Schema,
  input: zMini.optional(PluginUiLaunchInputV1Schema),
}));
export type PluginUiExecuteActionRequestV1 =
  z.infer<typeof PluginUiExecuteActionRequestV1Schema>;

/** Admission for a caller-owned Account effect; it does not invoke a daemon handler. */
export const PluginUiActionAdmissionResultV1Schema = lazyZodSchema(() => z.strictObject({
  admitted: z.boolean(),
}));

export type PluginUiJsonObjectV1 = { readonly [key: string]: PluginUiJsonValueV1 };

function isPluginUiJsonObject(value: PluginUiJsonValueV1): value is PluginUiJsonObjectV1 {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Selection values share the incumbent bounded host-input JSON boundary. */
export const PluginUiJsonObjectV1Schema = lazyZodSchema(() => asProtocolZod(defineProtocolCanonicalJsonValue<PluginUiJsonObjectV1>({
  maxSerializedUtf8Bytes: PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  parse: (value) => isPluginUiJsonObject(value) ? value : null,
})));

/**
 * No-invoke selection names one exact operation already admitted into the
 * mounted target's Host API context. The host matches this JSON value back
 * to that snapshot; it does not treat the request as caller provenance or an
 * arbitrary Action lookup.
 */
export const PluginUiSelectActionInputTargetedRequestV1Schema = lazyZodSchema(() => z.strictObject({
    operation: PluginUiTargetedContributionOperationV1Schema,
    draft: zMini.optional(PluginUiJsonObjectV1Schema),
}));
export type PluginUiSelectActionInputTargetedRequestV1 =
  z.infer<typeof PluginUiSelectActionInputTargetedRequestV1Schema>;

/** Exact host-owned no-invoke selection literals. */
const PluginUiSelectActionInputSessionHostActionV1Schema = lazyZodSchema(() => z.strictObject({
  action: z.literal('session.spawn_new'),
  projection: z.literal('serverStartDraft'),
}));
const PluginUiSelectActionInputReviewHostActionV1Schema = lazyZodSchema(() => z.strictObject({
  action: z.literal('review.start'),
  projection: z.literal('executionRunLaunch'),
}));
const PluginUiSelectActionInputSessionAddressHostActionV1Schema = lazyZodSchema(() => z.strictObject({
  action: z.literal('session.transcript.get'),
  projection: z.literal('sessionAddress'),
}));
export const PluginUiSelectActionInputHostActionV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  PluginUiSelectActionInputSessionHostActionV1Schema,
  PluginUiSelectActionInputReviewHostActionV1Schema,
  PluginUiSelectActionInputSessionAddressHostActionV1Schema,
]));
export type PluginUiSelectActionInputHostActionV1 =
  z.infer<typeof PluginUiSelectActionInputHostActionV1Schema>;

/**
 * What a seed may declare.
 *
 * Every member is optional and an ABSENT member means "not seeded", never
 * "seeded empty": a caller that only carries a prompt must not clear a directory
 * the reader already chose. Prompt text carries no ceiling because the composer
 * it lands in has none either — a reader may type any length, so refusing a seed
 * of that same text would be a limit protecting nothing.
 *
 * Composer ATTACHMENTS travel as the AUTHOR half only, exactly as they do on a
 * live composer transaction: `{ attachmentLocalId, value }`, and nothing more.
 * A seed cannot state the rest of an attachment record — the qualified
 * contribution identity, the host-resolved type label, the cardinality upsert
 * and the host-minted instance id — because only a MOUNTED composer target
 * resolves those (`createAttachmentAuthorityResolver`/`resolveAttachments`), and
 * minting them here would be a second, unauthoritative attachment owner. So the
 * seed carries the request and the New Session composer applies it AT ITS OWN
 * MOUNT, through that same authority, against the caller's own admitted
 * contributor. Staged media content is deliberately not seedable: its handle is
 * bound to an execution target the seed has not chosen yet.
 */
export const PluginUiNewSessionSeedAttachmentV1Schema = lazyZodSchema(() => z.strictObject({
  // The host qualifies this local id from the CALLER, exactly as it does for a
  // live `attachment.add`. A seed never supplies a plugin or host identity.
  attachmentLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  value: ComposerAttachmentAuthorValueV1Schema,
}));
export type PluginUiNewSessionSeedAttachmentV1 =
  z.infer<typeof PluginUiNewSessionSeedAttachmentV1Schema>;

/**
 * The existing server-start presentation's checkout choice vocabulary.
 *
 * New Session seeding deliberately reuses it instead of declaring another
 * near-identical set of strings: a candidate remains a host-owned placement
 * hint until the real New Session screen accepts one.
 */
export const PluginUiSessionCheckoutIntentV1Schema = lazyZodSchema(() => z.enum([
  'none',
  // Requires the exact active selected operation carried by the public
  // `openNewSession` options. The host executes it before any route handoff;
  // this string alone is never workspace authority.
  'preparedReviewWorkspace',
  'reuseWorkspace',
  'createWorktree',
  'ask',
]));
export type PluginUiSessionCheckoutIntentV1 =
  z.infer<typeof PluginUiSessionCheckoutIntentV1Schema>;

/** One worktree fact carried by the incumbent host-owned placement candidate. */
export const PluginUiSessionPlacementWorktreeV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.trim(), z.minLength(1)),
  branch: z.nullable(z.string()),
  isMain: z.boolean(),
  isCurrent: z.boolean(),
}));
export type PluginUiSessionPlacementWorktreeV1 =
  z.infer<typeof PluginUiSessionPlacementWorktreeV1Schema>;

/**
 * An exact candidate the host may present for a New Session placement.
 *
 * This is the one grammar shared by the incumbent `serverStartDraft`
 * presentation and the seeded-New-Session path. A plugin may suggest exact
 * candidates; it cannot turn one into an execution target without the reader
 * and New Session owner selecting it.
 */
export const PluginUiSessionPlacementCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  projectKey: ProjectKeyV1Schema,
  serverId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  rootPath: z.string().check(z.trim(), z.minLength(1)),
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
  reachable: z.boolean(),
  worktrees: z.array(PluginUiSessionPlacementWorktreeV1Schema),
}));
export type PluginUiSessionPlacementCandidateV1 =
  z.infer<typeof PluginUiSessionPlacementCandidateV1Schema>;

export const PluginUiNewSessionPlacementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('exactTarget'),
    serverId: z.string().check(z.trim(), z.minLength(1)),
    machineId: z.string().check(z.trim(), z.minLength(1)),
    directory: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('currentTarget'),
    directory: z.string().check(z.trim(), z.minLength(1)),
  }),
]));
export type PluginUiNewSessionPlacementV1 =
  z.infer<typeof PluginUiNewSessionPlacementV1Schema>;

export const PluginUiNewSessionSeedV1Schema = lazyZodSchema(() => z.strictObject({
  /** An empty name requests the ordinary Session's automatic name. */
  sessionName: z.optional(z.string()),
  initialSessionFacts: zMini.optional(SessionIdentityAdditionsV1Schema),
  promptStack: zMini.optional(SessionPromptStackV1Schema),
  prompt: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Captured screen data becomes the declared current-screen attachment at the seed owner. */
  currentUiContext: z.optional(CurrentUiContextSnapshotV1Schema.check(z.refine(
    value => ComposerAttachmentValueV1Schema.safeParse(value).success,
    { message: 'Current-screen context must fit the Composer attachment value contract.' },
  ))),
  profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentTarget: z.optional(AgentExecutionTargetV1Schema),
  origin: zMini.optional(PluginUiNewSessionSeedOriginV1Schema),
  /**
   * A resolved checkout question, not a concrete checkout draft. The New
   * Session screen owns the eventual worktree name, base ref and persisted
   * `checkoutCreationDraft`; a seed can only state which existing reader
   * choice it needs to present.
   */
  checkoutIntent: z.optional(PluginUiSessionCheckoutIntentV1Schema),
  placement: z.optional(PluginUiNewSessionPlacementV1Schema),
  /**
   * Exact candidate placements stay candidates. In particular, a caller with
   * two matching checkouts must not convert the first array item into the
   * singular `placement` field and launch where the reader never chose.
   *
   * The seed is a caller-authored request: producers hand the host their own
   * readonly placement answers, so the array is readonly in this contract and
   * the host never mutates it.
   */
  candidates: z.optional(z.readonly(z.array(PluginUiSessionPlacementCandidateV1Schema).check(z.minLength(1)))),
  /**
   * Bounded by the composer's OWN instance ceiling rather than by a number
   * chosen here: a seed that carried more attachments than one composer can
   * hold would be refused by the document owner anyway, and a smaller bound
   * here would refuse a selection the composer could carry.
   *
   * Readonly by contract: the canonical producers build these from readonly
   * delivery plans and hand ownership of no array to the host. The host
   * consumes the seed read-only and freezes the parsed array.
   */
  attachments: z.optional(z.readonly(z.array(PluginUiNewSessionSeedAttachmentV1Schema).check(z.minLength(1), z.maxLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)))),
}).check(z.refine(seed => (seed.attachments?.length ?? 0) + (seed.currentUiContext ? 1 : 0) <= MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
  { message: 'Seeded attachments must fit the Composer attachment instance contract.' })));
export type PluginUiNewSessionSeedV1 = z.infer<typeof PluginUiNewSessionSeedV1Schema>;

const SessionNewSessionSeedFailureV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('invalid'), reason: z.enum([
    'seed_invalid', 'seed_empty', 'seed_attachments_uncredited',
  ]) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum([
    'aborted', 'navigation_unavailable', 'prepared_review_workspace_unavailable', 'origin_unavailable',
  ]) }),
  z.strictObject({ kind: z.literal('stale'), reason: z.literal('host_retired') }),
]));

/** One settlement vocabulary for page and embedded New Session hosts. */
export const SessionNewSessionSeedOutcomeSchema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('opened'), dataId: z.nullable(z.string()), draftId: z.string().check(z.minLength(1)) }),
  SessionNewSessionSeedFailureV1Schema,
]));
export type SessionNewSessionSeedOutcome = z.infer<typeof SessionNewSessionSeedOutcomeSchema>;

export const SessionAuthoringOpenV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ seed: PluginUiNewSessionSeedV1Schema }),
  z.strictObject({ sourceSession: VoiceTrackedSessionAddressV1Schema }),
]));
export type SessionAuthoringOpenV1 = z.infer<typeof SessionAuthoringOpenV1Schema>;

/** The Action acknowledges an editable page draft, never a Session or a writable copy. */
export const SessionAuthoringOpenResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('opened'), draftId: z.string().check(z.minLength(1)), destination: z.literal('newSession') }),
  SessionNewSessionSeedFailureV1Schema,
  z.strictObject({ kind: z.literal('unavailable'), reason: z.literal('client_unavailable') }),
]));
export type SessionAuthoringOpenResultV1 = z.infer<typeof SessionAuthoringOpenResultV1Schema>;

/**
 * Open the incumbent New Session screen with one author-shaped handoff.
 *
 * This is deliberately a distinct semantic Host API operation. Input
 * selection remains no-invoke and never creates, persists, or navigates to a
 * Session draft as a side effect.
 */
export const PluginUiOpenNewSessionRequestV1Schema = PluginUiNewSessionSeedV1Schema;
export type PluginUiOpenNewSessionRequestV1 = z.infer<typeof PluginUiOpenNewSessionRequestV1Schema>;

/**
 * The source-neutral fact consumed after an admitted review-workspace
 * operation succeeds. The operation's feature protocol remains the owner of
 * every provider-specific result field; New Session reads only this projection.
 */
export const PluginUiPreparedReviewWorkspaceResultV1Schema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('prepared'),
  repositoryPath: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginUiPreparedReviewWorkspaceResultV1 = z.infer<
  typeof PluginUiPreparedReviewWorkspaceResultV1Schema
>;

export const PluginUiSelectActionInputHostRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    hostAction: PluginUiSelectActionInputSessionAddressHostActionV1Schema,
  }),
  z.strictObject({
    hostAction: PluginUiSelectActionInputSessionHostActionV1Schema,
    draft: zMini.optional(PluginUiJsonObjectV1Schema),
  }),
  z.strictObject({
    hostAction: PluginUiSelectActionInputReviewHostActionV1Schema,
    sessionId: z.string().check(z.minLength(1)),
    serverId: z.optional(z.string().check(z.minLength(1))),
    draft: z.strictObject({
      engineIds: ReviewStartInputSchema.shape.engineIds,
      instructions: ReviewStartInputSchema.shape.instructions,
    }),
  }),
]));
export type PluginUiSelectActionInputHostRequestV1 =
  z.infer<typeof PluginUiSelectActionInputHostRequestV1Schema>;

/**
 * This two-arm request stays closed: an admitted targeted operation retains
 * its existing contract, while host-owned selections have no Action handle
 * and therefore cannot acquire execution authority.
 */
export const PluginUiSelectActionInputRequestV1Schema = lazyZodSchema(() => z.union([
  PluginUiSelectActionInputTargetedRequestV1Schema,
  PluginUiSelectActionInputHostRequestV1Schema,
]));
export type PluginUiSelectActionInputRequestV1 =
  z.infer<typeof PluginUiSelectActionInputRequestV1Schema>;

const PluginUiSelectActionInputConnectedAccountV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('selected'),
    fieldPath: z.string().check(z.trim(), z.minLength(1)),
    ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }),
]));

const PluginUiSelectActionInputPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  connectedAccountLabel: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  machineDisplayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
}));

export const PluginUiSelectActionInputTargetedSubmittedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('submitted'),
  action: asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
  input: PluginUiJsonObjectV1Schema,
  selection: asProtocolZod(PluginTargetedContributionSelectionV1Schema),
  connectedAccount: PluginUiSelectActionInputConnectedAccountV1Schema,
  presentation: PluginUiSelectActionInputPresentationV1Schema,
}));
export type PluginUiSelectActionInputTargetedSubmittedV1 =
  z.infer<typeof PluginUiSelectActionInputTargetedSubmittedV1Schema>;

/** Session alone projects this no-invoke settlement. */
export const PluginUiSelectActionInputServerStartDraftV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('serverStartDraft'),
  draft: SessionServerStartSpawnDraftV1Schema,
}));
export type PluginUiSelectActionInputServerStartDraftV1 =
  z.infer<typeof PluginUiSelectActionInputServerStartDraftV1Schema>;

/** Credential selection only; the host admits the complete review input before settlement. */
const PluginUiSelectActionInputExecutionRunLaunchV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('executionRunLaunch'),
  input: z.strictObject({
    secretReferenceOverlay: ReviewStartInputSchema.shape.secretReferenceOverlay,
    teamCredentialModel: ReviewStartInputSchema.shape.teamCredentialModel,
    teamCredentialSessionBindingConsent: ReviewStartInputSchema.shape.teamCredentialSessionBindingConsent,
  }),
}));

/** Exact no-invoke settlements, targeted submission, or cancellation. */
export const PluginUiSelectActionInputResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sessionAddress'), session: ActionSessionAddressV1Schema }),
  PluginUiSelectActionInputTargetedSubmittedV1Schema,
  PluginUiSelectActionInputServerStartDraftV1Schema,
  PluginUiSelectActionInputExecutionRunLaunchV1Schema,
  z.strictObject({ kind: z.literal('cancelled') }),
]));
export type PluginUiSelectActionInputResultV1 =
  z.infer<typeof PluginUiSelectActionInputResultV1Schema>;

/**
 * A selector is a JSON-pointer-shaped reference into an already admitted
 * declarative document. It names no value itself; evaluating it remains the
 * declarative-document owner's job.
 */
export const PLUGIN_UI_DECLARATIVE_VALUE_PATH_MAX_UTF8_BYTES_V1 = 1_024;
export const PluginUiDeclarativeValuePathV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.superRefine((value, ctx) => {
  if (!value.startsWith('/')) {
    ctx.addIssue({
      code: "custom",
      message: 'Declarative UI value paths must be JSON-pointer-shaped absolute paths.',
    });
  }
  if (new TextEncoder().encode(value).byteLength > PLUGIN_UI_DECLARATIVE_VALUE_PATH_MAX_UTF8_BYTES_V1) {
    ctx.addIssue({
      code: "custom",
      message: `Declarative UI value path exceeds the ${PLUGIN_UI_DECLARATIVE_VALUE_PATH_MAX_UTF8_BYTES_V1}-byte UTF-8 limit.`,
    });
  }
})));
export type PluginUiDeclarativeValuePathV1 =
  z.infer<typeof PluginUiDeclarativeValuePathV1Schema>;

export const PluginUiDeclarativeOpenSurfaceSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  destination: asProtocolZod(PluginUiDestinationReferenceV1Schema),
  inputPath: z.optional(PluginUiDeclarativeValuePathV1Schema),
  subPathPath: z.optional(PluginUiDeclarativeValuePathV1Schema),
  instanceKeyPath: z.optional(PluginUiDeclarativeValuePathV1Schema),
}));
export type PluginUiDeclarativeOpenSurfaceSelectorV1 =
  z.infer<typeof PluginUiDeclarativeOpenSurfaceSelectorV1Schema>;

export const PluginUiDeclarativeExecuteActionSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  action: asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
  inputPath: z.optional(PluginUiDeclarativeValuePathV1Schema),
}));
export type PluginUiDeclarativeExecuteActionSelectorV1 =
  z.infer<typeof PluginUiDeclarativeExecuteActionSelectorV1Schema>;

export const PluginUiHostApiRequestEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  requestId: z.string().check(z.trim(), z.minLength(1)),
  surface: PluginUiSurfaceContextV1Schema,
  method: PluginUiHostApiRequestMethodV1Schema,
  payload: zMini.optional(PluginUiJsonValueV1Schema),
}));
export type PluginUiHostApiRequestEnvelopeV1 =
  z.infer<typeof PluginUiHostApiRequestEnvelopeV1Schema>;

/**
 * The one response boundary between a mounted host and its physical
 * transports. `kind`, rather than a member of author-controlled JSON, decides
 * whether a request succeeded or failed.
 */
export const PluginUiHostApiResponseEnvelopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    requestId: z.string().check(z.trim(), z.minLength(1)),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiRequestMethodV1Schema,
    kind: z.literal('result'),
    payload: PluginUiJsonValueV1Schema,
  }),
  z.strictObject({
    version: z.literal(1),
    requestId: z.string().check(z.trim(), z.minLength(1)),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiRequestMethodV1Schema,
    kind: z.literal('error'),
    payload: PluginUiHostApiErrorPayloadV1Schema,
  }),
  z.strictObject({
    version: z.literal(1),
    requestId: z.string().check(z.trim(), z.minLength(1)),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiRequestMethodV1Schema,
    kind: z.literal('ack'),
    payload: zMini.optional(PluginUiJsonValueV1Schema),
  }),
]));
export type PluginUiHostApiResponseEnvelopeV1 =
  z.infer<typeof PluginUiHostApiResponseEnvelopeV1Schema>;
