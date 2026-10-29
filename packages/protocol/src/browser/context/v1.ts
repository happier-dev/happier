import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { RuntimeActionIdV1Schema } from '../../actions/actionIds.js';
import { BrowserSemanticAdapterKindV1Schema } from '../adapters/kinds.js';
import {
  BrowserDiagnosticFidelityV1Schema,
  BrowserDiagnosticsElementSourceLocationV1Schema,
} from '../diagnostics/v1.js';
import {
  BrowserTargetDisplayV1Schema,
  BrowserViewTargetKindV1Schema,
} from '../target/v1.js';
import { BrowserEvidenceSessionMediaReferenceV1Schema } from '../recording/v1.js';
import { rejectUnsafeBrowserEgressKeys } from '../diagnostics/egress/keyRejection.js';
import { SessionImageMediaReferenceV1Schema } from '../../sessions/media/imageReferenceV1.js';
import { BrowserAutomationSecretFillRequestV1Schema } from '../automation/v1.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

/** Shared egress budget for context summaries and the snapshot's console projection. */
export const BROWSER_CONTEXT_SUMMARY_MAX_CHARS = 8192;

const CONTEXT_KEY_REJECTION_MESSAGE =
  'Browser context payloads must not contain inline bytes, secrets, storage values, or bodies.';

function rejectUnsafeBrowserContextKeys(value: unknown, context: z.core.$RefinementCtx): void {
  rejectUnsafeBrowserEgressKeys(value, context, { message: CONTEXT_KEY_REJECTION_MESSAGE });
}

export const BrowserContextKindV1Schema = lazyZodSchema(() => z.enum([
  'browserPageReference',
  'browserScreenshot',
  'browserTextSelection',
  'browserPageTextSummary',
  'browserDomSnapshotSummary',
  'browserSelectedElement',
  'browserAnnotation',
  'browserRecordingEvidence',
  'browserNetworkSummary',
  'browserConsoleSummary',
]));
export type BrowserContextKindV1 = z.infer<typeof BrowserContextKindV1Schema>;

export const BrowserContextLifecycleStateV1Schema = lazyZodSchema(() => z.enum([
  'available',
  'policyDenied',
  'sensitiveOrigin',
  'sensitiveFieldsPresent',
  'ephemeralOnly',
  'navigationStale',
  'adapterUnavailable',
  'captureFailed',
]));
export type BrowserContextLifecycleStateV1 = z.infer<typeof BrowserContextLifecycleStateV1Schema>;

export const BrowserContextRedactionLevelV1Schema = lazyZodSchema(() => z.enum([
  'none',
  'metadataOnly',
  'summaryOnly',
  'blocked',
]));
export type BrowserContextRedactionLevelV1 = z.infer<typeof BrowserContextRedactionLevelV1Schema>;

export const BrowserScreenshotMediaReferenceV1Schema = SessionImageMediaReferenceV1Schema;
export type BrowserScreenshotMediaReferenceV1 = z.infer<typeof BrowserScreenshotMediaReferenceV1Schema>;

const BrowserContextItemBaseV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    contextId: IdSchema,
    sourceViewId: IdSchema,
    sourceAdapterKind: BrowserSemanticAdapterKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    capturedAtMs: NonNegativeIntSchema,
    navigationGeneration: NonNegativeIntSchema,
    lifecycleState: BrowserContextLifecycleStateV1Schema,
    redactionLevel: BrowserContextRedactionLevelV1Schema,
    disabledReason: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }));

const PageReferenceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.literal('browserPageReference'),
  targetId: z.optional(IdSchema),
  targetKind: z.optional(BrowserViewTargetKindV1Schema),
  display: z.optional(BrowserTargetDisplayV1Schema),
  url: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4096))),
  title: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  faviconUrl: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4096))),
  origin: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
})));

const ScreenshotSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.literal('browserScreenshot'),
  media: BrowserScreenshotMediaReferenceV1Schema,
})));

const TextSelectionSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.literal('browserTextSelection'),
  text: z.string().check(z.maxLength(2048)),
  truncated: z._default(z.optional(z.boolean()), false),
})));

const SummarySchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.enum([
    'browserPageTextSummary',
    'browserDomSnapshotSummary',
    'browserNetworkSummary',
    'browserConsoleSummary',
  ]),
  summary: z.string().check(z.maxLength(BROWSER_CONTEXT_SUMMARY_MAX_CHARS)),
  truncated: z._default(z.optional(z.boolean()), false),
})));

const SelectedElementSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.literal('browserSelectedElement'),
  selectorPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(1024)),
  accessibleName: z.optional(z.string().check(z.maxLength(512))),
  rect: z.optional(z.strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number().check(z.nonnegative()),
      height: z.number().check(z.nonnegative()),
    })),
})));

export const BrowserAnnotationRectV1Schema = lazyZodSchema(() => z.strictObject({
    x: z.number(),
    y: z.number(),
    width: z.number().check(z.nonnegative()),
    height: z.number().check(z.nonnegative()),
  }));
export type BrowserAnnotationRectV1 = z.infer<typeof BrowserAnnotationRectV1Schema>;

const BrowserAnnotationElementTargetV1Schema = lazyZodSchema(() => z.strictObject({
      kind: z.literal('element'),
      selectorPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(1024)),
      accessibleName: z.optional(z.string().check(z.maxLength(512))),
      rect: z.optional(BrowserAnnotationRectV1Schema),
      /**
       * UB-7. The component that rendered the annotated element and the source file it came from,
       * when the engine can resolve them. An agent receiving this annotation gets the edit site,
       * not just the selector. Both are absent for non-React or production pages.
       */
      componentName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
      sourceLocation: z.optional(BrowserDiagnosticsElementSourceLocationV1Schema),
    }));

export const BrowserAnnotationTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
      kind: z.literal('region'),
      rect: BrowserAnnotationRectV1Schema,
    }),
  BrowserAnnotationElementTargetV1Schema,
]));
export type BrowserAnnotationTargetV1 = z.infer<typeof BrowserAnnotationTargetV1Schema>;

// Visual intent of an annotation: a redaction-safe, bounded label describing how the marked
// region/element should read (callout, highlight, redaction overlay, an arrow pointer, or a free
// freehand sketch). Never carries inline media bytes — the captured pixels live behind `media`.
export const BrowserAnnotationStyleIntentV1Schema = lazyZodSchema(() => z.enum([
  'callout',
  'highlight',
  'redaction',
  'arrow',
  'freeform',
]));
export type BrowserAnnotationStyleIntentV1 = z.infer<typeof BrowserAnnotationStyleIntentV1Schema>;

// A vector stroke overlaid on the annotation, expressed in normalized [0,1] media coordinates so it
// survives scaling and never embeds raw pixels. Bounded point count keeps the payload metadata-only.
const BrowserAnnotationStrokePointV1Schema = lazyZodSchema(() => z.strictObject({
    x: z.number().check(z.minimum(0), z.maximum(1)),
    y: z.number().check(z.minimum(0), z.maximum(1)),
  }));

export const BrowserAnnotationStrokeV1Schema = lazyZodSchema(() => z.strictObject({
    shape: z.enum(['freehand', 'line', 'arrow', 'rectangle', 'ellipse']),
    points: z.array(BrowserAnnotationStrokePointV1Schema).check(z.minLength(1), z.maxLength(512)),
    colorToken: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
    widthPx: z.optional(z.number().check(z.positive(), z.maximum(64))),
  }));
export type BrowserAnnotationStrokeV1 = z.infer<typeof BrowserAnnotationStrokeV1Schema>;

// Authoring uses CSS viewport coordinates; committed strokes above use normalized media points.
export const BrowserAnnotationDraftStrokeV1Schema = lazyZodSchema(() => z.strictObject({
  shape: BrowserAnnotationStrokeV1Schema.shape.shape,
  points: z.array(z.strictObject({ x: z.number(), y: z.number() })).check(z.minLength(1)),
  colorToken: BrowserAnnotationStrokeV1Schema.shape.colorToken,
  widthPx: BrowserAnnotationStrokeV1Schema.shape.widthPx,
}));
export type BrowserAnnotationDraftStrokeV1 = z.infer<typeof BrowserAnnotationDraftStrokeV1Schema>;

export const BrowserAnnotationDraftTargetV1Schema = lazyZodSchema(() => z.pick(
  BrowserAnnotationElementTargetV1Schema,
  { kind: true, selectorPath: true, accessibleName: true, rect: true },
));
export type BrowserAnnotationDraftTargetV1 = z.infer<typeof BrowserAnnotationDraftTargetV1Schema>;

export const BrowserAnnotationDraftMarkHandleV1Schema = lazyZodSchema(() => z.strictObject({
  draftId: IdSchema,
  kind: z.enum(['element', 'region', 'stroke']),
}));

const AnnotationSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.literal('browserAnnotation'),
  annotationId: IdSchema,
  browserSessionId: IdSchema,
  media: BrowserScreenshotMediaReferenceV1Schema,
  target: BrowserAnnotationTargetV1Schema,
  comment: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2048))),
  styleIntent: z.optional(BrowserAnnotationStyleIntentV1Schema),
  stroke: z.optional(BrowserAnnotationStrokeV1Schema),
  pageUrl: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4096))),
  pageTitle: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
})));

const BrowserContextAnnotationStructuredElementV1Schema = lazyZodSchema(() => z.strictObject({
    selectorPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(1024)),
    accessibleName: z.optional(z.string().check(z.maxLength(512))),
    rect: z.optional(BrowserAnnotationRectV1Schema),
  }));

const BrowserContextAnnotationStructuredRegionV1Schema = lazyZodSchema(() => z.strictObject({
    rect: BrowserAnnotationRectV1Schema,
  }));

const BrowserContextAnnotationStructuredScreenshotV1Schema = lazyZodSchema(() => z.strictObject({
    media: z.array(BrowserScreenshotMediaReferenceV1Schema).check(z.minLength(1), z.maxLength(8)),
    cropRect: z.optional(BrowserAnnotationRectV1Schema),
  }));

export const BrowserContextAnnotationStructuredBlockV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    kind: z.literal('browser.annotation.v1'),
    annotationId: IdSchema,
    sourceViewId: IdSchema,
    browserSessionId: z.optional(IdSchema),
    contextIds: z.array(IdSchema).check(z.minLength(1), z.maxLength(128)),
    elements: z.array(BrowserContextAnnotationStructuredElementV1Schema).check(z.maxLength(64)),
    regions: z.array(BrowserContextAnnotationStructuredRegionV1Schema).check(z.maxLength(64)),
    strokes: z.array(BrowserAnnotationStrokeV1Schema).check(z.maxLength(64)),
    comment: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2048))),
    screenshot: BrowserContextAnnotationStructuredScreenshotV1Schema,
    pageUrl: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4096))),
    pageTitle: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  }).check(z.superRefine((block, context) => {
    rejectUnsafeBrowserContextKeys(block, context);
  })));
export type BrowserContextAnnotationStructuredBlockV1 = z.infer<
  typeof BrowserContextAnnotationStructuredBlockV1Schema
>;

const RecordingEvidenceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(BrowserContextItemBaseV1Schema, {
  kind: z.literal('browserRecordingEvidence'),
  recordingId: IdSchema,
  artifactId: IdSchema,
  mediaRef: BrowserEvidenceSessionMediaReferenceV1Schema,
  sourceNavigationGenerationRange: z.strictObject({
      start: NonNegativeIntSchema,
      end: z.optional(NonNegativeIntSchema),
    }),
  actionChapterRefs: z._default(z.optional(z.array(IdSchema)), []),
})).check(z.superRefine((item, context) => {
  if (
    item.sourceNavigationGenerationRange.end != null
    && item.sourceNavigationGenerationRange.end < item.sourceNavigationGenerationRange.start
  ) {
    context.addIssue({
      code: "custom",
      path: ['sourceNavigationGenerationRange', 'end'],
      message: 'Recording evidence navigation range end must not be before start.',
    });
  }
})));

// ── BA-2 combined rich agent snapshot ───────────────────────────────────────────────────────────
// A single context op that bundles the pieces an agent needs to act on a page in ONE round-trip:
// the accessibility tree, an interactive-element list with synthesized selectors + layout rects, the
// visible text, a console summary, and a screenshot reference. Modeled as a STANDALONE schema (not a
// `BrowserContextItem` discriminated-union member) so it never ripples the per-item consumers; it is
// the return shape of `BrowserContextRoutes.captureSnapshot`. Every collection is bounded and every
// string capped so a hostile/huge DOM can never produce an unbounded payload. Per the LANE-B egress
// model the daemon route returns FULL fidelity to the local owner (`redactionLevel: 'none'`); the
// agent/cloud egress chokepoint redacts before the payload leaves the device.
const BrowserContextSnapshotRectV1Schema = lazyZodSchema(() => z.strictObject({
    x: z.number(),
    y: z.number(),
    width: z.number().check(z.nonnegative()),
    height: z.number().check(z.nonnegative()),
  }));

export const BrowserContextSnapshotAxNodeV1Schema = lazyZodSchema(() => z.strictObject({
    role: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    name: z.optional(z.string().check(z.maxLength(256))),
    /** Current non-secret editable text, under the existing per-node text budget. */
    value: z.optional(z.string().check(z.maxLength(256))),
  }));
export type BrowserContextSnapshotAxNodeV1 = z.infer<typeof BrowserContextSnapshotAxNodeV1Schema>;

export const BrowserContextSnapshotInteractiveElementV1Schema = lazyZodSchema(() => z.strictObject({
    role: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    name: z.optional(z.string().check(z.maxLength(256))),
    selector: z.string().check(z.trim(), z.minLength(1), z.maxLength(1024)),
    rect: BrowserContextSnapshotRectV1Schema,
  }));
export type BrowserContextSnapshotInteractiveElementV1 = z.infer<
  typeof BrowserContextSnapshotInteractiveElementV1Schema
>;

const SNAPSHOT_AX_NODE_CAP = 512;
const SNAPSHOT_INTERACTIVE_CAP = 512;

/** Value-free browser proof; scope and human choice still belong to confidential admission. */
export const BrowserFocusedCredentialTargetV1Schema = lazyZodSchema(() => z.pick(BrowserAutomationSecretFillRequestV1Schema, {
  browserSessionId: true, viewId: true, tabId: true, frameId: true, documentId: true,
  navigationGeneration: true, origin: true, field: true,
}));
export type BrowserFocusedCredentialTargetV1 = z.infer<typeof BrowserFocusedCredentialTargetV1Schema>;

export const BrowserContextSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    contextId: IdSchema,
    sourceViewId: IdSchema,
    sourceAdapterKind: BrowserSemanticAdapterKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    capturedAtMs: NonNegativeIntSchema,
    navigationGeneration: NonNegativeIntSchema,
    redactionLevel: BrowserContextRedactionLevelV1Schema,
    url: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4096))),
    title: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    media: z.optional(BrowserScreenshotMediaReferenceV1Schema),
    visibleText: z.string().check(z.maxLength(16_384)),
    visibleTextTruncated: z._default(z.optional(z.boolean()), false),
    axNodes: z.array(BrowserContextSnapshotAxNodeV1Schema).check(z.maxLength(SNAPSHOT_AX_NODE_CAP)),
    axNodesTruncated: z._default(z.optional(z.boolean()), false),
    interactiveElements: z
      .array(BrowserContextSnapshotInteractiveElementV1Schema).check(z.maxLength(SNAPSHOT_INTERACTIVE_CAP)),
    interactiveElementsTruncated: z._default(z.optional(z.boolean()), false),
    consoleSummary: z.optional(z.string().check(z.maxLength(BROWSER_CONTEXT_SUMMARY_MAX_CHARS))),
    consoleTruncated: z._default(z.optional(z.boolean()), false),
    focusedCredentialTarget: z.optional(BrowserFocusedCredentialTargetV1Schema),
  }).check(z.superRefine((snapshot, context) => {
    rejectUnsafeBrowserContextKeys(snapshot, context);
  })));
export type BrowserContextSnapshotV1 = z.infer<typeof BrowserContextSnapshotV1Schema>;

export const BrowserContextItemV1Schema = lazyZodSchema(() => z
  .discriminatedUnion('kind', [
    PageReferenceSchema,
    ScreenshotSchema,
    TextSelectionSchema,
    SummarySchema,
    SelectedElementSchema,
    AnnotationSchema,
    RecordingEvidenceSchema,
  ]).check(z.superRefine((item, context) => {
    rejectUnsafeBrowserContextKeys(item, context);

    if (item.lifecycleState !== 'available' && !item.disabledReason) {
      context.addIssue({
        code: "custom",
        path: ['disabledReason'],
        message: 'Non-available browser context states must include a disabled reason.',
      });
    }

    if (
      (item.kind === 'browserScreenshot'
        || item.kind === 'browserAnnotation'
        || item.kind === 'browserRecordingEvidence')
      && item.lifecycleState !== 'available'
    ) {
      context.addIssue({
        code: "custom",
        path: ['media'],
        message: 'Blocked media-backed browser context must not include captured media.',
      });
    }
  })));
export type BrowserContextItemV1 = z.infer<typeof BrowserContextItemV1Schema>;

export const BrowserContextCommandV1Schema = lazyZodSchema(() => z.enum([
  'captureScreenshot',
  'capturePageContext',
  'captureSelectedElement',
  'captureNetworkSummary',
  'captureConsoleSummary',
  'startAnnotation',
  'cancelAnnotation',
  'captureAnnotationRegion',
  'captureAnnotationElement',
  'attachAnnotationComment',
  'attachAnnotationStroke',
  'attachAnnotationStyleIntent',
  'attachToComposer',
  'attachToAgentTurn',
  'clearCapturedContext',
]));
export type BrowserContextCommandV1 = z.infer<typeof BrowserContextCommandV1Schema>;

export const BrowserContextEventV1Schema = lazyZodSchema(() => z.enum([
  'contextCaptureStarted',
  'contextCaptureFinished',
  'contextCaptureFailed',
  'contextAttachmentAdded',
  'contextAttachmentRemoved',
  'contextUnavailable',
  'contextPolicyDenied',
  'annotationStarted',
  'annotationCanceled',
  'annotationCaptured',
  'annotationCommentAttached',
]));
export type BrowserContextEventV1 = z.infer<typeof BrowserContextEventV1Schema>;

const BrowserContextAnnotationRuntimeActionIdV1Schema = lazyZodSchema(() => RuntimeActionIdV1Schema.check(z.refine((value) => value.startsWith('browser.context.annotation.'))));

export const BrowserContextAnnotationActionResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    actionId: BrowserContextAnnotationRuntimeActionIdV1Schema,
    status: z.enum(['started', 'cancelled', 'captured', 'updated']),
    contextId: z.optional(IdSchema),
    attachmentId: z.optional(IdSchema),
  }));
export type BrowserContextAnnotationActionResultV1 = z.infer<
  typeof BrowserContextAnnotationActionResultV1Schema
>;

export const BrowserContextAttachmentV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    attachmentId: IdSchema,
    contextId: IdSchema,
    sourceViewId: IdSchema,
    capturedNavigationGeneration: NonNegativeIntSchema,
    currentNavigationGeneration: NonNegativeIntSchema,
    state: BrowserContextLifecycleStateV1Schema,
    requiresReconfirmBeforeSend: z._default(z.optional(z.boolean()), false),
    structuredBlock: z.optional(BrowserContextAnnotationStructuredBlockV1Schema),
  }).check(z.superRefine((attachment, context) => {
    if (attachment.currentNavigationGeneration !== attachment.capturedNavigationGeneration) {
      if (attachment.state !== 'navigationStale' || !attachment.requiresReconfirmBeforeSend) {
        context.addIssue({
          code: "custom",
          path: ['state'],
          message: 'Context captured before the current navigation must be marked navigationStale before send.',
        });
      }
    }
  })));
export type BrowserContextAttachmentV1 = z.infer<typeof BrowserContextAttachmentV1Schema>;

/** The selected, agent-bound projection; capture/grouping/redaction remain producer-owned. */
export const BrowserContextMessagePayloadV1Schema = lazyZodSchema(() => z.strictObject({
  contexts: z.array(BrowserContextItemV1Schema).check(z.minLength(1)),
  attachments: z.array(BrowserContextAttachmentV1Schema).check(z.minLength(1)),
}).check(z.superRefine((value, context) => {
  const byId = new Map(value.contexts.map((item) => [item.contextId, item]));
  const selected = new Set<string>();
  if (byId.size !== value.contexts.length) {
    context.addIssue({ code: 'custom', message: 'Browser context identities must be unique.' });
  }
  for (const attachment of value.attachments) {
    const ids = new Set([attachment.contextId, ...(attachment.structuredBlock?.contextIds ?? [])]);
    for (const id of ids) {
      selected.add(id);
      const item = byId.get(id);
      if (!item || item.sourceViewId !== attachment.sourceViewId
        || item.navigationGeneration !== attachment.capturedNavigationGeneration
        || item.lifecycleState !== 'available' || item.redactionLevel === 'blocked' || item.redactionLevel === 'none') {
        context.addIssue({ code: 'custom', message: 'Browser context selection is unavailable or uncorrelated.' });
      }
    }
    if (attachment.state !== 'available' || attachment.requiresReconfirmBeforeSend
      || attachment.currentNavigationGeneration !== attachment.capturedNavigationGeneration
      || !byId.has(attachment.contextId)) {
      context.addIssue({ code: 'custom', message: 'Browser context attachment is unavailable or stale.' });
    }
  }
  if ([...byId.keys()].some((id) => !selected.has(id))) {
    context.addIssue({ code: 'custom', message: 'Browser context must be explicitly selected.' });
  }
})));
export type BrowserContextMessagePayloadV1 = z.infer<typeof BrowserContextMessagePayloadV1Schema>;

export const BrowserContextMessageMetaV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('browser_context.v1'),
  payload: BrowserContextMessagePayloadV1Schema,
}));

export const BrowserContextRouteFailureV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_parameters', 'runtime_action_disabled']),
    error: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  }));
export type BrowserContextRouteFailureV1 = z.infer<typeof BrowserContextRouteFailureV1Schema>;

export const BrowserContextRouteResultV1Schema = lazyZodSchema(() => z.union([
  BrowserContextItemV1Schema,
  z.array(BrowserContextItemV1Schema),
  BrowserContextAnnotationActionResultV1Schema,
  BrowserContextAttachmentV1Schema,
  BrowserContextRouteFailureV1Schema,
]));
export type BrowserContextRouteResultV1 = z.infer<typeof BrowserContextRouteResultV1Schema>;

export const DaemonBrowserContextDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: IdSchema,
    actionId: RuntimeActionIdV1Schema,
    input: z.unknown(),
  }));
export type DaemonBrowserContextDispatchRequestV1 = z.infer<
  typeof DaemonBrowserContextDispatchRequestV1Schema
>;

export const DaemonBrowserContextDispatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: BrowserContextRouteResultV1Schema,
  }));
export type DaemonBrowserContextDispatchResponseV1 = z.infer<
  typeof DaemonBrowserContextDispatchResponseV1Schema
>;
