import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
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
  normalizePluginUiSubPathV1,
} from './semanticCommands.js';
import { PluginUiSurfaceContextV1Schema } from './surfaceContext.js';
import { PluginUiContextEnrichmentV1Schema } from './currentUiContext.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import {
    PluginTargetedContributionSelectionV1Schema,
    PluginUiTargetedContributionOperationV1Schema,
} from './targetedContributions.js';
import { SessionServerStartSpawnDraftV1Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';

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

export const PluginUiHostApiErrorCodeV1Schema = z.enum([
  'unavailable',
  'denied',
  'invalid_payload',
  'unsupported_method',
  'stale_surface',
  'expired_resource',
  'timeout',
  'internal_error',
]);
export type PluginUiHostApiErrorCodeV1 =
  z.infer<typeof PluginUiHostApiErrorCodeV1Schema>;

/**
 * A typed mounted-host failure. This is distinct from an Action result: plugin
 * Action JSON is allowed to carry a `code` member with the same spelling.
 */
export const PluginUiHostApiErrorPayloadV1Schema = z.object({
  code: PluginUiHostApiErrorCodeV1Schema,
  message: z.string().trim().min(1).optional(),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiHostApiErrorPayloadV1 =
  z.infer<typeof PluginUiHostApiErrorPayloadV1Schema>;

/**
 * One mount-bound replacement or clear of the caller's semantic current-UI
 * enrichment. The mounted host owns identity binding and opaque command-handle
 * allocation; the author can only send closed semantic data or clear it.
 */
export const PluginUiPublishCurrentUiContextRequestV1Schema = z.object({
  enrichment: PluginUiContextEnrichmentV1Schema.nullable(),
}).strict();
export type PluginUiPublishCurrentUiContextRequestV1 =
  z.infer<typeof PluginUiPublishCurrentUiContextRequestV1Schema>;

const ComposerRefV1ZodSchema = asProtocolZod(ComposerRefV1Schema);

/** `activeComposer` has no request payload; an absent focused composer is null. */
export const PluginUiActiveComposerResultV1Schema = ComposerRefV1ZodSchema.nullable();
export type PluginUiActiveComposerResultV1 =
  z.infer<typeof PluginUiActiveComposerResultV1Schema>;

export const PluginUiReadComposerRequestV1Schema = z.object({
  ref: ComposerRefV1ZodSchema,
}).strict();
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

export const PluginUiApplyComposerRequestV1Schema = z.object({
  ref: ComposerRefV1ZodSchema,
  transaction: ComposerTransactionV1Schema,
}).strict();
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

export const PluginUiSetComposerDecorationsRequestV1Schema = z.object({
  ref: ComposerRefV1ZodSchema,
  key: z.string().trim().min(1),
  decorations: ComposerDecorationSetV1Schema.nullable(),
}).strict();
export type PluginUiSetComposerDecorationsRequestV1 =
  z.infer<typeof PluginUiSetComposerDecorationsRequestV1Schema>;
export const PluginUiSetComposerDecorationsResultV1Schema = ComposerDecorationResultV1Schema;
export type PluginUiSetComposerDecorationsResultV1 =
  z.infer<typeof PluginUiSetComposerDecorationsResultV1Schema>;

export const PluginUiAcquireComposerInputLockRequestV1Schema = z.object({
  ref: ComposerRefV1ZodSchema,
  request: ComposerInputLockRequestV1Schema,
}).strict();
export type PluginUiAcquireComposerInputLockRequestV1 =
  z.infer<typeof PluginUiAcquireComposerInputLockRequestV1Schema>;

/** Selection is host-bound to the exact Composer and mounted contribution. */
export const PluginUiPickComposerMediaRequestV1Schema = z.object({
  ref: ComposerRefV1ZodSchema,
  request: ComposerContentPickMediaRequestV1Schema,
}).strict();
export type PluginUiPickComposerMediaRequestV1 =
  z.infer<typeof PluginUiPickComposerMediaRequestV1Schema>;
export const PluginUiPickComposerMediaResultV1Schema = ComposerContentHandleV1Schema;
export type PluginUiPickComposerMediaResultV1 =
  z.infer<typeof PluginUiPickComposerMediaResultV1Schema>;

/** Inspection reads bounded bytes through the incumbent transfer carrier, never a path or transfer session. */
export const PluginUiInspectComposerContentRequestV1Schema = z.object({
  handle: ComposerContentHandleV1Schema,
  request: ComposerContentInspectRequestV1Schema,
}).strict();
export type PluginUiInspectComposerContentRequestV1 =
  z.infer<typeof PluginUiInspectComposerContentRequestV1Schema>;
export const PluginUiInspectComposerContentResultV1Schema = ComposerContentInspectWireResultV1Schema;
export type PluginUiInspectComposerContentResultV1 =
  z.infer<typeof PluginUiInspectComposerContentResultV1Schema>;

/** Release is idempotent at the transfer-owned stage owner; callers carry only the opaque claim. */
export const PluginUiReleaseComposerContentRequestV1Schema = z.object({
  handle: ComposerContentHandleV1Schema,
}).strict();
export type PluginUiReleaseComposerContentRequestV1 =
  z.infer<typeof PluginUiReleaseComposerContentRequestV1Schema>;

/**
 * Diagnostic data is part of the public mounted Host API, not a daemon-only
 * introspection record. Keep this grammar beside the request vocabulary so the
 * wire error envelope, mounted UI host, and SDK fixture all decode the exact
 * same author payload.
 */
const PluginUiHostApiDiagnosticContributionRefV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  localId: z.string().trim().min(1),
}).strict();
export const PluginUiHostApiDiagnosticRemediationV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry') }).strict(),
  z.object({ kind: z.literal('openSettings'), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('selectAccount'), service: PluginUiHostApiDiagnosticContributionRefV1Schema }).strict(),
  z.object({ kind: z.literal('installDependency'), dependencyId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('openUrl'), url: z.string().trim().min(1) }).strict(),
]);
export type PluginUiHostApiDiagnosticRemediationV1 =
  z.infer<typeof PluginUiHostApiDiagnosticRemediationV1Schema>;

/** A plugin diagnostic must remain bounded before a mounted host logs it. */
export const PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1 = 8 * 1024;
export const PluginUiHostApiDiagnosticV1Schema = z.object({
  code: z.string().trim().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().optional(),
  details: PluginUiJsonValueV1Schema.optional(),
  remediation: PluginUiHostApiDiagnosticRemediationV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (
    measureSerializedStrictPluginJsonUtf8Bytes(
      value,
      'diagnostic',
      PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1,
    )
    > PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Plugin UI diagnostic exceeds the ${PLUGIN_UI_HOST_API_DIAGNOSTIC_MAX_UTF8_BYTES_V1}-byte UTF-8 limit.`,
    });
  }
});
export type PluginUiHostApiDiagnosticV1 =
  z.infer<typeof PluginUiHostApiDiagnosticV1Schema>;

/** The public utility-effect payloads remain strict even though their effects are host-owned. */
export const PluginUiHostApiWriteClipboardRequestV1Schema = z.object({
  value: z.string(),
}).strict();
export type PluginUiHostApiWriteClipboardRequestV1 =
  z.infer<typeof PluginUiHostApiWriteClipboardRequestV1Schema>;

export const PluginUiHostApiOpenExternalLinkRequestV1Schema = z.object({
  url: z.string(),
}).strict();
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
const PluginUiMountedBareActionReferenceV1Schema = z.string().refine(
  (value) => value.trim().length > 0,
  'Mounted Action references must not be blank.',
);
export const PluginUiMountedActionReferenceV1Schema = z.union([
  PluginUiMountedBareActionReferenceV1Schema,
  asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
]);
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
  const parsed = z.object({
    callerPluginId: asProtocolZod(PluginIdSchema),
    action: PluginUiMountedActionReferenceV1Schema,
  }).strict().safeParse(input);
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
export const PluginUiOpenSurfaceRequestV1Schema = z.object({
  destination: asProtocolZod(PluginUiDestinationReferenceV1Schema),
  input: PluginUiLaunchInputV1Schema.optional(),
  subPath: PluginUiSubPathV1Schema.optional(),
  instanceKey: PluginUiInstanceKeyV1Schema.optional(),
}).strict();
export type PluginUiOpenSurfaceRequestV1 =
  z.infer<typeof PluginUiOpenSurfaceRequestV1Schema>;

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
export const PluginUiReplacePageLocationRequestV1Schema = z.object({
  subPath: PluginUiSubPathV1Schema,
  backLocation: PluginUiSubPathV1Schema.optional(),
}).strict();
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
export const PluginUiReplacePageLocationResultV1Schema = z.object({
  subPath: PluginUiSubPathV1Schema,
}).strict();
export type PluginUiReplacePageLocationResultV1 =
  z.infer<typeof PluginUiReplacePageLocationResultV1Schema>;

/** Action dispatch is distinct from navigation and has no destination arm. */
export const PluginUiExecuteActionRequestV1Schema = z.object({
  action: PluginUiMountedActionReferenceV1Schema,
  input: PluginUiLaunchInputV1Schema.optional(),
}).strict();
export type PluginUiExecuteActionRequestV1 =
  z.infer<typeof PluginUiExecuteActionRequestV1Schema>;

export type PluginUiJsonObjectV1 = { readonly [key: string]: PluginUiJsonValueV1 };

/** Selection values share the incumbent bounded host-input JSON boundary. */
export const PluginUiJsonObjectV1Schema = PluginUiLaunchInputV1Schema.refine(
  (value): value is PluginUiJsonObjectV1 => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  ),
  'Action input selection values must be JSON objects.',
);

/**
 * No-invoke selection names one exact operation already admitted into the
 * mounted target's Host API context. The host matches this JSON value back
 * to that snapshot; it does not treat the request as caller provenance or an
 * arbitrary Action lookup.
 */
export const PluginUiSelectActionInputTargetedRequestV1Schema = z.object({
    operation: PluginUiTargetedContributionOperationV1Schema,
    draft: PluginUiJsonObjectV1Schema.optional(),
}).strict();
export type PluginUiSelectActionInputTargetedRequestV1 =
  z.infer<typeof PluginUiSelectActionInputTargetedRequestV1Schema>;

/** The only host-owned no-invoke selection literal. */
export const PluginUiSelectActionInputHostActionV1Schema = z.object({
  action: z.literal('session.spawn_new'),
  projection: z.literal('serverStartDraft'),
}).strict();
export type PluginUiSelectActionInputHostActionV1 =
  z.infer<typeof PluginUiSelectActionInputHostActionV1Schema>;

export const PluginUiSelectActionInputHostRequestV1Schema = z.object({
  hostAction: PluginUiSelectActionInputHostActionV1Schema,
  draft: PluginUiJsonObjectV1Schema.optional(),
}).strict();
export type PluginUiSelectActionInputHostRequestV1 =
  z.infer<typeof PluginUiSelectActionInputHostRequestV1Schema>;

/**
 * This two-arm request stays closed: an admitted targeted operation retains
 * its existing contract, while the literal Session arm has no Action handle
 * and therefore cannot acquire execution authority.
 */
export const PluginUiSelectActionInputRequestV1Schema = z.union([
  PluginUiSelectActionInputTargetedRequestV1Schema,
  PluginUiSelectActionInputHostRequestV1Schema,
]);
export type PluginUiSelectActionInputRequestV1 =
  z.infer<typeof PluginUiSelectActionInputRequestV1Schema>;

const PluginUiSelectActionInputConnectedAccountV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('selected'),
    fieldPath: z.string().trim().min(1),
    ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }).strict(),
]);

export const PluginUiSelectActionInputTargetedSubmittedV1Schema = z.object({
  kind: z.literal('submitted'),
  action: asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
  input: PluginUiJsonObjectV1Schema,
  selection: asProtocolZod(PluginTargetedContributionSelectionV1Schema),
  connectedAccount: PluginUiSelectActionInputConnectedAccountV1Schema,
}).strict();
export type PluginUiSelectActionInputTargetedSubmittedV1 =
  z.infer<typeof PluginUiSelectActionInputTargetedSubmittedV1Schema>;

/** Session alone projects this no-invoke settlement. */
export const PluginUiSelectActionInputServerStartDraftV1Schema = z.object({
  kind: z.literal('serverStartDraft'),
  draft: SessionServerStartSpawnDraftV1Schema,
}).strict();
export type PluginUiSelectActionInputServerStartDraftV1 =
  z.infer<typeof PluginUiSelectActionInputServerStartDraftV1Schema>;

/** The only successful settlements: targeted submission, Session draft, or cancellation. */
export const PluginUiSelectActionInputResultV1Schema = z.discriminatedUnion('kind', [
  PluginUiSelectActionInputTargetedSubmittedV1Schema,
  PluginUiSelectActionInputServerStartDraftV1Schema,
  z.object({ kind: z.literal('cancelled') }).strict(),
]);
export type PluginUiSelectActionInputResultV1 =
  z.infer<typeof PluginUiSelectActionInputResultV1Schema>;

/**
 * A selector is a JSON-pointer-shaped reference into an already admitted
 * declarative document. It names no value itself; evaluating it remains the
 * declarative-document owner's job.
 */
export const PLUGIN_UI_DECLARATIVE_VALUE_PATH_MAX_UTF8_BYTES_V1 = 1_024;
export const PluginUiDeclarativeValuePathV1Schema = z.string().trim().min(1).superRefine((value, ctx) => {
  if (!value.startsWith('/')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Declarative UI value paths must be JSON-pointer-shaped absolute paths.',
    });
  }
  if (new TextEncoder().encode(value).byteLength > PLUGIN_UI_DECLARATIVE_VALUE_PATH_MAX_UTF8_BYTES_V1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Declarative UI value path exceeds the ${PLUGIN_UI_DECLARATIVE_VALUE_PATH_MAX_UTF8_BYTES_V1}-byte UTF-8 limit.`,
    });
  }
});
export type PluginUiDeclarativeValuePathV1 =
  z.infer<typeof PluginUiDeclarativeValuePathV1Schema>;

export const PluginUiDeclarativeOpenSurfaceSelectorV1Schema = z.object({
  destination: asProtocolZod(PluginUiDestinationReferenceV1Schema),
  inputPath: PluginUiDeclarativeValuePathV1Schema.optional(),
  subPathPath: PluginUiDeclarativeValuePathV1Schema.optional(),
  instanceKeyPath: PluginUiDeclarativeValuePathV1Schema.optional(),
}).strict();
export type PluginUiDeclarativeOpenSurfaceSelectorV1 =
  z.infer<typeof PluginUiDeclarativeOpenSurfaceSelectorV1Schema>;

export const PluginUiDeclarativeExecuteActionSelectorV1Schema = z.object({
  action: asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
  inputPath: PluginUiDeclarativeValuePathV1Schema.optional(),
}).strict();
export type PluginUiDeclarativeExecuteActionSelectorV1 =
  z.infer<typeof PluginUiDeclarativeExecuteActionSelectorV1Schema>;

export const PluginUiHostApiRequestEnvelopeV1Schema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  surface: PluginUiSurfaceContextV1Schema,
  method: PluginUiHostApiRequestMethodV1Schema,
  payload: PluginUiJsonValueV1Schema.optional(),
}).strict();
export type PluginUiHostApiRequestEnvelopeV1 =
  z.infer<typeof PluginUiHostApiRequestEnvelopeV1Schema>;

/**
 * The one response boundary between a mounted host and its physical
 * transports. `kind`, rather than a member of author-controlled JSON, decides
 * whether a request succeeded or failed.
 */
export const PluginUiHostApiResponseEnvelopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    requestId: z.string().trim().min(1),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiRequestMethodV1Schema,
    kind: z.literal('result'),
    payload: PluginUiJsonValueV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    requestId: z.string().trim().min(1),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiRequestMethodV1Schema,
    kind: z.literal('error'),
    payload: PluginUiHostApiErrorPayloadV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    requestId: z.string().trim().min(1),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiRequestMethodV1Schema,
    kind: z.literal('ack'),
    payload: PluginUiJsonValueV1Schema.optional(),
  }).strict(),
]);
export type PluginUiHostApiResponseEnvelopeV1 =
  z.infer<typeof PluginUiHostApiResponseEnvelopeV1Schema>;
