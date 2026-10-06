import { buildBrowserContextAnnotationStructuredBlock } from '@happier-dev/protocol/browser/context/annotationStructuredBlock';
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
      const structuredBlock = buildBrowserContextAnnotationStructuredBlock(egressSafe);
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
