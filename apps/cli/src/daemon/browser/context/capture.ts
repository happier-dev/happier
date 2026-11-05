import { BrowserContextItemV1Schema, BrowserContextSnapshotV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { resolveBrowserContextPrivacyDenial } from '@happier-dev/protocol/browser/context/privacy';
import type { BrowserContextPrivacyState, BrowserContextItemV1, BrowserContextSnapshotAxNodeV1, BrowserContextSnapshotInteractiveElementV1, BrowserContextSnapshotV1, BrowserScreenshotMediaReferenceV1, BrowserTargetDisplayV1, BrowserViewTargetKindV1 } from '@happier-dev/protocol';

import {
  buildSidecarContextUnavailableItem,
  buildSidecarSummaryContextItem,
  buildSidecarPageReferenceContextItem,
  buildSidecarScreenshotContextItem,
  type SidecarSummaryContextKind,
} from '../sidecar/context/capture';
import type { BrowserSidecarCdpCommandScope } from '../sidecar/controlAdapter';
import type { BrowserFocusedCredentialTargetV1 } from '@happier-dev/protocol/browser/context/v1';
import type { SurfaceInputControl } from '../../surfaces/inputControl';

export type BrowserContextInputControlResolver = (view: Readonly<{ browserSessionId: string; viewId: string }>) => SurfaceInputControl | undefined;

export type BrowserContextCaptureScope = BrowserSidecarCdpCommandScope;

/**
 * The CDP/Chromium boundary the BRW-11 context service captures from. This is the
 * only seam that talks to the sidecar control transport; everything else (owner
 * gating, redaction, protocol shaping) is daemon logic and is tested for real.
 */
export type BrowserContextSourceTargetRef = BrowserContextCaptureScope & Readonly<{
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
  | Readonly<{ ok: true; media: BrowserScreenshotMediaReferenceV1; viewport?: Readonly<{ width: number; height: number }> }>
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
      focusedCredentialTarget?: BrowserFocusedCredentialTargetV1;
    }>
  | BrowserContextSourceFailure;

export type BrowserContextSource = Readonly<{
  /** Reads only privacy facts before any context or pixel capture. */
  readPrivacyState?(target: BrowserContextSourceTargetRef): Promise<
    Readonly<{ ok: true; privacyState: BrowserContextPrivacyState | null }> | BrowserContextSourceFailure
  >;
  capturePage(target: BrowserContextSourceTargetRef): Promise<BrowserContextSourcePageResult>;
  captureScreenshot(target: BrowserContextSourceTargetRef): Promise<BrowserContextSourceScreenshotResult>;
  captureSummary(
    target: BrowserContextSourceTargetRef & Readonly<{ kind: SidecarSummaryContextKind }>,
  ): Promise<BrowserContextSourceSummaryResult>;
  captureSelectedElement(
    target: BrowserContextSourceTargetRef,
  ): Promise<BrowserContextSourceSelectedElementResult>;
  /**
   * BA-2 combined rich snapshot. Optional so a source without a live CDP transport (the unavailable
   * source / in-memory QA) leaves the combined op fail-closed (`adapter_unavailable`).
   */
  captureSnapshot?(
    target: BrowserContextSourceTargetRef,
  ): Promise<BrowserContextSourceSnapshotResult>;
}>;

export type BrowserContextCaptureRequest = BrowserContextCaptureScope & Readonly<{
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
  /** BA-2: combined rich agent snapshot (AX tree + interactive elements + text + console + screenshot). */
  captureSnapshot(request: BrowserContextCaptureRequest): Promise<BrowserContextSnapshotCaptureResult>;
}>;

/**
 * The capture/egress gate state threaded from the single-owner daemon feature-gate. The route
 * owner is constructed only when `browser.context` is enabled, but the server can flip the
 * feature off afterwards; checking before any read/persistence keeps disabled capture closed
 * instead of trusting construction-time admission. Each finite capture admits once,
 * then probes source privacy before disclosing its captured content.
 */
export type BrowserContextCaptureGateState = Readonly<{
  featureEnabled: boolean;
  policyAllowed: boolean;
  runtimeAvailable: boolean;
  privacyState?: BrowserContextPrivacyState | null;
}>;

export type BrowserContextCaptureGateResolver = (target: BrowserContextSourceTargetRef) =>
  BrowserContextCaptureGateState | Promise<BrowserContextCaptureGateState>;

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

export function createBrowserContextCaptureService(input: Readonly<{
  ownerAccountId: string;
  source: BrowserContextSource;
  now?: () => number;
  resolveGate?: BrowserContextCaptureGateResolver;
  resolveInputControl?: BrowserContextInputControlResolver;
}>): BrowserContextCaptureService {
  const now = input.now ?? (() => Date.now());
  const resolveOwnerGate = input.resolveGate ?? (() => DEFAULT_GATE_STATE);
  function normalizePrivacy(state: BrowserContextPrivacyState | null | undefined, maskedSnapshot: boolean) {
    return maskedSnapshot && state === 'sensitiveFieldsPresent' ? null : state;
  }

  async function sourcePrivacyDenial(request: BrowserContextCaptureRequest, maskedSnapshot = false) {
    if (!input.source.readPrivacyState) return null;
    const facts = await input.source.readPrivacyState(targetRef(request));
    const privacy = facts.ok ? resolveBrowserContextPrivacyDenial(normalizePrivacy(facts.privacyState, maskedSnapshot)) : null;
    if (facts.ok && !privacy) return null;
    return {
      lifecycleState: privacy?.lifecycleState ?? 'policyDenied' as const,
      disabledReason: facts.ok ? 'browser context blocked by source privacy' : 'browser context privacy unavailable',
    };
  }

  async function admissionDenial(request: BrowserContextCaptureRequest, maskedSnapshot = false) {
    const gate = await resolveOwnerGate(targetRef(request));
    const privacy = resolveBrowserContextPrivacyDenial(normalizePrivacy(gate.privacyState, maskedSnapshot));
    if (privacy) return { lifecycleState: privacy.lifecycleState, disabledReason: 'browser context blocked by source privacy' };
    if (!gate.featureEnabled || !gate.policyAllowed) return {
      lifecycleState: 'policyDenied' as const,
      disabledReason: !gate.featureEnabled ? 'browser.context feature disabled' : 'browser context denied by policy',
    };
    if (!gate.runtimeAvailable) return { lifecycleState: 'adapterUnavailable' as const, disabledReason: 'browser sidecar runtime unavailable' };
    return sourcePrivacyDenial(request, maskedSnapshot);
  }

  function pageResult(request: BrowserContextCaptureRequest, denial: NonNullable<Awaited<ReturnType<typeof admissionDenial>>>): BrowserContextCaptureResult {
    return { status: 'captured', item: BrowserContextItemV1Schema.parse({
      v: 1, kind: 'browserPageReference', contextId: request.contextId, sourceViewId: request.viewId,
      sourceAdapterKind: 'chromiumSidecar', fidelity: 'unavailable', capturedAtMs: now(),
      navigationGeneration: request.navigationGeneration, redactionLevel: 'blocked', ...denial,
    }) };
  }

  function targetRef(request: BrowserContextCaptureRequest): BrowserContextSourceTargetRef {
    return {
      browserSessionId: request.browserSessionId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
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

  const service: BrowserContextCaptureService = {
    async capturePage(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const denial = await admissionDenial(request);
      if (denial) return pageResult(request, denial);
      const capture = await input.source.capturePage(targetRef(request));
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }

      const privacy = await sourcePrivacyDenial(request);
      if (privacy) return pageResult(request, privacy);
      const item = buildSidecarPageReferenceContextItem({
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
      return { status: 'captured', item };
    },

    async captureScreenshot(request) {
      if (!isOwner(request)) return { status: 'denied' };
      const denial = await admissionDenial(request);
      if (denial) {
        return { status: 'unavailable', item: buildSidecarContextUnavailableItem({
          contextId: request.contextId, sourceViewId: request.viewId, capturedAtMs: now(),
          navigationGeneration: request.navigationGeneration, kind: 'browserDomSnapshotSummary',
          lifecycleState: denial.lifecycleState, disabledReason: denial.disabledReason,
        }) };
      }
      const capture = await input.source.captureScreenshot(targetRef(request));
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }

      const privacy = await sourcePrivacyDenial(request);
      if (privacy) return { status: 'unavailable', item: buildSidecarContextUnavailableItem({
        contextId: request.contextId, sourceViewId: request.viewId, capturedAtMs: now(),
        navigationGeneration: request.navigationGeneration, kind: 'browserDomSnapshotSummary', ...privacy,
      }) };
      const item = buildSidecarScreenshotContextItem({
        contextId: request.contextId,
        sourceViewId: request.viewId,
        capturedAtMs: now(),
        navigationGeneration: request.navigationGeneration,
        media: capture.media,
        ...(capture.viewport ? { viewport: capture.viewport } : {}),
      });
      return { status: 'captured', item };
    },

    async captureSummary(request) {
      if (!isOwner(request)) return { status: 'denied' };
      if (await admissionDenial(request)) return { status: 'denied' };
      const capture = await input.source.captureSummary({ ...targetRef(request), kind: request.kind });
      if (!capture.ok) {
        return unavailableSummary(request, request.kind, capture);
      }

      if (await sourcePrivacyDenial(request)) return { status: 'denied' };
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
      if (await admissionDenial(request)) return { status: 'denied' };
      const capture = await input.source.captureSelectedElement(targetRef(request));
      if (!capture.ok) {
        return unavailableSummary(request, 'browserDomSnapshotSummary', capture);
      }

      if (await sourcePrivacyDenial(request)) return { status: 'denied' };
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

    async captureSnapshot(request) {
      if (!isOwner(request)) return { status: 'denied' };
      // The source masks field values for every rich snapshot and omits sensitive pixels.
      // Field presence therefore no longer blocks useful structure or credential proof.
      if (await admissionDenial(request, true)) {
        return { status: 'denied' };
      }
      if (!input.source.captureSnapshot) {
        return { status: 'unavailable', disabledReason: 'browser snapshot producer unavailable' };
      }
      const capture = await input.source.captureSnapshot(targetRef(request));
      if (!capture.ok) {
        return { status: 'unavailable', disabledReason: disabledReasonFor(capture) };
      }
      if (await sourcePrivacyDenial(request, true)) return { status: 'denied' };
      // Field masking is already enforced by the capture owner. `none` describes
      // the separate egress-policy projection; it does not disable secret masking.
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
        ...(capture.focusedCredentialTarget ? { focusedCredentialTarget: capture.focusedCredentialTarget } : {}),
      });
      return { status: 'captured', snapshot };
    },
  };

  async function observe<T>(request: BrowserContextCaptureRequest, read: () => Promise<T>): Promise<T | Readonly<{ status: 'denied' }>> {
    const control = input.resolveInputControl?.(request);
    return (control ? await control.observeWhile(read) : await read()) ?? { status: 'denied' };
  }
  return {
    capturePage: request => observe(request, () => service.capturePage(request)),
    captureScreenshot: request => observe(request, () => service.captureScreenshot(request)),
    captureSummary: request => observe(request, () => service.captureSummary(request)),
    captureSelectedElement: request => observe(request, () => service.captureSelectedElement(request)),
    captureSnapshot: request => observe(request, () => service.captureSnapshot(request)),
  };
}
