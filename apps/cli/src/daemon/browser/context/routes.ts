import { browserViewContextId } from '@happier-dev/protocol/browser/view/key';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { BrowserContextAttachmentV1, BrowserContextItemV1, BrowserContextSnapshotV1, RuntimeActionIdV1 } from '@happier-dev/protocol';

import {
  createBrowserContextCaptureService,
  type BrowserContextCaptureGateResolver,
  type BrowserContextCaptureScope,
  type BrowserContextInputControlResolver,
  type BrowserContextSource,
  type BrowserContextCaptureResult,
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
  captureSnapshot?(input: unknown, scope?: BrowserContextCaptureScope): Promise<BrowserContextSnapshotRouteResult>;
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

// Attach destinations share the daemon's item store, egress owner and media release path.
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
}>;

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
  const annotationId = typeof data.annotationId === 'string' && data.annotationId.length > 0
    ? data.annotationId
    : undefined;
  return {
    browserSessionId,
    viewId,
    navigationGeneration,
    contextId,
    ...(annotationId ? { annotationId } : {}),
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
  }>,
): BrowserContextRouteResult {
  if (result.status === 'denied') return disabled('browser_context_denied');
  options?.record?.(result.item);
  return result.item;
}

export function createBrowserContextRoutes(input: Readonly<{
  ownerAccountId: string;
  source: BrowserContextSource;
  now?: () => number;
  // Threaded from the single-owner daemon feature-gate. Read per publish so a server that
  // disables `browser.context` after construction fails capture closed.
  resolveGate?: BrowserContextCaptureGateResolver;
  resolveInputControl?: BrowserContextInputControlResolver;
}>): BrowserContextRoutes {
  const service = createBrowserContextCaptureService({
    ownerAccountId: input.ownerAccountId,
    source: input.source,
    ...(input.now ? { now: input.now } : {}),
    ...(input.resolveGate ? { resolveGate: input.resolveGate } : {}),
    ...(input.resolveInputControl ? { resolveInputControl: input.resolveInputControl } : {}),
  });

  // The local store retains one item for attachment and releases shared media on clear.
  const store = createBrowserContextItemStore();
  const attachService = createBrowserContextAttachService({ store });

  return {
    async dispatch(actionId, rawInput) {
      const parsed = parseContextInput(actionId, rawInput);
      if (!parsed) return invalidParameters;
      const record = (item: BrowserContextItemV1) => store.record(item, {
        browserSessionId: parsed.browserSessionId, viewId: parsed.viewId,
      });

      const attachDestination = ATTACH_DESTINATIONS[actionId];
      if (attachDestination) {
        const item = parsed.annotationId ? store.annotation(parsed.annotationId) : store.item(parsed.contextId);
        const items = item ? [item] : [];
        if (items.some(item => {
          const source = store.source(item.contextId);
          return source && input.resolveInputControl?.(source)?.isObservationHeld();
        })) return disabled('browser_context_confidential_input');
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

    async captureSnapshot(rawInput, scope) {
      const parsed = parseSnapshotInput(rawInput);
      if (!parsed) return invalidParameters;

      const result = await service.captureSnapshot({
        // The requester account is bound to the route owner; caller-provided identity is never echoed.
        requesterAccountId: input.ownerAccountId,
        browserSessionId: parsed.browserSessionId,
        viewId: parsed.viewId,
        navigationGeneration: parsed.navigationGeneration,
        contextId: parsed.contextId,
        ...(scope?.signal ? { signal: scope.signal } : {}),
        ...(scope?.deadlineMs !== undefined ? { deadlineMs: scope.deadlineMs } : {}),
      });
      if (result.status === 'denied') return disabled('browser_context_denied');
      if (result.status === 'unavailable') return disabled(result.disabledReason);
      return result.snapshot;
    },
  };
}
