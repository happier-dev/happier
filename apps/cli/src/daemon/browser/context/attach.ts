import { buildBrowserContextAnnotationStructuredBlockV2 } from '@happier-dev/protocol/browser/context/annotationStructuredBlock';
import { BrowserContextAttachmentV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { classifyBrowserDiagnosticFieldForDestination } from '@happier-dev/protocol/browser/diagnostics/egress/classifier';
import type { BrowserContextAttachmentV1, BrowserContextItemV1 } from '@happier-dev/protocol';

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
  /** The single context item represented by this attachment. */
  attachedContextIds: readonly string[];
  /** The flattened annotation image or screenshot reference. */
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
  if (item.kind === 'browserAnnotation') return item.imageRef.mediaId;
  if (item.kind === 'browserScreenshot') return item.media.mediaId;
  return undefined;
}

/** Attach one captured item through the existing egress owner. Annotation pixels use the composer path. */
export function createBrowserContextAttachService(input: Readonly<{
  store: BrowserContextItemStore;
}>): BrowserContextAttachService {
  return {
    attach(request) {
      if (!request.annotationId && !request.contextId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const item = request.annotationId
        ? input.store.annotation(request.annotationId)
        : request.contextId ? input.store.item(request.contextId) : undefined;
      if (!item) return disabled('browser_context_item_missing');
      if (!isBrowserContextItemAgentEgressSafe(item)) return disabled('browser_context_attach_owner_only');
      const key = item.kind === 'browserAnnotation' ? item.annotationId : item.contextId;
      const structuredBlock = item.kind === 'browserAnnotation'
        ? buildBrowserContextAnnotationStructuredBlockV2(item)
        : undefined;
      const attachment = BrowserContextAttachmentV1Schema.parse({
        v: 1,
        attachmentId: `browser_context_attachment:${key}`,
        contextId: item.contextId,
        sourceViewId: item.sourceViewId,
        capturedNavigationGeneration: item.navigationGeneration,
        currentNavigationGeneration: item.navigationGeneration,
        state: 'available',
        requiresReconfirmBeforeSend: false,
        ...(structuredBlock ? { structuredBlock } : {}),
      });
      const mediaId = mediaIdOf(item);
      return { ok: true, attachment, attachedContextIds: [item.contextId], mediaIds: mediaId ? [mediaId] : [] };
    },
    clear(request) {
      const result = input.store.clear(request);
      return { ok: true, clearedItems: result.removedItems, releasedMediaIds: result.releasedMediaIds };
    },
  };
}
