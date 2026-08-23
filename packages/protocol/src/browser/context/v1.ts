import { z } from 'zod';

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

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();

const CONTEXT_KEY_REJECTION_MESSAGE =
  'Browser context payloads must not contain inline bytes, secrets, storage values, or bodies.';

function rejectUnsafeBrowserContextKeys(value: unknown, context: z.RefinementCtx): void {
  rejectUnsafeBrowserEgressKeys(value, context, { message: CONTEXT_KEY_REJECTION_MESSAGE });
}

export const BrowserContextKindV1Schema = z.enum([
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
]);
export type BrowserContextKindV1 = z.infer<typeof BrowserContextKindV1Schema>;

export const BrowserContextLifecycleStateV1Schema = z.enum([
  'available',
  'policyDenied',
  'sensitiveOrigin',
  'sensitiveFieldsPresent',
  'ephemeralOnly',
  'navigationStale',
  'adapterUnavailable',
  'captureFailed',
]);
export type BrowserContextLifecycleStateV1 = z.infer<typeof BrowserContextLifecycleStateV1Schema>;

export const BrowserContextRedactionLevelV1Schema = z.enum([
  'none',
  'metadataOnly',
  'summaryOnly',
  'blocked',
]);
export type BrowserContextRedactionLevelV1 = z.infer<typeof BrowserContextRedactionLevelV1Schema>;

export const BrowserScreenshotMediaReferenceV1Schema = z
  .object({
    mediaId: IdSchema,
    mediaKind: z.literal('image'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type BrowserScreenshotMediaReferenceV1 = z.infer<typeof BrowserScreenshotMediaReferenceV1Schema>;

const BrowserContextItemBaseV1Schema = z
  .object({
    v: z.literal(1),
    contextId: IdSchema,
    sourceViewId: IdSchema,
    sourceAdapterKind: BrowserSemanticAdapterKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    capturedAtMs: NonNegativeIntSchema,
    navigationGeneration: NonNegativeIntSchema,
    lifecycleState: BrowserContextLifecycleStateV1Schema,
    redactionLevel: BrowserContextRedactionLevelV1Schema,
    disabledReason: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const PageReferenceSchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.literal('browserPageReference'),
  targetId: IdSchema.optional(),
  targetKind: BrowserViewTargetKindV1Schema.optional(),
  display: BrowserTargetDisplayV1Schema.optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  title: z.string().trim().min(1).max(512).optional(),
  faviconUrl: z.string().trim().min(1).max(4096).optional(),
  origin: z.string().trim().min(1).max(512).optional(),
}).strict();

const ScreenshotSchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.literal('browserScreenshot'),
  media: BrowserScreenshotMediaReferenceV1Schema,
}).strict();

const TextSelectionSchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.literal('browserTextSelection'),
  text: z.string().max(2048),
  truncated: z.boolean().optional().default(false),
}).strict();

const SummarySchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.enum([
    'browserPageTextSummary',
    'browserDomSnapshotSummary',
    'browserNetworkSummary',
    'browserConsoleSummary',
  ]),
  summary: z.string().max(8192),
  truncated: z.boolean().optional().default(false),
}).strict();

const SelectedElementSchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.literal('browserSelectedElement'),
  selectorPath: z.string().trim().min(1).max(1024),
  accessibleName: z.string().max(512).optional(),
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().nonnegative(),
      height: z.number().nonnegative(),
    })
    .strict()
    .optional(),
}).strict();

const BrowserAnnotationRectV1Schema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();
export type BrowserAnnotationRectV1 = z.infer<typeof BrowserAnnotationRectV1Schema>;

export const BrowserAnnotationTargetV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('region'),
      rect: BrowserAnnotationRectV1Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('element'),
      selectorPath: z.string().trim().min(1).max(1024),
      accessibleName: z.string().max(512).optional(),
      rect: BrowserAnnotationRectV1Schema.optional(),
      /**
       * UB-7. The component that rendered the annotated element and the source file it came from,
       * when the engine can resolve them. An agent receiving this annotation gets the edit site,
       * not just the selector. Both are absent for non-React or production pages.
       */
      componentName: z.string().trim().min(1).max(128).optional(),
      sourceLocation: BrowserDiagnosticsElementSourceLocationV1Schema.optional(),
    })
    .strict(),
]);
export type BrowserAnnotationTargetV1 = z.infer<typeof BrowserAnnotationTargetV1Schema>;

// Visual intent of an annotation: a redaction-safe, bounded label describing how the marked
// region/element should read (callout, highlight, redaction overlay, an arrow pointer, or a free
// freehand sketch). Never carries inline media bytes — the captured pixels live behind `media`.
export const BrowserAnnotationStyleIntentV1Schema = z.enum([
  'callout',
  'highlight',
  'redaction',
  'arrow',
  'freeform',
]);
export type BrowserAnnotationStyleIntentV1 = z.infer<typeof BrowserAnnotationStyleIntentV1Schema>;

// A vector stroke overlaid on the annotation, expressed in normalized [0,1] media coordinates so it
// survives scaling and never embeds raw pixels. Bounded point count keeps the payload metadata-only.
const BrowserAnnotationStrokePointV1Schema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

export const BrowserAnnotationStrokeV1Schema = z
  .object({
    shape: z.enum(['freehand', 'line', 'arrow', 'rectangle', 'ellipse']),
    points: z.array(BrowserAnnotationStrokePointV1Schema).min(1).max(512),
    colorToken: z.string().trim().min(1).max(64).optional(),
    widthPx: z.number().positive().max(64).optional(),
  })
  .strict();
export type BrowserAnnotationStrokeV1 = z.infer<typeof BrowserAnnotationStrokeV1Schema>;

const AnnotationSchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.literal('browserAnnotation'),
  annotationId: IdSchema,
  browserSessionId: IdSchema,
  media: BrowserScreenshotMediaReferenceV1Schema,
  target: BrowserAnnotationTargetV1Schema,
  comment: z.string().trim().min(1).max(2048).optional(),
  styleIntent: BrowserAnnotationStyleIntentV1Schema.optional(),
  stroke: BrowserAnnotationStrokeV1Schema.optional(),
  pageUrl: z.string().trim().min(1).max(4096).optional(),
  pageTitle: z.string().trim().min(1).max(512).optional(),
}).strict();

const BrowserContextAnnotationStructuredElementV1Schema = z
  .object({
    selectorPath: z.string().trim().min(1).max(1024),
    accessibleName: z.string().max(512).optional(),
    rect: BrowserAnnotationRectV1Schema.optional(),
  })
  .strict();

const BrowserContextAnnotationStructuredRegionV1Schema = z
  .object({
    rect: BrowserAnnotationRectV1Schema,
  })
  .strict();

const BrowserContextAnnotationStructuredScreenshotV1Schema = z
  .object({
    media: z.array(BrowserScreenshotMediaReferenceV1Schema).min(1).max(8),
    cropRect: BrowserAnnotationRectV1Schema.optional(),
  })
  .strict();

export const BrowserContextAnnotationStructuredBlockV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.annotation.v1'),
    annotationId: IdSchema,
    sourceViewId: IdSchema,
    browserSessionId: IdSchema.optional(),
    contextIds: z.array(IdSchema).min(1).max(128),
    elements: z.array(BrowserContextAnnotationStructuredElementV1Schema).max(64),
    regions: z.array(BrowserContextAnnotationStructuredRegionV1Schema).max(64),
    strokes: z.array(BrowserAnnotationStrokeV1Schema).max(64),
    comment: z.string().trim().min(1).max(2048).optional(),
    screenshot: BrowserContextAnnotationStructuredScreenshotV1Schema,
    pageUrl: z.string().trim().min(1).max(4096).optional(),
    pageTitle: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((block, context) => {
    rejectUnsafeBrowserContextKeys(block, context);
  });
export type BrowserContextAnnotationStructuredBlockV1 = z.infer<
  typeof BrowserContextAnnotationStructuredBlockV1Schema
>;

const RecordingEvidenceSchema = BrowserContextItemBaseV1Schema.extend({
  kind: z.literal('browserRecordingEvidence'),
  recordingId: IdSchema,
  artifactId: IdSchema,
  mediaRef: BrowserEvidenceSessionMediaReferenceV1Schema,
  sourceNavigationGenerationRange: z
    .object({
      start: NonNegativeIntSchema,
      end: NonNegativeIntSchema.optional(),
    })
    .strict(),
  actionChapterRefs: z.array(IdSchema).optional().default([]),
}).strict().superRefine((item, context) => {
  if (
    item.sourceNavigationGenerationRange.end != null
    && item.sourceNavigationGenerationRange.end < item.sourceNavigationGenerationRange.start
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceNavigationGenerationRange', 'end'],
      message: 'Recording evidence navigation range end must not be before start.',
    });
  }
});

// ── BA-2 combined rich agent snapshot ───────────────────────────────────────────────────────────
// A single context op that bundles the pieces an agent needs to act on a page in ONE round-trip:
// the accessibility tree, an interactive-element list with synthesized selectors + layout rects, the
// visible text, a console summary, and a screenshot reference. Modeled as a STANDALONE schema (not a
// `BrowserContextItem` discriminated-union member) so it never ripples the per-item consumers; it is
// the return shape of `BrowserContextRoutes.captureSnapshot`. Every collection is bounded and every
// string capped so a hostile/huge DOM can never produce an unbounded payload. Per the LANE-B egress
// model the daemon route returns FULL fidelity to the local owner (`redactionLevel: 'none'`); the
// agent/cloud egress chokepoint redacts before the payload leaves the device.
const BrowserContextSnapshotRectV1Schema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export const BrowserContextSnapshotAxNodeV1Schema = z
  .object({
    role: z.string().trim().min(1).max(128),
    name: z.string().max(256).optional(),
  })
  .strict();
export type BrowserContextSnapshotAxNodeV1 = z.infer<typeof BrowserContextSnapshotAxNodeV1Schema>;

export const BrowserContextSnapshotInteractiveElementV1Schema = z
  .object({
    role: z.string().trim().min(1).max(128),
    name: z.string().max(256).optional(),
    selector: z.string().trim().min(1).max(1024),
    rect: BrowserContextSnapshotRectV1Schema,
  })
  .strict();
export type BrowserContextSnapshotInteractiveElementV1 = z.infer<
  typeof BrowserContextSnapshotInteractiveElementV1Schema
>;

const SNAPSHOT_AX_NODE_CAP = 512;
const SNAPSHOT_INTERACTIVE_CAP = 512;

export const BrowserContextSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    contextId: IdSchema,
    sourceViewId: IdSchema,
    sourceAdapterKind: BrowserSemanticAdapterKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    capturedAtMs: NonNegativeIntSchema,
    navigationGeneration: NonNegativeIntSchema,
    redactionLevel: BrowserContextRedactionLevelV1Schema,
    url: z.string().trim().min(1).max(4096).optional(),
    title: z.string().trim().min(1).max(512).optional(),
    media: BrowserScreenshotMediaReferenceV1Schema.optional(),
    visibleText: z.string().max(16_384),
    visibleTextTruncated: z.boolean().optional().default(false),
    axNodes: z.array(BrowserContextSnapshotAxNodeV1Schema).max(SNAPSHOT_AX_NODE_CAP),
    axNodesTruncated: z.boolean().optional().default(false),
    interactiveElements: z
      .array(BrowserContextSnapshotInteractiveElementV1Schema)
      .max(SNAPSHOT_INTERACTIVE_CAP),
    interactiveElementsTruncated: z.boolean().optional().default(false),
    consoleSummary: z.string().max(8192).optional(),
    consoleTruncated: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((snapshot, context) => {
    rejectUnsafeBrowserContextKeys(snapshot, context);
  });
export type BrowserContextSnapshotV1 = z.infer<typeof BrowserContextSnapshotV1Schema>;

export const BrowserContextItemV1Schema = z
  .discriminatedUnion('kind', [
    PageReferenceSchema,
    ScreenshotSchema,
    TextSelectionSchema,
    SummarySchema,
    SelectedElementSchema,
    AnnotationSchema,
    RecordingEvidenceSchema,
  ])
  .superRefine((item, context) => {
    rejectUnsafeBrowserContextKeys(item, context);

    if (item.lifecycleState !== 'available' && !item.disabledReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Blocked media-backed browser context must not include captured media.',
      });
    }
  });
export type BrowserContextItemV1 = z.infer<typeof BrowserContextItemV1Schema>;

export const BrowserContextCommandV1Schema = z.enum([
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
]);
export type BrowserContextCommandV1 = z.infer<typeof BrowserContextCommandV1Schema>;

export const BrowserContextEventV1Schema = z.enum([
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
]);
export type BrowserContextEventV1 = z.infer<typeof BrowserContextEventV1Schema>;

const BrowserContextAnnotationRuntimeActionIdV1Schema = RuntimeActionIdV1Schema.refine(
  (value) => value.startsWith('browser.context.annotation.'),
);

export const BrowserContextAnnotationActionResultV1Schema = z
  .object({
    v: z.literal(1),
    actionId: BrowserContextAnnotationRuntimeActionIdV1Schema,
    status: z.enum(['started', 'cancelled', 'captured', 'updated']),
    contextId: IdSchema.optional(),
    attachmentId: IdSchema.optional(),
  })
  .strict();
export type BrowserContextAnnotationActionResultV1 = z.infer<
  typeof BrowserContextAnnotationActionResultV1Schema
>;

export const BrowserContextAttachmentV1Schema = z
  .object({
    v: z.literal(1),
    attachmentId: IdSchema,
    contextId: IdSchema,
    sourceViewId: IdSchema,
    capturedNavigationGeneration: NonNegativeIntSchema,
    currentNavigationGeneration: NonNegativeIntSchema,
    state: BrowserContextLifecycleStateV1Schema,
    requiresReconfirmBeforeSend: z.boolean().optional().default(false),
    structuredBlock: BrowserContextAnnotationStructuredBlockV1Schema.optional(),
  })
  .strict()
  .superRefine((attachment, context) => {
    if (attachment.currentNavigationGeneration !== attachment.capturedNavigationGeneration) {
      if (attachment.state !== 'navigationStale' || !attachment.requiresReconfirmBeforeSend) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['state'],
          message: 'Context captured before the current navigation must be marked navigationStale before send.',
        });
      }
    }
  });
export type BrowserContextAttachmentV1 = z.infer<typeof BrowserContextAttachmentV1Schema>;

export const BrowserContextRouteFailureV1Schema = z
  .object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_parameters', 'runtime_action_disabled']),
    error: z.string().trim().min(1).max(512),
  })
  .strict();
export type BrowserContextRouteFailureV1 = z.infer<typeof BrowserContextRouteFailureV1Schema>;

export const BrowserContextRouteResultV1Schema = z.union([
  BrowserContextItemV1Schema,
  z.array(BrowserContextItemV1Schema),
  BrowserContextAnnotationActionResultV1Schema,
  BrowserContextAttachmentV1Schema,
  BrowserContextRouteFailureV1Schema,
]);
export type BrowserContextRouteResultV1 = z.infer<typeof BrowserContextRouteResultV1Schema>;

export const DaemonBrowserContextDispatchRequestV1Schema = z
  .object({
    machineId: IdSchema,
    actionId: RuntimeActionIdV1Schema,
    input: z.unknown(),
  })
  .strict();
export type DaemonBrowserContextDispatchRequestV1 = z.infer<
  typeof DaemonBrowserContextDispatchRequestV1Schema
>;

export const DaemonBrowserContextDispatchResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: BrowserContextRouteResultV1Schema,
  })
  .strict();
export type DaemonBrowserContextDispatchResponseV1 = z.infer<
  typeof DaemonBrowserContextDispatchResponseV1Schema
>;
