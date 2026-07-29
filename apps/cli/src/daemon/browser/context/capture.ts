import {
  BrowserContextItemV1Schema,
  BrowserContextSnapshotV1Schema,
  type BrowserContextItemV1,
  type BrowserContextSnapshotAxNodeV1,
  type BrowserContextSnapshotInteractiveElementV1,
  type BrowserContextSnapshotV1,
  type BrowserScreenshotMediaReferenceV1,
  type BrowserTargetDisplayV1,
  type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';

import {
  buildSidecarContextUnavailableItem,
  buildSidecarSummaryContextItem,
  type SidecarSummaryContextKind,
} from '../sidecar/context/capture';
import { createSidecarContextPublisher } from '../sidecar/context/publish';

/**
 * The CDP/Chromium boundary the BRW-11 context service captures from. This is the
 * only seam that talks to the sidecar control transport; everything else (owner
 * gating, redaction, protocol shaping) is daemon logic and is tested for real.
 */
export type BrowserContextSourceTargetRef = Readonly<{
  browserSessionId: string;
  viewId: string;
  navigationGeneration: number;
}>;

export type BrowserContextSourceUnavailableReason =
  | 'adapter_unavailable'
  | 'capture_failed'
  | 'sensitive_origin';

type BrowserContextSourceFailure = Readonly<{
  ok: false;
  reason: BrowserContextSourceUnavailableReason;
  disabledReason?: string;
}>;

export type BrowserContextSourcePageResult =
  | Readonly<{
      ok: true;
      url?: string;
      title?: string;
      faviconUrl?: string;
      targetId?: string;
      targetKind?: BrowserViewTargetKindV1;
      display?: BrowserTargetDisplayV1;
    }>
  | BrowserContextSourceFailure;

export type BrowserContextSourceScreenshotResult =
  | Readonly<{ ok: true; media: BrowserScreenshotMediaReferenceV1 }>
  | BrowserContextSourceFailure;

export type BrowserContextSourceSummaryResult =
  | Readonly<{ ok: true; summary: string; truncated?: boolean }>
  | BrowserContextSourceFailure;

export type BrowserContextSourceSelectedElementResult =
  | Readonly<{
      ok: true;
      selectorPath: string;
      accessibleName?: string;
      rect?: Readonly<{ x: number; y: number; width: number; height: number }>;
    }>
  | BrowserContextSourceFailure;

export type BrowserContextRegionSurfaceBounds = Readonly<{ width: number; height: number }>;

/**
 * A normalized capture rectangle in CSS pixels. `viewport` coordinates add scrollX/scrollY before
 * CDP capture; `page` coordinates are already absolute CSS page coordinates. DPR is threaded so
 * CDP can pass `clip.scale` and Wry can consume the device-pixel sibling from the same geometry
 * helper.
 */
export type BrowserContextRegionRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace?: 'viewport' | 'page';
  scrollX?: number;
  scrollY?: number;
  devicePixelRatio?: number;
  surface?: BrowserContextRegionSurfaceBounds;
}>;

export type BrowserContextSourceRegionCaptureResult =
  | Readonly<{ ok: true; media: BrowserScreenshotMediaReferenceV1; rect: BrowserContextRegionRect }>
  | BrowserContextSourceFailure;

/**
 * BA-2 combined rich snapshot from the engine boundary: accessibility tree + interactive-element list
 * + visible text + console summary + a screenshot reference, captured in ONE pass. The screenshot is
 * best-effort (`media` optional) so a snapshot still resolves when only the pixel capture failed; the
 * structural pieces are the core agent payload.
 */
export type BrowserContextSourceSnapshotResult =
  | Readonly<{
      ok: true;
      url?: string;
      title?: string;
      visibleText: string;
      visibleTextTruncated?: boolean;
      axNodes: readonly BrowserContextSnapshotAxNodeV1[];
      axNodesTruncated?: boolean;
      interactiveElements: readonly BrowserContextSnapshotInteractiveElementV1[];
      interactiveElementsTruncated?: boolean;
      consoleSummary?: string;
      consoleTruncated?: boolean;
      media?: BrowserScreenshotMediaReferenceV1;
    }>
  | BrowserContextSourceFailure;

export type BrowserContextSource = Readonly<{
  capturePage(target: BrowserContextSourceTargetRef): Promise<BrowserContextSourcePageResult>;
  captureScreenshot(target: BrowserContextSourceTargetRef): Promise<BrowserContextSourceScreenshotResult>;
  captureSummary(
    target: BrowserContextSourceTargetRef & Readonly<{ kind: SidecarSummaryContextKind }>,
  ): Promise<BrowserContextSourceSummaryResult>;
  captureSelectedElement(
    target: BrowserContextSourceTargetRef,
  ): Promise<BrowserContextSourceSelectedElementResult>;
  /**
   * Annotation region pixel capture (MCH-5). Crops a rectangle of the page via CDP
   * `Page.captureScreenshot({clip})`. Optional so a source without a live CDP transport (the
   * unavailable source / in-memory QA) leaves region capture fail-closed.
   */
  captureRegion?(
    target: BrowserContextSourceTargetRef & Readonly<{ rect: BrowserContextRegionRect }>,
  ): Promise<BrowserContextSourceRegionCaptureResult>;
  /**
   * Annotation element pixel capture (MCH-5). Resolves a selector's box model and captures that
   * clip via CDP `Page.captureScreenshot({clip})`. Optional for the same fail-closed reason.
   */
  captureElement?(
    target: BrowserContextSourceTargetRef & Readonly<{ selector: string }>,
  ): Promise<BrowserContextSourceRegionCaptureResult>;
  /**
   * BA-2 combined rich snapshot. Optional so a source without a live CDP transport (the unavailable
   * source / in-memory QA) leaves the combined op fail-closed (`adapter_unavailable`).
   */
  captureSnapshot?(
    target: BrowserContextSourceTargetRef,
  ): Promise<BrowserContextSourceSnapshotResult>;
}>;

export type BrowserContextCaptureRequest = Readonly<{
  requesterAccountId: string;
  browserSessionId: string;
  viewId: string;
  navigationGeneration: number;
  contextId: string;
}>;

export type BrowserContextSummaryCaptureRequest = BrowserContextCaptureRequest & Readonly<{
  kind: SidecarSummaryContextKind;
}>;

export type BrowserContextCaptureResult =
  | Readonly<{ status: 'captured'; item: BrowserContextItemV1 }>
  | Readonly<{ status: 'unavailable'; item: BrowserContextItemV1 }>
  | Readonly<{ status: 'denied' }>;

export type BrowserContextRegionCaptureRequest = BrowserContextCaptureRequest & Readonly<{
  rect: BrowserContextRegionRect;
}>;

export type BrowserContextElementCaptureRequest = BrowserContextCaptureRequest & Readonly<{
  selector: string;
}>;

/** BA-2 combined-snapshot service result. The success payload is the standalone protocol snapshot. */
export type BrowserContextSnapshotCaptureResult =
  | Readonly<{ status: 'captured'; snapshot: BrowserContextSnapshotV1 }>
  | Readonly<{ status: 'denied' }>
  | Readonly<{ status: 'unavailable'; disabledReason: string }>;

export type BrowserContextCaptureService = Readonly<{
  capturePage(request: BrowserContextCaptureRequest): Promise<BrowserContextCaptureResult>;
  captureScreenshot(request: BrowserContextCaptureRequest): Promise<BrowserContextCaptureResult>;
  captureSummary(request: BrowserContextSummaryCaptureRequest): Promise<BrowserContextCaptureResult>;
  captureSelectedElement(request: BrowserContextCaptureRequest): Promise<BrowserContextCaptureResult>;
  /** MCH-5: daemon annotation region pixel capture (managed-Chromium engine). */
  captureAnnotationRegion(request: BrowserContextRegionCaptureRequest): Promise<BrowserContextCaptureResult>;
  /** MCH-5: daemon annotation element pixel capture (managed-Chromium engine). */
  captureAnnotationElement(request: BrowserContextElementCaptureRequest): Promise<BrowserContextCaptureResult>;
  /** BA-2: combined rich agent snapshot (AX tree + interactive elements + text + console + screenshot). */
  captureSnapshot(request: BrowserContextCaptureRequest): Promise<BrowserContextSnapshotCaptureResult>;
}>;

/**
 * The publish-time gate state threaded from the single-owner daemon feature-gate. The route
 * owner is constructed only when `browser.context` is enabled, but the server can flip the
 * feature off afterwards; reading the gate per publish keeps capture fail-closed instead of
 * trusting the construction-time decision forever.
 */
export type BrowserContextCaptureGateState = Readonly<{
  featureEnabled: boolean;
  policyAllowed: boolean;
  runtimeAvailable: boolean;
}>;

// Fail-closed default (GATE-SEC-001): a sensitive capture gate MUST default to disabled when no
// gate is threaded — matching the OWNER-GATE contract that a missing/malformed gate decision is
// treated as disabled. Production routes always thread the live daemon feature-gate via
// `resolveGate`; callers that genuinely intend to permit capture (e.g. unit happy-paths) must pass
// an explicit permissive `resolveGate`. This keeps the chokepoint safe even if a future caller
// forgets to wire the gate.
const DEFAULT_GATE_STATE: BrowserContextCaptureGateState = {
  featureEnabled: false,
  policyAllowed: false,
  runtimeAvailable: false,
};

function unavailableLifecycleState(
  reason: BrowserContextSourceUnavailableReason,
): 'adapterUnavailable' | 'captureFailed' | 'sensitiveOrigin' {
  if (reason === 'adapter_unavailable') return 'adapterUnavailable';
  if (reason === 'sensitive_origin') return 'sensitiveOrigin';
  return 'captureFailed';
}

function disabledReasonFor(failure: BrowserContextSourceFailure): string {
  if (failure.disabledReason) return failure.disabledReason;
  if (failure.reason === 'adapter_unavailable') return 'browser sidecar runtime unavailable';
  if (failure.reason === 'sensitive_origin') return 'browser context blocked for sensitive origin';
  return 'browser context capture failed';
}

function buildSelectedElementItem(input: Readonly<{
  contextId: string;
  sourceViewId: string;
  capturedAtMs: number;
  navigationGeneration: number;
  selectorPath: string;
  accessibleName?: string;
  rect?: Readonly<{ x: number; y: number; width: number; height: number }>;
}>): BrowserContextItemV1 {
  return BrowserContextItemV1Schema.parse({
    v: 1,
    contextId: input.contextId,
    kind: 'browserSelectedElement',
    sourceViewId: input.sourceViewId,
    sourceAdapterKind: 'chromiumSidecar',
    fidelity: 'cdp',
    capturedAtMs: input.capturedAtMs,
    navigationGeneration: input.navigationGeneration,
    lifecycleState: 'available',
    redactionLevel: 'metadataOnly',
    selectorPath: input.selectorPath,
    ...(input.accessibleName ? { accessibleName: input.accessibleName } : {}),
    ...(input.rect ? { rect: input.rect } : {}),
  });
}

function buildAnnotationItem(input: Readonly<{
  contextId: string;
  annotationId: string;
  browserSessionId: string;
  sourceViewId: string;
  capturedAtMs: number;
  navigationGeneration: number;
  media: BrowserScreenshotMediaReferenceV1;
  target: { kind: 'region'; rect: BrowserContextRegionRect }
    | { kind: 'element'; selectorPath: string; rect?: BrowserContextRegionRect };
}>): BrowserContextItemV1 {
  const target = input.target.kind === 'region'
    ? { kind: 'region' as const, rect: publicRegionRect(input.target.rect) }
    : {
        kind: 'element' as const,
        selectorPath: input.target.selectorPath,
        ...(input.target.rect ? { rect: publicRegionRect(input.target.rect) } : {}),
      };
  return BrowserContextItemV1Schema.parse({
    v: 1,
    contextId: input.contextId,
    kind: 'browserAnnotation',
    sourceViewId: input.sourceViewId,
    sourceAdapterKind: 'chromiumSidecar',
    fidelity: 'cdp',
    capturedAtMs: input.capturedAtMs,
    navigationGeneration: input.navigationGeneration,
    lifecycleState: 'available',
    redactionLevel: 'metadataOnly',
    annotationId: input.annotationId,
    browserSessionId: input.browserSessionId,
    media: input.media,
    target,
  });
}

function publicRegionRect(rect: BrowserContextRegionRect): Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function createBrowserContextCaptureService(input: Readonly<{
  ownerAccountId: string;
  source: BrowserContextSource;
  now?: () => number;
  resolveGate?: () => BrowserContextCaptureGateState;
}>): BrowserContextCaptureService {
  const now = input.now ?? (() => Date.now());
  const resolveGate = input.resolveGate ?? (() => DEFAULT_GATE_STATE);
  const publisher = createSidecarContextPublisher({
    ownerAccountId: input.ownerAccountId,
    // Publishing is the egress shape today; the daemon route owner returns the item
    // directly to the caller, so the publish sink is a no-op pass-through.
    publish: () => undefined,
  });

  function targetRef(request: BrowserContextCaptureRequest): BrowserContextSourceTargetRef {
    return {
      browserSessionId: request.browserSessionId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
    };
  }

  function isOwner(request: BrowserContextCaptureRequest): boolean {
    return request.requesterAccountId === input.ownerAccountId;
  }

  function unavailableSummary(
    request: BrowserContextCaptureRequest,
    kind: SidecarSummaryContextKind,
    failure: BrowserContextSourceFailure,
  ): BrowserContextCaptureResult {
    return {
      status: 'unavailable',
      item: buildSidecarContextUnavailableItem({
        contextId: request.contextId,
        sourceViewId: request.viewId,
        capturedAtMs: now(),
        navigationGeneration: request.navigationGeneration,
        kind,
        lifecycleState: unavailableLifecycleState(failure.reason),
        disabledReason: disabledReasonFor(failure),
      }),
    };
  }

  return {
    async capturePage(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const capture = await input.source.capturePage(targetRef(request));
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }

      const published = publisher.publishPageReference({
        requesterAccountId: request.requesterAccountId,
        ...resolveGate(),
        contextId: request.contextId,
        sourceViewId: request.viewId,
        capturedAtMs: now(),
        navigationGeneration: request.navigationGeneration,
        ...(capture.url ? { url: capture.url } : {}),
        ...(capture.title ? { title: capture.title } : {}),
        ...(capture.faviconUrl ? { faviconUrl: capture.faviconUrl } : {}),
        ...(capture.targetId ? { targetId: capture.targetId } : {}),
        ...(capture.targetKind ? { targetKind: capture.targetKind } : {}),
        ...(capture.display ? { display: capture.display } : {}),
      });
      if (published.status !== 'published') return { status: 'denied' };
      return { status: 'captured', item: published.item };
    },

    async captureScreenshot(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const capture = await input.source.captureScreenshot(targetRef(request));
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }

      const published = publisher.publishScreenshotReference({
        requesterAccountId: request.requesterAccountId,
        ...resolveGate(),
        contextId: request.contextId,
        sourceViewId: request.viewId,
        capturedAtMs: now(),
        navigationGeneration: request.navigationGeneration,
        media: capture.media,
      });
      if (published.status === 'denied') return { status: 'denied' };
      if (published.status === 'blocked') {
        return unavailableSummary(request, 'browserDomSnapshotSummary', {
          ok: false,
          reason: published.reason === 'adapter_unavailable' ? 'adapter_unavailable' : 'capture_failed',
          disabledReason: published.disabledReason,
        });
      }
      return { status: 'captured', item: published.item };
    },

    async captureSummary(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const capture = await input.source.captureSummary({ ...targetRef(request), kind: request.kind });
      if (!capture.ok) {
        return unavailableSummary(request, request.kind, capture);
      }

      return {
        status: 'captured',
        item: buildSidecarSummaryContextItem({
          contextId: request.contextId,
          sourceViewId: request.viewId,
          capturedAtMs: now(),
          navigationGeneration: request.navigationGeneration,
          kind: request.kind,
          summary: capture.summary,
          truncated: capture.truncated ?? false,
        }),
      };
    },

    async captureSelectedElement(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const capture = await input.source.captureSelectedElement(targetRef(request));
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }

      return {
        status: 'captured',
        item: buildSelectedElementItem({
          contextId: request.contextId,
          sourceViewId: request.viewId,
          capturedAtMs: now(),
          navigationGeneration: request.navigationGeneration,
          selectorPath: capture.selectorPath,
          ...(capture.accessibleName ? { accessibleName: capture.accessibleName } : {}),
          ...(capture.rect ? { rect: capture.rect } : {}),
        }),
      };
    },

    async captureAnnotationRegion(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const gate = resolveGate();
      if (!gate.featureEnabled || !gate.policyAllowed || !gate.runtimeAvailable) {
        return { status: 'denied' };
      }
      if (!input.source.captureRegion) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', {
          ok: false,
          reason: 'adapter_unavailable',
          disabledReason: 'browser annotation region capture producer unavailable',
        });
      }
      const capture = await input.source.captureRegion({ ...targetRef(request), rect: request.rect });
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }
      return {
        status: 'captured',
        item: buildAnnotationItem({
          contextId: request.contextId,
          annotationId: request.contextId,
          browserSessionId: request.browserSessionId,
          sourceViewId: request.viewId,
          capturedAtMs: now(),
          navigationGeneration: request.navigationGeneration,
          media: capture.media,
          target: { kind: 'region', rect: capture.rect },
        }),
      };
    },

    async captureAnnotationElement(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const gate = resolveGate();
      if (!gate.featureEnabled || !gate.policyAllowed || !gate.runtimeAvailable) {
        return { status: 'denied' };
      }
      if (!input.source.captureElement) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', {
          ok: false,
          reason: 'adapter_unavailable',
          disabledReason: 'browser annotation element capture producer unavailable',
        });
      }
      const capture = await input.source.captureElement({ ...targetRef(request), selector: request.selector });
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }
      return {
        status: 'captured',
        item: buildAnnotationItem({
          contextId: request.contextId,
          annotationId: request.contextId,
          browserSessionId: request.browserSessionId,
          sourceViewId: request.viewId,
          capturedAtMs: now(),
          navigationGeneration: request.navigationGeneration,
          media: capture.media,
          target: { kind: 'element', selectorPath: request.selector, rect: capture.rect },
        }),
      };
    },

    async captureSnapshot(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const gate = resolveGate();
      // The combined snapshot bundles a screenshot, so it is gated like the other sensitive
      // pixel-bearing captures (screenshot/annotation): fail-closed unless the feature is enabled,
      // policy-allowed, and the runtime is available.
      if (!gate.featureEnabled || !gate.policyAllowed || !gate.runtimeAvailable) {
        return { status: 'denied' };
      }
      if (!input.source.captureSnapshot) {
        return { status: 'unavailable', disabledReason: 'browser snapshot producer unavailable' };
      }
      const capture = await input.source.captureSnapshot(targetRef(request));
      if (!capture.ok) {
        return { status: 'unavailable', disabledReason: disabledReasonFor(capture) };
      }
      // LANE-B egress model: the daemon route owner returns FULL fidelity to the local owner; the
      // agent/cloud egress chokepoint redacts before the payload leaves the device. `none` records
      // that no redaction was applied to the owner-facing payload.
      const snapshot = BrowserContextSnapshotV1Schema.parse({
        v: 1,
        contextId: request.contextId,
        sourceViewId: request.viewId,
        sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'cdp',
        capturedAtMs: now(),
        navigationGeneration: request.navigationGeneration,
        redactionLevel: 'none',
        ...(capture.url ? { url: capture.url } : {}),
        ...(capture.title ? { title: capture.title } : {}),
        ...(capture.media ? { media: capture.media } : {}),
        visibleText: capture.visibleText,
        visibleTextTruncated: capture.visibleTextTruncated ?? false,
        axNodes: capture.axNodes,
        axNodesTruncated: capture.axNodesTruncated ?? false,
        interactiveElements: capture.interactiveElements,
        interactiveElementsTruncated: capture.interactiveElementsTruncated ?? false,
        ...(capture.consoleSummary ? { consoleSummary: capture.consoleSummary } : {}),
        consoleTruncated: capture.consoleTruncated ?? false,
      });
      return { status: 'captured', snapshot };
    },
  };
}
