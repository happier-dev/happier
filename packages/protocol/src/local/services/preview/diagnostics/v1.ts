import { z } from 'zod';

import { isUnsafeTelemetryDataKey } from '../../../../common/sensitiveKeys.js';
import {
  redactDiagnosticsHeaders,
  redactDiagnosticsUrl,
} from '../../../../browser/diagnostics/egress/headers.js';

const IdSchema = z.string().trim().min(1).max(256);

export const LocalServicePreviewDiagnosticReasonCodeV1Schema = z.enum([
  'invalid_preview_resource',
  'preview_token_secret_missing',
  'preview_public_base_url_missing',
  'preview_not_found',
  'preview_token_missing',
  'token_mismatch',
  'binding_mismatch',
  'expired',
  'not_yet_valid',
  'revoked',
  'host_origin_unavailable',
  'https_required',
  'invalid_public_base_url',
  'path_mode_degraded',
  'path_mode_cookie_semantics_unsupported',
  'service_worker_unavailable_in_path_mode',
  'cookie_isolated',
  'cookie_stripped',
  'upstream_header_stripped',
  'credentials_stripped',
  'method_not_allowed',
  'preview_loop_detected',
  'request_body_too_large',
  'response_body_too_large',
  'response_header_too_large',
  'upstream_response_invalid',
  'upstream_stream_failed',
  'invalid_upgrade_request',
  'web_socket_unavailable',
  'pms_observability_unavailable',
  'pms_relay_unavailable',
  'dns_tls_not_ready',
  'public_policy_denied',
  'public_preview_expired',
  'public_preview_rate_limited',
  'public_preview_revoked',
]);
export type LocalServicePreviewDiagnosticReasonCodeV1 = z.infer<
  typeof LocalServicePreviewDiagnosticReasonCodeV1Schema
>;

export const LocalServicePreviewDiagnosticSeverityV1Schema = z.enum(['info', 'warning', 'error']);
export type LocalServicePreviewDiagnosticSeverityV1 = z.infer<
  typeof LocalServicePreviewDiagnosticSeverityV1Schema
>;

export const LocalServicePreviewDiagnosticScopeV1Schema = z.enum([
  'privatePreview',
  'publicPreview',
  'previewProxy',
]);
export type LocalServicePreviewDiagnosticScopeV1 = z.infer<
  typeof LocalServicePreviewDiagnosticScopeV1Schema
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnsafeDiagnosticDetails(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly (string | number)[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeDiagnosticDetails(item, context, [...path, index]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (isUnsafeTelemetryDataKey(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: 'Local service preview diagnostics must not contain bodies, payloads, cookies, tokens, headers, or grant material.',
      });
      continue;
    }
    rejectUnsafeDiagnosticDetails(nested, context, [...path, key]);
  }
}

export const LocalServicePreviewDiagnosticDetailsV1Schema = z
  .record(z.string(), z.unknown())
  .superRefine(rejectUnsafeDiagnosticDetails);
export type LocalServicePreviewDiagnosticDetailsV1 = z.infer<
  typeof LocalServicePreviewDiagnosticDetailsV1Schema
>;

export const LocalServicePreviewDiagnosticV1Schema = z
  .object({
    v: z.literal(1),
    code: LocalServicePreviewDiagnosticReasonCodeV1Schema,
    severity: LocalServicePreviewDiagnosticSeverityV1Schema,
    scope: LocalServicePreviewDiagnosticScopeV1Schema,
    previewId: IdSchema.optional(),
    publicExposureId: IdSchema.optional(),
    emittedAtMs: z.number().int().nonnegative().optional(),
    details: LocalServicePreviewDiagnosticDetailsV1Schema.optional().default({}),
  })
  .strict();
export type LocalServicePreviewDiagnosticV1 = z.infer<typeof LocalServicePreviewDiagnosticV1Schema>;

export const LocalServicePreviewDiagnosticsV1Schema = z.array(LocalServicePreviewDiagnosticV1Schema);
export type LocalServicePreviewDiagnosticsV1 = z.infer<typeof LocalServicePreviewDiagnosticsV1Schema>;

function diagnosticHeaderNames(value: unknown): readonly string[] {
  const names = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : isRecord(value)
      ? Object.keys(value)
      : [];
  const headers: Record<string, string> = {};
  for (const name of names) {
    headers[name] = 'present';
  }
  return Object.keys(redactDiagnosticsHeaders(headers)).sort();
}

function redactDiagnosticValue(key: string, value: unknown): unknown {
  const normalized = key.trim().toLowerCase();
  if (normalized === 'url' && typeof value === 'string') {
    return redactDiagnosticsUrl(value, { urlBase: 'http://preview.invalid' });
  }
  if (normalized === 'headers') {
    return diagnosticHeaderNames(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => redactDiagnosticValue(key, item))
      .filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    return redactLocalServicePreviewDiagnosticDetails(value);
  }
  if (typeof value === 'string' && value.length > 512) {
    return `${value.slice(0, 512)}...`;
  }
  return value;
}

export function redactLocalServicePreviewDiagnosticDetails(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (isUnsafeTelemetryDataKey(key)) continue;
    const redacted = redactDiagnosticValue(key, rawValue);
    if (redacted === undefined) continue;
    if (Array.isArray(redacted) && redacted.length === 0) continue;
    if (isRecord(redacted) && Object.keys(redacted).length === 0) continue;
    output[key] = redacted;
  }
  return output;
}
