import { z } from 'zod';

import { isRecord } from '../../common/records.js';
import {
  INJECTED_CONSOLE_TEXT_MAX_LENGTH,
  INJECTED_EVENT_ALLOWED_FIELDS,
  INJECTED_OWNER_VALUE_MAX_LENGTH,
} from './egress/classifier.js';
import { isSafeTelemetryHeaderName } from './egress/headers.js';
import { rejectUnsafeBrowserEgressKeys } from './egress/keyRejection.js';

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();
const EvalInlineStringValueSchema = z.string().max(1024);
const ExpandedPropertyStringValueSchema = z.string().max(65_536);

export const BrowserDiagnosticFamilyV1Schema = z.enum([
  'console',
  'pageError',
  'network',
  'elements',
  'resources',
  'storage',
  'pageInfo',
  'performance',
  'screenshot',
  'proxyTunnel',
]);
export type BrowserDiagnosticFamilyV1 = z.infer<typeof BrowserDiagnosticFamilyV1Schema>;

export const BrowserDiagnosticFidelityV1Schema = z.enum([
  'cdp',
  'previewProxy',
  'injectedPage',
  'nativeCallback',
  'streamFrame',
  'unavailable',
]);
export type BrowserDiagnosticFidelityV1 = z.infer<typeof BrowserDiagnosticFidelityV1Schema>;

export const BrowserDiagnosticRedactionLevelV1Schema = z.enum([
  'none',
  'metadataOnly',
  'valuesRedacted',
  'unavailable',
]);
export type BrowserDiagnosticRedactionLevelV1 = z.infer<typeof BrowserDiagnosticRedactionLevelV1Schema>;

export const BrowserDiagnosticRedactionV1Schema = z
  .object({
    level: BrowserDiagnosticRedactionLevelV1Schema,
    queryRedacted: z.boolean().optional().default(true),
    headersRedacted: z.boolean().optional().default(true),
    truncated: z.boolean().optional().default(false),
  })
  .strict();
export type BrowserDiagnosticRedactionV1 = z.infer<typeof BrowserDiagnosticRedactionV1Schema>;

export const BrowserDiagnosticCollectorV1Schema = z
  .object({
    collectorId: IdSchema,
    nonce: z.string().trim().min(1).max(512),
    version: z.string().trim().min(1).max(64),
  })
  .strict();
export type BrowserDiagnosticCollectorV1 = z.infer<typeof BrowserDiagnosticCollectorV1Schema>;

export const BrowserDiagnosticUnavailableReasonV1Schema = z.enum([
  'feature_disabled',
  'adapter_unavailable',
  'policy_denied',
  'collector_denied',
  'collector_unavailable',
  'collector_degraded',
  'navigation_stale',
  'target_detached',
  'page_crashed',
  'unsupported_fidelity',
]);
export type BrowserDiagnosticUnavailableReasonV1 = z.infer<
  typeof BrowserDiagnosticUnavailableReasonV1Schema
>;

export const BrowserDiagnosticEventKindV1Schema = z.enum([
  'console.entry',
  'pageError.thrown',
  'network.requestStarted',
  'network.response',
  'network.finished',
  'network.failed',
  'network.redirect',
  'network.websocketOpened',
  'network.websocketSummary',
  'network.websocketClosed',
  'network.eventSourceOpened',
  'network.eventSourceSummary',
  'network.eventSourceClosed',
  'network.sendBeacon',
  'elements.snapshot',
  'elements.pickerState',
  'resources.snapshot',
  'storage.availability',
  'storage.keyInventory',
  'pageInfo.snapshot',
  'pageInfo.capabilities',
  'pageInfo.domSnapshot',
  'performance.vitals',
  'screenshot.metadata',
  'proxyTunnel.snapshot',
  'diagnostics.unavailable',
  'eval.requested',
  'eval.completed',
  'eval.failed',
  'eval.timedOut',
  'collector.degraded',
]);
export type BrowserDiagnosticEventKindV1 = z.infer<typeof BrowserDiagnosticEventKindV1Schema>;

const DiagnosticDataSchema = z.record(z.string(), z.unknown()).superRefine((data, context) =>
  rejectUnsafeBrowserEgressKeys(data, context, {
    message: 'Browser diagnostics data must not contain bodies, payloads, cookies, tokens, or storage values.',
  }));

function addInjectedDiagnosticDataIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['data', ...path],
    message: 'Injected browser diagnostics may only contain allowlisted redacted metadata fields.',
  });
}

function rejectUnknownInjectedDiagnosticKeys(
  data: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  for (const key of Object.keys(data)) {
    if (allowedKeys.has(key)) continue;
    addInjectedDiagnosticDataIssue(context, [key]);
  }
}

function refineInjectedResourceEntries(value: unknown, context: z.RefinementCtx): void {
  if (!Array.isArray(value)) {
    addInjectedDiagnosticDataIssue(context, ['entries']);
    return;
  }

  const allowedEntryKeys = new Set(['name', 'initiatorType', 'durationMs']);
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      addInjectedDiagnosticDataIssue(context, ['entries', index]);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (allowedEntryKeys.has(key)) continue;
      addInjectedDiagnosticDataIssue(context, ['entries', index, key]);
    }
  });
}

function injectedAllowedFields(kind: BrowserDiagnosticEventKindV1): ReadonlySet<string> {
  return INJECTED_EVENT_ALLOWED_FIELDS[kind] ?? new Set<string>();
}

const INJECTED_PERFORMANCE_VITALS_KEYS = injectedAllowedFields('performance.vitals');

const INJECTED_PAGE_CAPABILITY_KEYS = injectedAllowedFields('pageInfo.capabilities');

// DOM snapshot allows structural numeric counts plus a `readyState` string (handled separately);
// the numeric refinement must only cover the integer count keys.
const INJECTED_DOM_SNAPSHOT_NUMERIC_KEYS = new Set(
  [...injectedAllowedFields('pageInfo.domSnapshot')].filter((key) => key !== 'readyState'),
);

function omitInjectedDataKeys(
  data: Readonly<Record<string, unknown>>,
  omit: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (omit.has(key)) continue;
    result[key] = value;
  }
  return result;
}

function refineInjectedStorageKeyInventory(
  data: Readonly<Record<string, unknown>>,
  context: z.RefinementCtx,
): void {
  if (data.storageType !== 'localStorage' && data.storageType !== 'sessionStorage') {
    addInjectedDiagnosticDataIssue(context, ['storageType']);
  }
  if ('keyCount' in data && (typeof data.keyCount !== 'number' || !Number.isInteger(data.keyCount) || data.keyCount < 0)) {
    addInjectedDiagnosticDataIssue(context, ['keyCount']);
  }
  if ('keysTruncated' in data && typeof data.keysTruncated !== 'boolean') {
    addInjectedDiagnosticDataIssue(context, ['keysTruncated']);
  }
  if (!Array.isArray(data.keys)) {
    addInjectedDiagnosticDataIssue(context, ['keys']);
    return;
  }
  data.keys.forEach((key, index) => {
    if (typeof key !== 'string') {
      addInjectedDiagnosticDataIssue(context, ['keys', index]);
    }
  });
  if ('entries' in data) {
    if (!Array.isArray(data.entries)) {
      addInjectedDiagnosticDataIssue(context, ['entries']);
      return;
    }
    data.entries.forEach((entry, index) => {
      if (!isRecord(entry)) {
        addInjectedDiagnosticDataIssue(context, ['entries', index]);
        return;
      }
      rejectUnknownInjectedDiagnosticKeys(entry, new Set(['key', 'value', 'valueTruncated']), context);
      if (typeof entry.key !== 'string' || entry.key.length > 256) {
        addInjectedDiagnosticDataIssue(context, ['entries', index, 'key']);
      }
      if (typeof entry.value !== 'string' || entry.value.length > INJECTED_OWNER_VALUE_MAX_LENGTH) {
        addInjectedDiagnosticDataIssue(context, ['entries', index, 'value']);
      }
      if ('valueTruncated' in entry && typeof entry.valueTruncated !== 'boolean') {
        addInjectedDiagnosticDataIssue(context, ['entries', index, 'valueTruncated']);
      }
    });
  }
}

function refineInjectedHeaderBag(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (!isRecord(value)) {
    addInjectedDiagnosticDataIssue(context, path);
    return;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!isSafeTelemetryHeaderName(name)) {
      addInjectedDiagnosticDataIssue(context, [...path, name]);
      continue;
    }
    if (typeof headerValue !== 'string' || headerValue.length > INJECTED_OWNER_VALUE_MAX_LENGTH) {
      addInjectedDiagnosticDataIssue(context, [...path, name]);
    }
  }
}

function refineInjectedNetworkResponse(
  data: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  rejectUnknownInjectedDiagnosticKeys(data, allowed, context);
  for (const key of ['requestId', 'method', 'url'] as const) {
    if (key in data && typeof data[key] !== 'string') {
      addInjectedDiagnosticDataIssue(context, [key]);
    }
  }
  for (const key of ['statusCode', 'durationMs', 'requestBytes', 'responseBytes'] as const) {
    if (key in data && (typeof data[key] !== 'number' || !Number.isFinite(data[key]))) {
      addInjectedDiagnosticDataIssue(context, [key]);
    }
  }
  for (const key of ['requestBodyText', 'responseBodyText'] as const) {
    if (key in data && (typeof data[key] !== 'string' || data[key].length > INJECTED_OWNER_VALUE_MAX_LENGTH)) {
      addInjectedDiagnosticDataIssue(context, [key]);
    }
  }
  for (const key of ['requestBodyTruncated', 'responseBodyTruncated'] as const) {
    if (key in data && typeof data[key] !== 'boolean') {
      addInjectedDiagnosticDataIssue(context, [key]);
    }
  }
  if ('requestHeaders' in data) {
    refineInjectedHeaderBag(data.requestHeaders, context, ['requestHeaders']);
  }
  if ('responseHeaders' in data) {
    refineInjectedHeaderBag(data.responseHeaders, context, ['responseHeaders']);
  }
}

function refineInjectedNumericMetadata(
  data: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  for (const [key, value] of Object.entries(data)) {
    if (!allowedKeys.has(key)) {
      addInjectedDiagnosticDataIssue(context, [key]);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      addInjectedDiagnosticDataIssue(context, [key]);
    }
  }
}

function refineInjectedBooleanMetadata(
  data: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  for (const [key, value] of Object.entries(data)) {
    if (!allowedKeys.has(key)) {
      addInjectedDiagnosticDataIssue(context, [key]);
      continue;
    }
    if (typeof value !== 'boolean') {
      addInjectedDiagnosticDataIssue(context, [key]);
    }
  }
}

function refineInjectedDiagnosticData(
  event: {
    fidelity: BrowserDiagnosticFidelityV1;
    kind: BrowserDiagnosticEventKindV1;
    data: Record<string, unknown>;
  },
  context: z.RefinementCtx,
): void {
  if (event.fidelity !== 'injectedPage') return;

  // Allowlists are derived from the single egress SSOT (`INJECTED_EVENT_ALLOWED_FIELDS`) so the
  // protocol refine, sidecar map, host re-sanitizer, and agent-context summarize never drift.
  const allowed = injectedAllowedFields(event.kind);

  switch (event.kind) {
    case 'console.entry':
      // Allowlisted metadata + the OWNER-ONLY length-capped `text` (DEV-2). `text` is accepted at
      // ingestion (the local-owner producer emits it) but is stripped for agent/remote by the egress
      // classifier (`INJECTED_OWNER_ONLY_FIELDS`). Injected events are page-tamperable, so enforce the
      // 4 KiB cap here (fail-closed: reject an over-cap rendering rather than truncate downstream).
      rejectUnknownInjectedDiagnosticKeys(event.data, allowed, context);
      if (
        'text' in event.data
        && (typeof event.data.text !== 'string' || event.data.text.length > INJECTED_CONSOLE_TEXT_MAX_LENGTH)
      ) {
        addInjectedDiagnosticDataIssue(context, ['text']);
      }
      return;
    case 'storage.keyInventory':
      rejectUnknownInjectedDiagnosticKeys(event.data, allowed, context);
      refineInjectedStorageKeyInventory(event.data, context);
      return;
    case 'network.response':
      refineInjectedNetworkResponse(event.data, allowed, context);
      return;
    case 'pageInfo.domSnapshot':
      // Structural counts only — never page text, attribute values, or serialized markup.
      refineInjectedNumericMetadata(
        omitInjectedDataKeys(event.data, new Set(['readyState'])),
        INJECTED_DOM_SNAPSHOT_NUMERIC_KEYS,
        context,
      );
      if ('readyState' in event.data && typeof event.data.readyState !== 'string') {
        addInjectedDiagnosticDataIssue(context, ['readyState']);
      }
      return;
    case 'performance.vitals':
      refineInjectedNumericMetadata(event.data, INJECTED_PERFORMANCE_VITALS_KEYS, context);
      return;
    case 'pageInfo.capabilities':
      refineInjectedBooleanMetadata(event.data, INJECTED_PAGE_CAPABILITY_KEYS, context);
      return;
    case 'resources.snapshot':
      rejectUnknownInjectedDiagnosticKeys(event.data, allowed, context);
      refineInjectedResourceEntries(event.data.entries, context);
      return;
    default:
      // Every other injected kind is a flat allowlist check sourced from the SSOT. Unknown kinds
      // resolve to an empty set, rejecting all data.
      rejectUnknownInjectedDiagnosticKeys(event.data, allowed, context);
  }
}

export const BrowserDiagnosticEventV1Schema = z
  .object({
    v: z.literal(1),
    eventId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    capturedAtMs: NonNegativeIntSchema,
    family: BrowserDiagnosticFamilyV1Schema,
    kind: BrowserDiagnosticEventKindV1Schema,
    fidelity: BrowserDiagnosticFidelityV1Schema,
    trusted: z.boolean(),
    collector: BrowserDiagnosticCollectorV1Schema.optional(),
    data: DiagnosticDataSchema.optional().default({}),
    redaction: BrowserDiagnosticRedactionV1Schema,
    unavailableReason: BrowserDiagnosticUnavailableReasonV1Schema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.fidelity === 'injectedPage' && event.trusted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trusted'],
        message: 'Injected browser diagnostics are page-tamperable and must be marked untrusted.',
      });
    }
    if (event.fidelity === 'injectedPage' && !event.collector) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collector'],
        message: 'Injected browser diagnostics require collector id, nonce, and version metadata.',
      });
    }
    refineInjectedDiagnosticData(event, context);
  });
export type BrowserDiagnosticEventV1 = z.infer<typeof BrowserDiagnosticEventV1Schema>;

export const BrowserDiagnosticEventBatchV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.events'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    events: z.array(BrowserDiagnosticEventV1Schema).max(200),
  })
  .strict()
  .superRefine((batch, context) => {
    batch.events.forEach((event, index) => {
      if (event.browserSessionId !== batch.browserSessionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'browserSessionId'],
          message: 'Diagnostic batch event browserSessionId must match batch browserSessionId.',
        });
      }
      if (event.viewId !== batch.viewId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'viewId'],
          message: 'Diagnostic batch event viewId must match batch viewId.',
        });
      }
      if (event.navigationGeneration !== batch.navigationGeneration) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'navigationGeneration'],
          message: 'Diagnostic batch event navigationGeneration must match batch navigationGeneration.',
        });
      }
      if (event.fidelity !== 'injectedPage') return;
      if (event.collector?.collectorId !== batch.collector.collectorId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'collector', 'collectorId'],
          message: 'Injected diagnostic event collectorId must match batch collectorId.',
        });
      }
      if (event.collector?.nonce !== batch.collector.nonce) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'collector', 'nonce'],
          message: 'Injected diagnostic event nonce must match batch nonce.',
        });
      }
      if (event.collector?.version !== batch.collector.version) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'collector', 'version'],
          message: 'Injected diagnostic event version must match batch version.',
        });
      }
    });
  });
export type BrowserDiagnosticEventBatchV1 = z.infer<typeof BrowserDiagnosticEventBatchV1Schema>;

export const BrowserDiagnosticsSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    machineId: IdSchema,
    generatedAt: NonNegativeIntSchema,
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    events: z.array(BrowserDiagnosticEventV1Schema).max(5_000),
    diagnostics: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict();
export type BrowserDiagnosticsSnapshotV1 = z.infer<typeof BrowserDiagnosticsSnapshotV1Schema>;

export const DaemonBrowserDiagnosticsSnapshotRequestV1Schema = z
  .object({
    machineId: IdSchema,
  })
  .strict();
export type DaemonBrowserDiagnosticsSnapshotRequestV1 = z.infer<
  typeof DaemonBrowserDiagnosticsSnapshotRequestV1Schema
>;

export const DaemonBrowserDiagnosticsSnapshotResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    snapshot: BrowserDiagnosticsSnapshotV1Schema,
  })
  .strict();
export type DaemonBrowserDiagnosticsSnapshotResponseV1 = z.infer<
  typeof DaemonBrowserDiagnosticsSnapshotResponseV1Schema
>;

export const BrowserDiagnosticsRemoteObjectPreviewPropertyV1Schema = z
  .object({
    name: z.string().trim().min(1).max(256),
    valuePreview: z.string().max(1024),
    truncated: z.boolean().optional().default(false),
  })
  .strict();
export type BrowserDiagnosticsRemoteObjectPreviewPropertyV1 = z.infer<
  typeof BrowserDiagnosticsRemoteObjectPreviewPropertyV1Schema
>;

export const BrowserDiagnosticsRemoteObjectV1Schema = z
  .object({
    type: z.enum(['undefined', 'null', 'boolean', 'number', 'string', 'symbol', 'bigint', 'object', 'function']),
    value: z.union([EvalInlineStringValueSchema, z.number(), z.boolean(), z.null()]).optional(),
    objectId: IdSchema.optional(),
    className: z.string().trim().min(1).max(256).optional(),
    description: z.string().max(1024).optional(),
    preview: z.array(BrowserDiagnosticsRemoteObjectPreviewPropertyV1Schema).max(10).optional().default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.type === 'object' || value.type === 'function') && !value.objectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectId'],
        message: 'Object and function eval results must use remote-object references.',
      });
    }
  });
export type BrowserDiagnosticsRemoteObjectV1 = z.infer<typeof BrowserDiagnosticsRemoteObjectV1Schema>;

export const BrowserDiagnosticsExpandedRemoteObjectV1Schema = z
  .object({
    type: z.enum(['undefined', 'null', 'boolean', 'number', 'string', 'symbol', 'bigint', 'object', 'function']),
    value: z.union([ExpandedPropertyStringValueSchema, z.number(), z.boolean(), z.null()]).optional(),
    objectId: IdSchema.optional(),
    className: z.string().trim().min(1).max(256).optional(),
    description: z.string().max(1024).optional(),
    preview: z.array(BrowserDiagnosticsRemoteObjectPreviewPropertyV1Schema).max(10).optional().default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.type === 'object' || value.type === 'function') && !value.objectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectId'],
        message: 'Object and function expanded property values must use remote-object references.',
      });
    }
  });
export type BrowserDiagnosticsExpandedRemoteObjectV1 = z.infer<
  typeof BrowserDiagnosticsExpandedRemoteObjectV1Schema
>;

export const BrowserDiagnosticsEvalTierV1Schema = z.enum(['cdp', 'injectedPage']);
export type BrowserDiagnosticsEvalTierV1 = z.infer<typeof BrowserDiagnosticsEvalTierV1Schema>;

export const BrowserDiagnosticsEvalRequestV1Schema = z
  .object({
    v: z.literal(1),
    evalRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    expression: z.string().trim().min(1).max(4096),
    timeoutMs: z.number().int().positive().max(10_000).optional().default(2000),
    objectGroupId: IdSchema,
    diagnosticsInteractionEnabled: z.literal(true),
  })
  .strict();
export type BrowserDiagnosticsEvalRequestV1 = z.infer<typeof BrowserDiagnosticsEvalRequestV1Schema>;

export const BrowserDiagnosticsEvalResultV1Schema = z
  .object({
    v: z.literal(1),
    evalRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    status: z.enum(['completed', 'failed', 'timedOut', 'blocked', 'collectorDegraded']),
    tier: BrowserDiagnosticsEvalTierV1Schema,
    audited: z.literal(true),
    result: BrowserDiagnosticsRemoteObjectV1Schema.optional(),
    errorCode: BrowserDiagnosticUnavailableReasonV1Schema.optional(),
  })
  .strict();
export type BrowserDiagnosticsEvalResultV1 = z.infer<typeof BrowserDiagnosticsEvalResultV1Schema>;

export const BrowserDiagnosticsEvalCommandMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.evalRequest'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    request: BrowserDiagnosticsEvalRequestV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.request.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'viewId'],
        message: 'Eval request viewId must match message viewId.',
      });
    }
    if (message.request.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'navigationGeneration'],
        message: 'Eval request navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.request.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'tier'],
        message: 'Injected eval command messages may only target the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsEvalCommandMessageV1 = z.infer<
  typeof BrowserDiagnosticsEvalCommandMessageV1Schema
>;

export const BrowserDiagnosticsEvalResultMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.evalResult'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    result: BrowserDiagnosticsEvalResultV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.result.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'viewId'],
        message: 'Eval result viewId must match message viewId.',
      });
    }
    if (message.result.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'navigationGeneration'],
        message: 'Eval result navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.result.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'tier'],
        message: 'Injected eval result messages may only publish the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsEvalResultMessageV1 = z.infer<
  typeof BrowserDiagnosticsEvalResultMessageV1Schema
>;

export const BrowserDiagnosticsGetPropertiesRequestV1Schema = z
  .object({
    v: z.literal(1),
    propertyRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    objectId: IdSchema,
    objectGroupId: IdSchema,
    diagnosticsInteractionEnabled: z.literal(true),
  })
  .strict();
export type BrowserDiagnosticsGetPropertiesRequestV1 = z.infer<
  typeof BrowserDiagnosticsGetPropertiesRequestV1Schema
>;

export const BrowserDiagnosticsObjectPropertyV1Schema = z
  .object({
    name: z.string().trim().min(1).max(256),
    value: BrowserDiagnosticsExpandedRemoteObjectV1Schema,
    enumerable: z.boolean().optional().default(false),
  })
  .strict();
export type BrowserDiagnosticsObjectPropertyV1 = z.infer<
  typeof BrowserDiagnosticsObjectPropertyV1Schema
>;

export const BrowserDiagnosticsGetPropertiesResultV1Schema = z
  .object({
    v: z.literal(1),
    propertyRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    status: z.enum(['completed', 'failed', 'blocked', 'collectorDegraded']),
    audited: z.literal(true),
    objectId: IdSchema,
    properties: z.array(BrowserDiagnosticsObjectPropertyV1Schema).max(100).optional().default([]),
    errorCode: BrowserDiagnosticUnavailableReasonV1Schema.optional(),
  })
  .strict();
export type BrowserDiagnosticsGetPropertiesResultV1 = z.infer<
  typeof BrowserDiagnosticsGetPropertiesResultV1Schema
>;

export const BrowserDiagnosticsGetPropertiesCommandMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.getPropertiesRequest'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    request: BrowserDiagnosticsGetPropertiesRequestV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.request.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'viewId'],
        message: 'Get-properties request viewId must match message viewId.',
      });
    }
    if (message.request.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'navigationGeneration'],
        message: 'Get-properties request navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.request.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'tier'],
        message: 'Injected get-properties command messages may only target the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsGetPropertiesCommandMessageV1 = z.infer<
  typeof BrowserDiagnosticsGetPropertiesCommandMessageV1Schema
>;

export const BrowserDiagnosticsGetPropertiesResultMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.getPropertiesResult'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    result: BrowserDiagnosticsGetPropertiesResultV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.result.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'viewId'],
        message: 'Get-properties result viewId must match message viewId.',
      });
    }
    if (message.result.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'navigationGeneration'],
        message: 'Get-properties result navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.result.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'tier'],
        message: 'Injected get-properties result messages may only publish the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsGetPropertiesResultMessageV1 = z.infer<
  typeof BrowserDiagnosticsGetPropertiesResultMessageV1Schema
>;

export const BrowserDiagnosticsReleaseObjectGroupRequestV1Schema = z
  .object({
    v: z.literal(1),
    releaseRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    objectGroupId: IdSchema,
    diagnosticsInteractionEnabled: z.literal(true),
  })
  .strict();
export type BrowserDiagnosticsReleaseObjectGroupRequestV1 = z.infer<
  typeof BrowserDiagnosticsReleaseObjectGroupRequestV1Schema
>;

export const BrowserDiagnosticsReleaseObjectGroupResultV1Schema = z
  .object({
    v: z.literal(1),
    releaseRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    status: z.enum(['completed', 'failed', 'blocked', 'collectorDegraded']),
    audited: z.literal(true),
    objectGroupId: IdSchema,
    errorCode: BrowserDiagnosticUnavailableReasonV1Schema.optional(),
  })
  .strict();
export type BrowserDiagnosticsReleaseObjectGroupResultV1 = z.infer<
  typeof BrowserDiagnosticsReleaseObjectGroupResultV1Schema
>;

export const BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.releaseObjectGroupRequest'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    request: BrowserDiagnosticsReleaseObjectGroupRequestV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.request.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'viewId'],
        message: 'Release-object-group request viewId must match message viewId.',
      });
    }
    if (message.request.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'navigationGeneration'],
        message: 'Release-object-group request navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.request.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'tier'],
        message: 'Injected release-object-group command messages may only target the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsReleaseObjectGroupCommandMessageV1 = z.infer<
  typeof BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema
>;

export const BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.releaseObjectGroupResult'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    result: BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.result.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'viewId'],
        message: 'Release-object-group result viewId must match message viewId.',
      });
    }
    if (message.result.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'navigationGeneration'],
        message: 'Release-object-group result navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.result.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'tier'],
        message: 'Injected release-object-group result messages may only publish the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsReleaseObjectGroupResultMessageV1 = z.infer<
  typeof BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema
>;

export const BrowserDiagnosticsElementPickerActionV1Schema = z.enum(['start', 'cancel']);
export type BrowserDiagnosticsElementPickerActionV1 = z.infer<
  typeof BrowserDiagnosticsElementPickerActionV1Schema
>;

export const BrowserDiagnosticsElementPickerRectV1Schema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
export type BrowserDiagnosticsElementPickerRectV1 = z.infer<
  typeof BrowserDiagnosticsElementPickerRectV1Schema
>;

export const BrowserDiagnosticsElementPickerRequestV1Schema = z
  .object({
    v: z.literal(1),
    pickerRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    action: BrowserDiagnosticsElementPickerActionV1Schema,
    diagnosticsInteractionEnabled: z.literal(true),
  })
  .strict();
export type BrowserDiagnosticsElementPickerRequestV1 = z.infer<
  typeof BrowserDiagnosticsElementPickerRequestV1Schema
>;

export const BrowserDiagnosticsElementSourceLocationV1Schema = z
  .object({
    file: z.string().trim().min(1).max(1024),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();
export type BrowserDiagnosticsElementSourceLocationV1 = z.infer<
  typeof BrowserDiagnosticsElementSourceLocationV1Schema
>;

export const BrowserDiagnosticsElementPickerResultV1Schema = z
  .object({
    v: z.literal(1),
    pickerRequestId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    tier: BrowserDiagnosticsEvalTierV1Schema,
    status: z.enum(['selected', 'cancelled', 'blocked', 'failed', 'collectorDegraded']),
    audited: z.literal(true),
    backendNodeRef: IdSchema.optional(),
    selectorPath: z.string().trim().min(1).max(2048).optional(),
    rect: BrowserDiagnosticsElementPickerRectV1Schema.optional(),
    accessibleName: z.string().max(512).optional(),
    /**
     * UB-7. The component that rendered the picked node and the source file it came from, read
     * from the framework metadata the page already exposes (React fiber). Absent whenever the page
     * is not a dev-build React tree — a picked element is still fully usable without them.
     */
    componentName: z.string().trim().min(1).max(128).optional(),
    sourceLocation: BrowserDiagnosticsElementSourceLocationV1Schema.optional(),
    errorCode: BrowserDiagnosticUnavailableReasonV1Schema.optional(),
  })
  .strict();
export type BrowserDiagnosticsElementPickerResultV1 = z.infer<
  typeof BrowserDiagnosticsElementPickerResultV1Schema
>;

export const BrowserDiagnosticsElementPickerCommandMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.elementPickerRequest'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    request: BrowserDiagnosticsElementPickerRequestV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.request.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'viewId'],
        message: 'Element-picker request viewId must match message viewId.',
      });
    }
    if (message.request.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'navigationGeneration'],
        message: 'Element-picker request navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.request.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request', 'tier'],
        message: 'Injected element-picker command messages may only target the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsElementPickerCommandMessageV1 = z.infer<
  typeof BrowserDiagnosticsElementPickerCommandMessageV1Schema
>;

export const BrowserDiagnosticsElementPickerResultMessageV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('browser.diagnostics.elementPickerResult'),
    browserSessionId: IdSchema,
    viewId: IdSchema,
    navigationGeneration: NonNegativeIntSchema,
    collector: BrowserDiagnosticCollectorV1Schema,
    result: BrowserDiagnosticsElementPickerResultV1Schema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.result.viewId !== message.viewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'viewId'],
        message: 'Element-picker result viewId must match message viewId.',
      });
    }
    if (message.result.navigationGeneration !== message.navigationGeneration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'navigationGeneration'],
        message: 'Element-picker result navigationGeneration must match message navigationGeneration.',
      });
    }
    if (message.result.tier !== 'injectedPage') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'tier'],
        message: 'Injected element-picker result messages may only publish the injectedPage tier.',
      });
    }
  });
export type BrowserDiagnosticsElementPickerResultMessageV1 = z.infer<
  typeof BrowserDiagnosticsElementPickerResultMessageV1Schema
>;
