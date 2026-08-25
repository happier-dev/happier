import {
  browserViewContextId,
  BrowserAnnotationStrokeV1Schema,
  BrowserAnnotationStyleIntentV1Schema,
  BrowserContextItemV1Schema,
  getActionSpec,
  type BrowserAnnotationStrokeV1,
  type BrowserAnnotationStyleIntentV1,
  type BrowserContextAttachmentV1,
  type BrowserContextAnnotationActionResultV1,
  type BrowserContextItemV1,
  type BrowserContextSnapshotV1,
  type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import {
  createBrowserContextCaptureService,
  type BrowserContextCaptureGateState,
  type BrowserContextSource,
  type BrowserContextCaptureResult,
  type BrowserContextRegionRect,
} from './capture';
import {
  createBrowserContextAttachService,
  type BrowserContextAttachDestination,
} from './attach';
import { createBrowserContextItemStore } from './store';
import type { SidecarSummaryContextKind } from '../sidecar/context/capture';

export type BrowserContextRouteFailure = Readonly<{
  ok: false;
  errorCode: 'invalid_parameters' | 'runtime_action_disabled';
  error: string;
}>;

export type BrowserContextRouteResult =
  | BrowserContextItemV1
  | readonly BrowserContextItemV1[]
  | BrowserContextAttachmentV1
  | BrowserContextAnnotationActionResultV1
  | BrowserContextRouteFailure;

export type BrowserContextSnapshotRouteResult =
  | BrowserContextSnapshotV1
  | BrowserContextRouteFailure;

export type BrowserContextRoutes = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown): Promise<BrowserContextRouteResult>;
  /**
   * BA-2 combined rich agent snapshot — a single op returning the accessibility tree, interactive
   * elements (synthesized selectors + rects), visible text, a console summary, and a screenshot
   * reference together. Surfaced as a first-class route method (not a runtime-action `dispatch`
   * branch) so the headless agent automation path can request the whole context in one call without
   * adding a new action id to the contended SSOT arrays. Owner-bound + gate-checked like the other
   * pixel-bearing captures; the LANE-B egress chokepoint redacts before the payload leaves the device.
   *
   * Optional on the interface (additive): the canonical `createBrowserContextRoutes` always provides
   * it; lightweight consumers that only need the `dispatch` front door (and existing test fakes) need
   * not implement it.
   */
  captureSnapshot?(input: unknown): Promise<BrowserContextSnapshotRouteResult>;
}>;

type ContextCaptureOperation = 'page' | 'screenshot' | 'selectedElement';

const SUMMARY_OPERATIONS: Readonly<Partial<Record<RuntimeActionIdV1, SidecarSummaryContextKind>>> = {
  'browser.context.captureNetworkSummary': 'browserNetworkSummary',
  'browser.context.captureConsoleSummary': 'browserConsoleSummary',
};

const CAPTURE_OPERATIONS: Readonly<Partial<Record<RuntimeActionIdV1, ContextCaptureOperation>>> = {
  'browser.context.capturePage': 'page',
  'browser.context.captureScreenshot': 'screenshot',
  'browser.context.captureSelectedElement': 'selectedElement',
};

// MCH-5: daemon-side annotation route for the managed-Chromium engine. Pixel-bearing region/element
// leaves produce cropped media through daemon CDP `Page.captureScreenshot({clip})`; metadata-only
// start/cancel/comment/stroke/style-intent leaves return protocol action results and update the
// daemon context store when they target an existing captured annotation.
type AnnotationCaptureOperation = 'region' | 'element';

const ANNOTATION_CAPTURE_OPERATIONS: Readonly<Partial<Record<RuntimeActionIdV1, AnnotationCaptureOperation>>> = {
  'browser.context.annotation.captureRegion': 'region',
  'browser.context.annotation.captureElement': 'element',
};

// ANNO-4b: attach-to-composer / attach-to-agent-turn route through the daemon context-item store +
// attach service below (group-by-annotationId → ONE card, agnostic egress chokepoint, atomic clear).
const ATTACH_DESTINATIONS: Readonly<Partial<Record<RuntimeActionIdV1, BrowserContextAttachDestination>>> = {
  'browser.context.attachToComposer': 'composer',
  'browser.context.attachToAgentTurn': 'agentTurn',
};

const invalidParameters: BrowserContextRouteFailure = {
  ok: false,
  errorCode: 'invalid_parameters',
  error: 'invalid_parameters',
};

function disabled(reason: string): BrowserContextRouteFailure {
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:browser:${reason}`,
  };
}

type ParsedContextInput = Readonly<{
  browserSessionId: string;
  viewId: string;
  navigationGeneration: number;
  contextId: string;
  annotationId?: string;
  comment?: string;
  stroke?: BrowserAnnotationStrokeV1;
  styleIntent?: BrowserAnnotationStyleIntentV1;
  rect?: BrowserContextRegionRect;
  selector?: string;
}>;

function parseRect(value: unknown): BrowserContextRegionRect | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const x = r.x;
  const y = r.y;
  const width = r.width;
  const height = r.height;
  if (
    typeof x !== 'number' || typeof y !== 'number'
    || typeof width !== 'number' || typeof height !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y)
    || !(width > 0) || !(height > 0)
  ) {
    return undefined;
  }
  const coordinateSpace = r.coordinateSpace === 'page' || r.coordinateSpace === 'viewport'
    ? r.coordinateSpace
    : undefined;
  const scrollX = typeof r.scrollX === 'number' && Number.isFinite(r.scrollX) ? r.scrollX : undefined;
  const scrollY = typeof r.scrollY === 'number' && Number.isFinite(r.scrollY) ? r.scrollY : undefined;
  const devicePixelRatio = typeof r.devicePixelRatio === 'number' && Number.isFinite(r.devicePixelRatio) && r.devicePixelRatio > 0
    ? r.devicePixelRatio
    : undefined;
  const surfaceCandidate = r.surface && typeof r.surface === 'object' && !Array.isArray(r.surface)
    ? r.surface as Record<string, unknown>
    : undefined;
  const surface = typeof surfaceCandidate?.width === 'number'
      && typeof surfaceCandidate.height === 'number'
      && Number.isFinite(surfaceCandidate.width)
      && Number.isFinite(surfaceCandidate.height)
      && surfaceCandidate.width > 0
      && surfaceCandidate.height > 0
    ? { width: surfaceCandidate.width, height: surfaceCandidate.height }
    : undefined;
  return {
    x,
    y,
    width,
    height,
    ...(coordinateSpace ? { coordinateSpace } : {}),
    ...(scrollX !== undefined ? { scrollX } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(devicePixelRatio !== undefined ? { devicePixelRatio } : {}),
    ...(surface ? { surface } : {}),
  };
}

function parseContextInput(actionId: RuntimeActionIdV1, input: unknown): ParsedContextInput | null {
  const parsed = getActionSpec(actionId).inputSchema.safeParse(input ?? {});
  if (!parsed.success) return null;
  const data = parsed.data as Record<string, unknown>;
  const browserSessionId = typeof data.browserSessionId === 'string' ? data.browserSessionId : '';
  const viewId = typeof data.viewId === 'string' ? data.viewId : '';
  if (!browserSessionId || !viewId) return null;
  const navigationGeneration =
    typeof data.navigationGeneration === 'number' && Number.isInteger(data.navigationGeneration)
      ? data.navigationGeneration
      : 0;
  const contextId = typeof data.contextId === 'string' && data.contextId.length > 0
    ? data.contextId
    : [browserSessionId, viewId, String(navigationGeneration)].join('\0');
  const target = data.target && typeof data.target === 'object' && !Array.isArray(data.target)
    ? (data.target as Record<string, unknown>)
    : undefined;
  const rect = parseRect(data.rect) ?? parseRect(target?.rect);
  const selectorCandidate = typeof data.selector === 'string'
    ? data.selector
    : typeof target?.selectorPath === 'string'
      ? target.selectorPath
      : undefined;
  const selector = selectorCandidate && selectorCandidate.length > 0 ? selectorCandidate : undefined;
  const annotationId = typeof data.annotationId === 'string' && data.annotationId.length > 0
    ? data.annotationId
    : undefined;
  const comment = typeof data.comment === 'string' && data.comment.trim().length > 0
    ? data.comment.trim()
    : undefined;
  const strokeParsed = data.stroke === undefined || data.stroke === null
    ? undefined
    : BrowserAnnotationStrokeV1Schema.safeParse(data.stroke);
  if (strokeParsed && !strokeParsed.success) return null;
  const styleIntentParsed = data.styleIntent === undefined || data.styleIntent === null
    ? undefined
    : BrowserAnnotationStyleIntentV1Schema.safeParse(data.styleIntent);
  if (styleIntentParsed && !styleIntentParsed.success) return null;
  return {
    browserSessionId,
    viewId,
    navigationGeneration,
    contextId,
    ...(annotationId ? { annotationId } : {}),
    ...(comment ? { comment } : {}),
    ...(strokeParsed?.success ? { stroke: strokeParsed.data } : {}),
    ...(styleIntentParsed?.success ? { styleIntent: styleIntentParsed.data } : {}),
    ...(rect ? { rect } : {}),
    ...(selector ? { selector } : {}),
  };
}

// BA-2: the combined snapshot is not a runtime-action `dispatch` leaf (no action id), so it has no
// per-action input schema. Validate the view-reference shape directly. `contextId` defaults to a
// deterministic per-view id when not supplied so a snapshot is always addressable.
function parseSnapshotInput(input: unknown): Readonly<{
  browserSessionId: string;
  viewId: string;
  navigationGeneration: number;
  contextId: string;
}> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  const browserSessionId = typeof data.browserSessionId === 'string' ? data.browserSessionId : '';
  const viewId = typeof data.viewId === 'string' ? data.viewId : '';
  if (!browserSessionId || !viewId) return null;
  const navigationGeneration =
    typeof data.navigationGeneration === 'number' && Number.isInteger(data.navigationGeneration)
      ? data.navigationGeneration
      : 0;
  const contextId = typeof data.contextId === 'string' && data.contextId.length > 0
    ? data.contextId
    : browserViewContextId({ browserSessionId, viewId, navigationGeneration });
  return { browserSessionId, viewId, navigationGeneration, contextId };
}

function mapCaptureResult(
  result: BrowserContextCaptureResult,
  options?: Readonly<{
    record?: (item: BrowserContextItemV1) => void;
    /**
     * Caller-supplied annotation GROUP key. The daemon capture producer sets `annotationId` to the
     * per-target `contextId`; when the caller is authoring a multi-target annotation it supplies a
     * shared `annotationId` so distinct-contextId captures group into ONE attach card. Applied only
     * to annotation items.
     */
    annotationId?: string;
  }>,
): BrowserContextRouteResult {
  if (result.status === 'denied') return disabled('browser_context_denied');
  let item = result.item;
  if (
    options?.annotationId
    && item.kind === 'browserAnnotation'
    && item.annotationId !== options.annotationId
  ) {
    item = BrowserContextItemV1Schema.parse({ ...item, annotationId: options.annotationId });
  }
  // ANNO-4b: retain every captured item in the daemon store so a later attach can group it by
  // annotationId (the headless path has no in-app BrowserContextState holding items).
  options?.record?.(item);
  return item;
}

function annotationActionResult(
  actionId: RuntimeActionIdV1,
  status: BrowserContextAnnotationActionResultV1['status'],
  contextId?: string,
): BrowserContextAnnotationActionResultV1 {
  return {
    v: 1,
    actionId,
    status,
    ...(contextId ? { contextId } : {}),
  };
}

export function createBrowserContextRoutes(input: Readonly<{
  ownerAccountId: string;
  source: BrowserContextSource;
  now?: () => number;
  // Threaded from the single-owner daemon feature-gate. Read per publish so a server that
  // disables `browser.context` after construction fails capture closed.
  resolveGate?: () => BrowserContextCaptureGateState;
}>): BrowserContextRoutes {
  const service = createBrowserContextCaptureService({
    ownerAccountId: input.ownerAccountId,
    source: input.source,
    ...(input.now ? { now: input.now } : {}),
    ...(input.resolveGate ? { resolveGate: input.resolveGate } : {}),
  });

  // ANNO-4b: daemon-local item store + attach service. The store retains captured items so the
  // attach leaves can group them by annotationId into ONE composer/agent card; the attach service
  // routes the projection through the agnostic egress chokepoint and releases the shared mediaId once
  // on clear.
  const store = createBrowserContextItemStore();
  const attachService = createBrowserContextAttachService({ store });
  const record = (item: BrowserContextItemV1) => store.record(item);

  return {
    async dispatch(actionId, rawInput) {
      const parsed = parseContextInput(actionId, rawInput);
      if (!parsed) return invalidParameters;

      const attachDestination = ATTACH_DESTINATIONS[actionId];
      if (attachDestination) {
        const result = attachService.attach({
          ...(parsed.annotationId ? { annotationId: parsed.annotationId } : {}),
          contextId: parsed.contextId,
          destination: attachDestination,
        });
        if (!result.ok) {
          return result.errorCode === 'invalid_parameters' ? invalidParameters : disabled(
            result.error.replace(/^runtime_action_disabled:browser:/, ''),
          );
        }
        return result.attachment;
      }

      if (actionId === 'browser.context.clear') {
        const cleared = attachService.clear({
          ...(parsed.annotationId ? { annotationId: parsed.annotationId } : {}),
          ...(parsed.contextId ? { contextId: parsed.contextId } : {}),
        });
        return cleared.clearedItems;
      }

      if (actionId === 'browser.context.annotation.start') {
        return annotationActionResult(actionId, 'started');
      }
      if (actionId === 'browser.context.annotation.cancel') {
        return annotationActionResult(actionId, 'cancelled');
      }
      if (actionId === 'browser.context.annotation.attachComment') {
        if (!parsed.comment) return invalidParameters;
        const updated = store.updateAnnotation({ contextId: parsed.contextId, comment: parsed.comment });
        return updated ? annotationActionResult(actionId, 'updated', updated.contextId) : disabled('browser_context_annotation_missing');
      }
      if (actionId === 'browser.context.annotation.attachStroke') {
        if (!parsed.stroke) return invalidParameters;
        const updated = store.updateAnnotation({ contextId: parsed.contextId, stroke: parsed.stroke });
        return updated ? annotationActionResult(actionId, 'updated', updated.contextId) : disabled('browser_context_annotation_missing');
      }
      if (actionId === 'browser.context.annotation.attachStyleIntent') {
        if (!parsed.styleIntent) return invalidParameters;
        const updated = store.updateAnnotation({ contextId: parsed.contextId, styleIntent: parsed.styleIntent });
        return updated ? annotationActionResult(actionId, 'updated', updated.contextId) : disabled('browser_context_annotation_missing');
      }

      // The requester account is bound to the route owner; caller-provided identity
      // is never echoed (Category-2 invariant: caller-provided trust is not trusted).
      const request = {
        requesterAccountId: input.ownerAccountId,
        browserSessionId: parsed.browserSessionId,
        viewId: parsed.viewId,
        navigationGeneration: parsed.navigationGeneration,
        contextId: parsed.contextId,
      } as const;

      const summaryKind = SUMMARY_OPERATIONS[actionId];
      if (summaryKind) {
        return mapCaptureResult(await service.captureSummary({ ...request, kind: summaryKind }), { record });
      }

      const annotationGroup = { record, ...(parsed.annotationId ? { annotationId: parsed.annotationId } : {}) };
      const annotationOperation = ANNOTATION_CAPTURE_OPERATIONS[actionId];
      if (annotationOperation === 'region') {
        if (!parsed.rect) return invalidParameters;
        return mapCaptureResult(await service.captureAnnotationRegion({ ...request, rect: parsed.rect }), annotationGroup);
      }
      if (annotationOperation === 'element') {
        if (!parsed.selector) return invalidParameters;
        return mapCaptureResult(await service.captureAnnotationElement({ ...request, selector: parsed.selector }), annotationGroup);
      }

      const operation = CAPTURE_OPERATIONS[actionId];
      switch (operation) {
        case 'page':
          return mapCaptureResult(await service.capturePage(request), { record });
        case 'screenshot':
          return mapCaptureResult(await service.captureScreenshot(request), { record });
        case 'selectedElement':
          return mapCaptureResult(await service.captureSelectedElement(request), { record });
        default:
          return disabled('browser_context_action_unbacked');
      }
    },

    async captureSnapshot(rawInput) {
      const parsed = parseSnapshotInput(rawInput);
      if (!parsed) return invalidParameters;

      const result = await service.captureSnapshot({
        // The requester account is bound to the route owner; caller-provided identity is never echoed.
        requesterAccountId: input.ownerAccountId,
        browserSessionId: parsed.browserSessionId,
        viewId: parsed.viewId,
        navigationGeneration: parsed.navigationGeneration,
        contextId: parsed.contextId,
      });
      if (result.status === 'denied') return disabled('browser_context_denied');
      if (result.status === 'unavailable') return disabled(result.disabledReason);
      return result.snapshot;
    },
  };
}
