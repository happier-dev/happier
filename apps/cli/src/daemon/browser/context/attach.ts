import {
  BrowserContextAnnotationStructuredBlockV1Schema,
  BrowserContextAttachmentV1Schema,
  classifyBrowserDiagnosticFieldForDestination,
  type BrowserContextAnnotationStructuredBlockV1,
  type BrowserContextAttachmentV1,
  type BrowserContextItemV1,
} from '@happier-dev/protocol';

import type { BrowserContextItemStore } from './store';

/**
 * ANNO-4b attach destinations. Both are agent-bound (the composer is the agent's message draft, the
 * agent turn is its transcript), so both are redacted at egress: owner-only / full-fidelity content
 * never crosses to an agent message.
 */
export type BrowserContextAttachDestination = 'composer' | 'agentTurn';

export type BrowserContextAttachFailure = Readonly<{
  ok: false;
  errorCode: 'runtime_action_disabled' | 'invalid_parameters';
  error: string;
}>;

export type BrowserContextAttachSuccess = Readonly<{
  ok: true;
  attachment: BrowserContextAttachmentV1;
  /** Every contextId in the group this single attachment card represents. */
  attachedContextIds: readonly string[];
  /** Distinct reference-only media ids referenced by the group (one per annotation crop). */
  mediaIds: readonly string[];
}>;

export type BrowserContextAttachResult = BrowserContextAttachSuccess | BrowserContextAttachFailure;

export type BrowserContextClearSuccess = Readonly<{
  ok: true;
  clearedItems: readonly BrowserContextItemV1[];
  releasedMediaIds: readonly string[];
}>;

export type BrowserContextAttachService = Readonly<{
  attach(input: Readonly<{
    annotationId?: string;
    contextId?: string;
    destination: BrowserContextAttachDestination;
  }>): BrowserContextAttachResult;
  clear(input: Readonly<{ annotationId?: string; contextId?: string }>): BrowserContextClearSuccess;
}>;

function disabled(reason: string): BrowserContextAttachFailure {
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:browser:${reason}`,
  };
}

/**
 * The agnostic egress chokepoint for the LOCAL store projection. A context item attached to an agent
 * message is reduced to the same field model the diagnostics egress classifier enforces: full
 * owner-fidelity content (`redactionLevel === 'none'`) never crosses to an agent. The console case is
 * the canonical owner-only field — the diagnostics classifier drops `console.entry.text` for the
 * `agentContext` destination, so a console-summary captured at owner-full fidelity is refused here
 * rather than leaking the local owner's console output into the agent transcript. Metadata-only items
 * (annotation marks, page references) pass.
 */
export function isBrowserContextItemAgentEgressSafe(item: BrowserContextItemV1): boolean {
  if (item.redactionLevel !== 'none') return true;
  // Owner-full fidelity: drop. Cross-check the agnostic classifier's owner-only console rule so this
  // chokepoint stays aligned with the single diagnostics field model (no second redaction policy).
  return classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'agentContext') !== 'drop';
}

function mediaIdOf(item: BrowserContextItemV1): string | undefined {
  if (item.kind === 'browserAnnotation' || item.kind === 'browserScreenshot') {
    return item.media.mediaId;
  }
  return undefined;
}

function uniqueAnnotationMedia(
  items: readonly BrowserContextItemV1[],
): BrowserContextAnnotationStructuredBlockV1['screenshot']['media'] {
  const out: BrowserContextAnnotationStructuredBlockV1['screenshot']['media'] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'browserAnnotation') continue;
    if (seen.has(item.media.mediaId)) continue;
    seen.add(item.media.mediaId);
    out.push(item.media);
  }
  return out.slice(0, 8);
}

function buildStructuredAnnotationBlock(
  group: readonly BrowserContextItemV1[],
): BrowserContextAnnotationStructuredBlockV1 | undefined {
  const annotations = group.filter((item): item is Extract<BrowserContextItemV1, { kind: 'browserAnnotation' }> =>
    item.kind === 'browserAnnotation',
  );
  if (annotations.length === 0) return undefined;
  const representative = annotations[0];
  const media = uniqueAnnotationMedia(annotations);
  if (media.length === 0) return undefined;
  const firstMedia = media[0];
  const elements: BrowserContextAnnotationStructuredBlockV1['elements'] = [];
  const regions: BrowserContextAnnotationStructuredBlockV1['regions'] = [];
  const strokes: BrowserContextAnnotationStructuredBlockV1['strokes'] = [];
  for (const item of annotations) {
    if (item.target.kind === 'element') {
      elements.push({
        selectorPath: item.target.selectorPath,
        ...(item.target.accessibleName ? { accessibleName: item.target.accessibleName } : {}),
        ...(item.target.rect ? { rect: item.target.rect } : {}),
      });
    } else {
      regions.push({ rect: item.target.rect });
    }
    if (item.stroke) strokes.push(item.stroke);
  }
  return BrowserContextAnnotationStructuredBlockV1Schema.parse({
    v: 1,
    kind: 'browser.annotation.v1',
    annotationId: representative.annotationId,
    sourceViewId: representative.sourceViewId,
    browserSessionId: representative.browserSessionId,
    contextIds: annotations.map((item) => item.contextId),
    elements,
    regions,
    strokes,
    ...(representative.comment ? { comment: representative.comment } : {}),
    screenshot: {
      media,
      cropRect: { x: 0, y: 0, width: firstMedia.width, height: firstMedia.height },
    },
    ...(representative.pageUrl ? { pageUrl: representative.pageUrl } : {}),
    ...(representative.pageTitle ? { pageTitle: representative.pageTitle } : {}),
  });
}

/**
 * ANNO-4b attach service. Groups by `annotationId` so a multi-target annotation attaches as exactly
 * ONE composer/agent card (never one per target), passes the group through the agnostic egress
 * chokepoint, and references the shared reference-only `mediaId` (the bytes are already persisted via
 * `recording/sessionMediaWriter` at capture time — attach never inlines bytes). Atomic clear releases
 * the shared `mediaId` once.
 */
export function createBrowserContextAttachService(input: Readonly<{
  store: BrowserContextItemStore;
}>): BrowserContextAttachService {
  function resolveGroup(selector: Readonly<{ annotationId?: string; contextId?: string }>): readonly BrowserContextItemV1[] {
    if (selector.annotationId) return input.store.group(selector.annotationId);
    if (selector.contextId) {
      const annotationId = input.store.annotationIdForContext(selector.contextId);
      if (annotationId) return input.store.group(annotationId);
      const item = input.store.item(selector.contextId);
      return item ? [item] : [];
    }
    return [];
  }

  return {
    attach(request) {
      if (!request.annotationId && !request.contextId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const group = resolveGroup(request);
      if (group.length === 0) {
        return disabled('browser_context_attach_group_missing');
      }
      const egressSafe = group.filter(isBrowserContextItemAgentEgressSafe);
      if (egressSafe.length === 0) {
        // Every item in the group is owner-only full fidelity → refused, never leaked.
        return disabled('browser_context_attach_owner_only');
      }
      const representative = egressSafe[0];
      const groupKey = representative.kind === 'browserAnnotation'
        ? representative.annotationId
        : representative.contextId;
      const mediaIds = [
        ...new Set(egressSafe.map(mediaIdOf).filter((id): id is string => id !== undefined)),
      ];
      const structuredBlock = buildStructuredAnnotationBlock(egressSafe);
      const attachment = BrowserContextAttachmentV1Schema.parse({
        v: 1,
        attachmentId: `browser_context_attachment:${groupKey}`,
        contextId: representative.contextId,
        sourceViewId: representative.sourceViewId,
        capturedNavigationGeneration: representative.navigationGeneration,
        currentNavigationGeneration: representative.navigationGeneration,
        state: 'available',
        requiresReconfirmBeforeSend: false,
        ...(structuredBlock ? { structuredBlock } : {}),
      });
      return {
        ok: true,
        attachment,
        attachedContextIds: egressSafe.map((item) => item.contextId),
        mediaIds,
      };
    },

    clear(request) {
      const result = input.store.clear(request);
      return {
        ok: true,
        clearedItems: result.removedItems,
        releasedMediaIds: result.releasedMediaIds,
      };
    },
  };
}
