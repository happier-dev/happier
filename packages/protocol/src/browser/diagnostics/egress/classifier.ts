import type { BrowserDiagnosticEventKindV1 } from '../v1.js';
import type { BrowserDiagnosticRedactionLevelV1 } from '../v1.js';

/**
 * Canonical browser-diagnostics egress field classifier.
 *
 * Root cause B: redaction was reimplemented at 4+ capture sites and the per-eventKind allowlists
 * were inlined in `v1.ts`. This module UNIONS those scattered allowlists into one place so every
 * layer (protocol refine, sidecar map, host re-sanitizer, agent-context summarize) classifies the
 * same field the same way. The injected-page schema refinement in `v1.ts` defers to
 * `INJECTED_EVENT_ALLOWED_FIELDS` here.
 *
 * `always-strip` fields are credential-egress vectors that must NEVER survive to any destination,
 * even the local owner — they are dropped at capture: `protocol` (the WS subprotocol smuggling
 * vector, see headers.ts), `cookie`, `authorization`.
 */
export type BrowserDiagnosticFieldDisposition = 'keep' | 'drop' | 'always-strip';

/**
 * Maximum length (in UTF-16 code units) of the length-capped console `text`/`args` rendering the
 * injected collector may surface to the local owner. Mirrors the existing 4 KiB `expressionPreview`
 * cap so the producer (in-page script), the protocol schema, and the host re-sanitizer all agree on
 * one ceiling. A console entry whose `text` exceeds this is rejected (fail-closed) rather than
 * silently truncated downstream.
 */
export const INJECTED_CONSOLE_TEXT_MAX_LENGTH = 4096;
export const INJECTED_OWNER_VALUE_MAX_LENGTH = INJECTED_CONSOLE_TEXT_MAX_LENGTH;

/**
 * Fields that are credential-egress vectors regardless of event kind. Stripped at capture, never
 * surfaced even to the local owner. Names are normalized (lowercase) for comparison.
 */
const ALWAYS_STRIP_FIELD_NAMES: ReadonlySet<string> = new Set([
  'protocol',
  'cookie',
  'cookies',
  'authorization',
]);

/**
 * Per-eventKind allowlists for `injectedPage`-fidelity events. This is the SSOT the protocol schema
 * (`v1.ts refineInjectedDiagnosticData`) consumes. Each set lists the ONLY field names permitted in
 * the event `data` for that kind. Anything else is rejected (`drop`).
 *
 * Note: `network.websocketOpened` intentionally OMITS `protocol` (the leak fix, D4/DUP-2). The
 * injected producer surfaces `hasProtocol`/`protocolCount` instead of the raw subprotocol value.
 */
export const INJECTED_EVENT_ALLOWED_FIELDS: Readonly<
  Partial<Record<BrowserDiagnosticEventKindV1, ReadonlySet<string>>>
> = {
  // `text` is the length-capped console rendering. It is accepted at INGESTION (the local-owner
  // producer emits it) but is an OWNER-ONLY field at egress: kept for `localOwner`, dropped for
  // agent/remote (see `INJECTED_OWNER_ONLY_FIELDS` + `classifyBrowserDiagnosticFieldForDestination`).
  'console.entry': new Set(['level', 'argCount', 'textAvailable', 'text']),
  'pageError.thrown': new Set(['textAvailable']),
  'network.requestStarted': new Set(['requestId', 'url', 'method']),
  'network.finished': new Set(['requestId', 'statusCode']),
  'network.failed': new Set(['requestAvailable', 'errorAvailable']),
  'network.websocketOpened': new Set(['socketId', 'url', 'hasProtocol', 'protocolCount']),
  'network.websocketSummary': new Set([
    'socketId',
    'state',
    'framesSent',
    'framesReceived',
    'bytesSent',
    'bytesReceived',
    'messageCount',
  ]),
  'network.websocketClosed': new Set(['socketId', 'code', 'wasClean']),
  'network.eventSourceOpened': new Set(['sourceId', 'url']),
  'network.eventSourceSummary': new Set(['sourceId', 'state', 'messageCount', 'bytesReceived']),
  'network.eventSourceClosed': new Set(['sourceId', 'state']),
  'network.sendBeacon': new Set(['requestId', 'url', 'bytesQueued', 'accepted']),
  'network.response': new Set([
    'requestId',
    'method',
    'url',
    'statusCode',
    'durationMs',
    'requestBytes',
    'responseBytes',
    'requestHeaders',
    'responseHeaders',
    'requestBodyText',
    'responseBodyText',
    'requestBodyTruncated',
    'responseBodyTruncated',
  ]),
  'storage.keyInventory': new Set(['storageType', 'keyCount', 'keysTruncated', 'keys', 'entries']),
  'pageInfo.snapshot': new Set(['url', 'titleAvailable', 'readyState']),
  'pageInfo.capabilities': new Set([
    'serviceWorker',
    'webgl',
    'webrtc',
    'clipboard',
    'webShare',
    'indexedDbApi',
    'notifications',
    'geolocation',
    'mediaDevices',
    'webAuthn',
    'storage',
    'pushManager',
    'webgpu',
  ]),
  'pageInfo.domSnapshot': new Set(['nodeCount', 'elementCount', 'maxDepth', 'readyState']),
  'performance.vitals': new Set([
    'lcpMs',
    'clsScore',
    'inpMs',
    'fcpMs',
    'longTaskCount',
    'longTaskTotalMs',
    'navResponseEndMs',
    'navDomContentLoadedMs',
    'navLoadEventEndMs',
  ]),
  'elements.pickerState': new Set([
    'pickerRequestId',
    'state',
    'backendNodeRef',
    'selectorPath',
    'rectAvailable',
    'accessibleNameAvailable',
  ]),
  'resources.snapshot': new Set(['entries']),
  'collector.degraded': new Set(['reasonCode']),
  'eval.requested': new Set([
    'evalRequestId',
    'tier',
    'expressionPreview',
    'expressionTruncated',
    'timeoutMs',
    'objectGroupId',
  ]),
  'eval.completed': new Set([
    'evalRequestId',
    'tier',
    'resultType',
    'resultDescriptionAvailable',
    'resultPreviewTruncated',
  ]),
  'eval.failed': new Set(['evalRequestId', 'tier', 'errorAvailable']),
  'eval.timedOut': new Set(['evalRequestId', 'tier', 'timeoutMs']),
};

/**
 * Per-eventKind owner-only fields: allowlisted at INGESTION (the local-owner producer may emit them)
 * but classified `keep` ONLY for the `localOwner` destination and `drop` for agent/remote. This is
 * the plan's destination-based egress model: capture full → render full to the local owner → redact
 * the value-bearing fields at every agent/remote chokepoint.
 *
 * `console.entry.text` is the length-capped console rendering. Adding a field here keeps the
 * destination-agnostic `classifyBrowserDiagnosticField` fail-closed (it reads owner-only fields as
 * `drop`), so any egress path that has not opted into a destination strips them.
 */
export const INJECTED_OWNER_ONLY_FIELDS: Readonly<
  Partial<Record<BrowserDiagnosticEventKindV1, ReadonlySet<string>>>
> = {
  'console.entry': new Set(['text']),
  'network.response': new Set([
    'requestHeaders',
    'responseHeaders',
    'requestBodyText',
    'responseBodyText',
    'requestBodyTruncated',
    'responseBodyTruncated',
  ]),
  'storage.keyInventory': new Set(['entries']),
};

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase();
}

function isOwnerOnlyField(eventKind: BrowserDiagnosticEventKindV1, fieldName: string): boolean {
  return INJECTED_OWNER_ONLY_FIELDS[eventKind]?.has(fieldName) ?? false;
}

/**
 * Classify a single field for a given injected-page event kind, destination-agnostic and fail-closed:
 * - `always-strip`: a credential-egress vector — drop everywhere, even for the local owner.
 * - `keep`: allowlisted for this kind AND not owner-only.
 * - `drop`: owner-only (no destination supplied ⇒ assume non-owner), not allowlisted, or unknown kind.
 *
 * Owner-only fields read as `drop` here so a caller that does not pass a destination never leaks the
 * console text. Use `classifyBrowserDiagnosticFieldForDestination` to keep them for the local owner.
 */
export function classifyBrowserDiagnosticField(
  eventKind: BrowserDiagnosticEventKindV1,
  fieldName: string,
): BrowserDiagnosticFieldDisposition {
  if (ALWAYS_STRIP_FIELD_NAMES.has(normalizeFieldName(fieldName))) return 'always-strip';
  if (isOwnerOnlyField(eventKind, fieldName)) return 'drop';
  const allowed = INJECTED_EVENT_ALLOWED_FIELDS[eventKind];
  if (!allowed) return 'drop';
  return allowed.has(fieldName) ? 'keep' : 'drop';
}

/**
 * Destination-aware field classifier. Identical to `classifyBrowserDiagnosticField` except owner-only
 * fields (`console.entry.text`) are `keep` for the `localOwner` destination and `drop` for
 * `agentContext`/`remoteSnapshot`. `always-strip` vectors are stripped at every destination.
 */
export function classifyBrowserDiagnosticFieldForDestination(
  eventKind: BrowserDiagnosticEventKindV1,
  fieldName: string,
  destination: BrowserDiagnosticEgressDestination,
): BrowserDiagnosticFieldDisposition {
  if (ALWAYS_STRIP_FIELD_NAMES.has(normalizeFieldName(fieldName))) return 'always-strip';
  if (isOwnerOnlyField(eventKind, fieldName)) {
    return destination === 'localOwner' ? 'keep' : 'drop';
  }
  const allowed = INJECTED_EVENT_ALLOWED_FIELDS[eventKind];
  if (!allowed) return 'drop';
  return allowed.has(fieldName) ? 'keep' : 'drop';
}

/**
 * Destination of a diagnostics event. The model is: capture full fidelity, render full to the LOCAL
 * owner, redact ONLY at agent/remote egress.
 * - `localOwner`: the human at the device that owns the browser session (full fidelity allowed).
 * - `agentContext`: serialized into an agent transcript / context (redacted).
 * - `remoteSnapshot`: a cross-device snapshot RPC (redacted).
 */
export type BrowserDiagnosticEgressDestination = 'localOwner' | 'agentContext' | 'remoteSnapshot';

/**
 * Full-fidelity is only honored for the local owner. The `cdp`/`previewProxy` capture fidelities can
 * carry full values for the local owner; everything bound for an agent or a remote device is reduced
 * to metadata.
 *
 * Injected-page events are page-tamperable, so structural injected kinds stay metadata-only at every
 * destination. The ONE exception (DEV-2 reconcile, plan B3 "full fidelity to the LOCAL owner") is the
 * injected console entry: its length-capped `text` is the local owner's own page console output and
 * is rendered at full fidelity (`none`) for the `localOwner` destination with owner-full fidelity.
 * It still reduces to `metadataOnly` for agent/remote, preserving the WS-leak / secret-drop model.
 */
export function resolveRedactionLevel(
  eventKind: BrowserDiagnosticEventKindV1,
  destination: BrowserDiagnosticEgressDestination,
  fidelity: Readonly<{ injected: boolean; ownerFull: boolean }>,
): BrowserDiagnosticRedactionLevelV1 {
  if (fidelity.injected) {
    // Injected owner-only values are the local owner's own diagnostics view; surface them full only to
    // that owner. Agent/remote egress stays metadata-only and strips the owner-only fields.
    if (
      destination === 'localOwner'
      && fidelity.ownerFull
      && (INJECTED_OWNER_ONLY_FIELDS[eventKind]?.size ?? 0) > 0
    ) {
      return 'none';
    }
    // Every other injected (page-tamperable) field stays metadata-only, even locally.
    return 'metadataOnly';
  }
  if (destination === 'localOwner' && fidelity.ownerFull) return 'none';
  return 'metadataOnly';
}

export { ALWAYS_STRIP_FIELD_NAMES };
