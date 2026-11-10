import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { isUnsafeTelemetryDataKey } from '../../../common/sensitiveKeys.js';
import { PrincipalRefV1Schema } from '../../../teams/principal.js';
import { LocalServicePreviewDiagnosticV1Schema } from '../preview/diagnostics/v1.js';
import { LocalServicePreviewServiceTargetV1Schema, refineLocalServicePreviewServiceBindingV1,
  type LocalServicePreviewServiceTargetV1 } from '../preview/v1.js';

function refinePublicServiceBinding(value: Readonly<{ machineId: string; sessionId?: string; serviceTarget?: LocalServicePreviewServiceTargetV1 }>, context: z.core.$RefinementCtx): void {
  refineLocalServicePreviewServiceBindingV1(value, context);
  if (!value.sessionId && !value.serviceTarget) context.addIssue({ code: "custom", path: ['sessionId'], message: 'Public exposure requires a Session or current service binding.' });
}

function hasHttpProtocol(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnsafeLocalServicePublicPolicyDiagnosticKeys(
  value: unknown,
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeLocalServicePublicPolicyDiagnosticKeys(item, context, [...path, index]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (isUnsafeTelemetryDataKey(key)) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: 'Public local service policy diagnostics must not contain bodies, cookies, tokens, headers, or grant material.',
      });
      continue;
    }
    rejectUnsafeLocalServicePublicPolicyDiagnosticKeys(nested, context, [...path, key]);
  }
}

/**
 * `people`: signed-in Happier Accounts in the exposure's audience (resource-grant principals),
 * admitted once when their browser exchanges a one-use admission URL. No Machine admission.
 * `secret_link`: anyone holding the link. `public`: anyone.
 */
export const LocalServicePublicExposureModeV1Schema = lazyZodSchema(() => z.enum(['people', 'secret_link', 'public']));
export type LocalServicePublicExposureModeV1 = z.infer<typeof LocalServicePublicExposureModeV1Schema>;

/** The exposure's audience: the same Account/Team/Group principals every resource grant names. */
export const LocalServicePublicExposureAudienceV1Schema = lazyZodSchema(() => z.array(PrincipalRefV1Schema));
export type LocalServicePublicExposureAudienceV1 = z.infer<typeof LocalServicePublicExposureAudienceV1Schema>;

/** A `people` exposure names its audience; the other modes carry none. */
function refineExposureAudience(
  value: Readonly<{ mode: LocalServicePublicExposureModeV1; audience?: LocalServicePublicExposureAudienceV1 }>,
  context: z.core.$RefinementCtx,
): void {
  if (value.mode === 'people' && (!value.audience || value.audience.length === 0)) {
    context.addIssue({ code: 'custom', path: ['audience'], message: 'A people share names at least one person, Team or Group.' });
  }
  if (value.mode !== 'people' && value.audience !== undefined) {
    context.addIssue({ code: 'custom', path: ['audience'], message: 'Only a people share carries an audience.' });
  }
}

export const LocalServicePublicExposureStateV1Schema = lazyZodSchema(() => z.enum(['pending', 'active', 'revoked', 'expired', 'rate_limited']));
export type LocalServicePublicExposureStateV1 = z.infer<typeof LocalServicePublicExposureStateV1Schema>;

export const LocalServicePublicPolicyV1Schema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    allowedModes: z._default(z.optional(z.array(LocalServicePublicExposureModeV1Schema)), []),
    maxTtlMs: z.optional(z.number().check(z.int(), z.positive())),
    maxConcurrentExposures: z.optional(z.number().check(z.int(), z.positive())),
    dnsTlsRequired: z._default(z.optional(z.boolean()), true),
    auditRequired: z._default(z.optional(z.boolean()), true),
    rateLimitProfileIds: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128)))), []),
  }));
export type LocalServicePublicPolicyV1 = z.infer<typeof LocalServicePublicPolicyV1Schema>;

// Existing public-control refusal vocabulary, shared by the HTTP producer and Action consumer.
export const LocalServicePublicPreviewCreateFailureReasonV1Schema = lazyZodSchema(() => z.enum([
  'public_preview_disabled', 'preview_not_eligible', 'session_not_authorized', 'mode_not_allowed',
  'dns_tls_unavailable', 'rate_limit_profile_not_allowed', 'too_many_public_exposures', 'invalid_policy',
  'invalid_public_base_url', 'public_origin_unavailable', 'public_token_secret_missing',
  'audit_sink_unavailable', 'rate_limit_checker_unavailable', 'confirmation_required', 'preview_binding_mismatch',
  'audience_not_eligible',
]));
export type LocalServicePublicPreviewCreateFailureReasonV1 = z.infer<typeof LocalServicePublicPreviewCreateFailureReasonV1Schema>;

export const LocalServicePublicPreviewCreateFailureV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.enum(['public_preview_denied', 'public_preview_unavailable']),
  reasonCode: LocalServicePublicPreviewCreateFailureReasonV1Schema,
}));

export function resolveLocalServicePublicPreviewCreateFailureV1(
  reasonCode: LocalServicePublicPreviewCreateFailureReasonV1,
): Readonly<{ statusCode: 403 | 503; error: 'public_preview_denied' | 'public_preview_unavailable'; reasonCode: LocalServicePublicPreviewCreateFailureReasonV1 }> {
  switch (reasonCode) {
    case 'dns_tls_unavailable':
    case 'invalid_policy':
    case 'invalid_public_base_url':
    case 'public_origin_unavailable':
    case 'public_token_secret_missing':
    case 'audit_sink_unavailable':
    case 'rate_limit_checker_unavailable':
      return { statusCode: 503, error: 'public_preview_unavailable', reasonCode };
    default:
      return { statusCode: 403, error: 'public_preview_denied', reasonCode };
  }
}

const LocalServicePublicUrlV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.url(), z.refine(hasHttpProtocol, {
  message: 'Public local service exposure URLs must use http or https.',
})));

export const REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL = 'https://redacted.local-services.invalid/';

const LocalServicePublicPolicyDiagnosticsV1Schema = lazyZodSchema(() => z
  .record(z.string(), z.unknown()).check(z.superRefine(rejectUnsafeLocalServicePublicPolicyDiagnosticKeys)));

export const LocalServicePublicExposureV1Schema = lazyZodSchema(() => z.strictObject({
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    mode: LocalServicePublicExposureModeV1Schema,
    audience: z.optional(LocalServicePublicExposureAudienceV1Schema),
    state: LocalServicePublicExposureStateV1Schema,
    publicUrl: LocalServicePublicUrlV1Schema,
    issuedAt: z.number().check(z.int(), z.nonnegative()),
    expiresAt: z.number().check(z.int(), z.nonnegative()),
    revokedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    auditEventIds: z._default(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))), []),
    rateLimitProfileId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    policyDiagnostics: z.optional(LocalServicePublicPolicyDiagnosticsV1Schema),
  }).check(z.superRefine((exposure, context) => {
    refinePublicServiceBinding(exposure, context);
    refineExposureAudience(exposure, context);
    if (exposure.expiresAt <= exposure.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ['expiresAt'],
        message: 'Public local service exposures must expire after issuance.',
      });
    }
  })));
export type LocalServicePublicExposureV1 = z.infer<typeof LocalServicePublicExposureV1Schema>;

export function redactLocalServicePublicExposureForAgentEgress(
  exposure: LocalServicePublicExposureV1,
): LocalServicePublicExposureV1 {
  return {
    ...exposure,
    publicUrl: REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL,
  };
}

export const LocalServicePublicAuditEventV1Schema = lazyZodSchema(() => z.strictObject({
    eventId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    action: z.enum(['create', 'access', 'access_denied', 'revoke', 'expire', 'rate_limit']),
    occurredAt: z.number().check(z.int(), z.nonnegative()),
    actorId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
  }).check(z.superRefine((event, context) => {
    if (event.action === 'access_denied' && !event.reasonCode) {
      context.addIssue({
        code: "custom",
        path: ['reasonCode'],
        message: 'Denied public local service access audit events require a reason code.',
      });
    }
  })));
export type LocalServicePublicAuditEventV1 = z.infer<typeof LocalServicePublicAuditEventV1Schema>;

export const LocalServicePublicPreviewSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    previewId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    generatedAt: z.number().check(z.int(), z.nonnegative()),
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    policy: LocalServicePublicPolicyV1Schema,
    exposures: z.array(LocalServicePublicExposureV1Schema),
    diagnostics: z._default(z.array(LocalServicePreviewDiagnosticV1Schema), []),
  }).check(z.superRefine((snapshot, context) => {
    for (const [index, exposure] of snapshot.exposures.entries()) {
      if (exposure.machineId !== snapshot.machineId) {
        context.addIssue({
          code: "custom",
          path: ['exposures', index, 'machineId'],
          message: 'Public exposure machineId must match the public preview snapshot machineId.',
        });
      }
      if (snapshot.sessionId && exposure.sessionId !== snapshot.sessionId) {
        context.addIssue({
          code: "custom",
          path: ['exposures', index, 'sessionId'],
          message: 'Public exposure sessionId must match the public preview snapshot sessionId.',
        });
      }
      if (snapshot.previewId && exposure.previewId !== snapshot.previewId) {
        context.addIssue({
          code: "custom",
          path: ['exposures', index, 'previewId'],
          message: 'Public exposure previewId must match the public preview snapshot previewId.',
        });
      }
    }
  })));
export type LocalServicePublicPreviewSnapshotV1 = z.infer<
  typeof LocalServicePublicPreviewSnapshotV1Schema
>;

export function redactLocalServicePublicPreviewSnapshotForAgentEgress(
  snapshot: LocalServicePublicPreviewSnapshotV1,
): LocalServicePublicPreviewSnapshotV1 {
  if (snapshot.exposures.length === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    exposures: snapshot.exposures.map(redactLocalServicePublicExposureForAgentEgress),
  };
}

export const DaemonLocalServicePublicPreviewStatusRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    previewId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    exposureId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }).check(z.superRefine((request, context) => {
    refineLocalServicePreviewServiceBindingV1(request, context);
    if (request.serviceTarget && !request.previewId) {
      context.addIssue({ code: "custom", path: ['previewId'], message: 'A current service status requires its registered preview.' });
    }
  })));
export type DaemonLocalServicePublicPreviewStatusRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewStatusRequestV1Schema
>;

export const DaemonLocalServicePublicPreviewStatusResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    snapshot: LocalServicePublicPreviewSnapshotV1Schema,
  }));
export type DaemonLocalServicePublicPreviewStatusResponseV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewStatusResponseV1Schema
>;

/**
 * UX-5: explicit consent acknowledgement for creating a public exposure. Creating a public
 * exposure makes a local service reachable on the internet, so a non-UI/agent caller must NOT be
 * able to do it silently. The UI sets `acknowledged:true` only after a `Modal.confirm`; the daemon
 * `publicPreview.create` chokepoint rejects any create request that lacks this acknowledgement
 * (composing with the agent approval floor on `localServices.publicPreview.create`).
 */
export const LocalServicePublicPreviewCreateConfirmationV1Schema = lazyZodSchema(() => z.strictObject({
    acknowledged: z.literal(true),
  }));
export type LocalServicePublicPreviewCreateConfirmationV1 = z.infer<
  typeof LocalServicePublicPreviewCreateConfirmationV1Schema
>;

export const DaemonLocalServicePublicPreviewCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    mode: LocalServicePublicExposureModeV1Schema,
    audience: z.optional(LocalServicePublicExposureAudienceV1Schema),
    ttlMs: z.number().check(z.int(), z.positive()),
    rateLimitProfileId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    // Optional on the wire (additive, back-compatible) but REQUIRED by the daemon create
    // chokepoint — see `isLocalServicePublicPreviewCreateConfirmed`.
    confirmation: z.optional(LocalServicePublicPreviewCreateConfirmationV1Schema),
  }).check(z.superRefine((request, context) => {
    refinePublicServiceBinding(request, context);
    refineExposureAudience(request, context);
  })));
export type DaemonLocalServicePublicPreviewCreateRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewCreateRequestV1Schema
>;

/**
 * The daemon-enforced consent gate for public-exposure creation. A create request is only honored
 * when it carries an explicit `confirmation.acknowledged === true`. Centralized so the UI action
 * builder and the daemon executor agree on exactly one rule.
 */
export function isLocalServicePublicPreviewCreateConfirmed(
  request: Pick<DaemonLocalServicePublicPreviewCreateRequestV1, 'confirmation'>,
): boolean {
  return request.confirmation?.acknowledged === true;
}

export const DaemonLocalServicePublicPreviewCreateResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    exposure: LocalServicePublicExposureV1Schema,
    snapshot: z.optional(LocalServicePublicPreviewSnapshotV1Schema),
  }).check(z.superRefine((response, context) => {
    const snapshot = response.snapshot;
    if (!snapshot) return;
    if (response.exposure.machineId !== snapshot.machineId) {
      context.addIssue({
        code: "custom",
        path: ['exposure', 'machineId'],
        message: 'Created public exposure machineId must match the returned snapshot.',
      });
    }
    if (snapshot.sessionId && response.exposure.sessionId !== snapshot.sessionId) {
      context.addIssue({
        code: "custom",
        path: ['exposure', 'sessionId'],
        message: 'Created public exposure sessionId must match the returned snapshot.',
      });
    }
    if (snapshot.previewId && response.exposure.previewId !== snapshot.previewId) {
      context.addIssue({
        code: "custom",
        path: ['exposure', 'previewId'],
        message: 'Created public exposure previewId must match the returned snapshot.',
      });
    }
  })));
export type DaemonLocalServicePublicPreviewCreateResponseV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewCreateResponseV1Schema
>;

export function redactLocalServicePublicPreviewCreateResponseForAgentEgress(
  response: DaemonLocalServicePublicPreviewCreateResponseV1,
): DaemonLocalServicePublicPreviewCreateResponseV1 {
  const { snapshot, ...rest } = response;
  return {
    ...rest,
    exposure: redactLocalServicePublicExposureForAgentEgress(response.exposure),
    ...(snapshot ? { snapshot: redactLocalServicePublicPreviewSnapshotForAgentEgress(snapshot) } : {}),
  };
}

export const DaemonLocalServicePublicPreviewRevokeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }).check(z.superRefine(refinePublicServiceBinding)));
export type DaemonLocalServicePublicPreviewRevokeRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewRevokeRequestV1Schema
>;

export const DaemonLocalServicePublicPreviewRevokeResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    revokedAt: z.number().check(z.int(), z.nonnegative()),
    snapshot: LocalServicePublicPreviewSnapshotV1Schema,
  }));
export type DaemonLocalServicePublicPreviewRevokeResponseV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewRevokeResponseV1Schema
>;

export function redactLocalServicePublicPreviewRevokeResponseForAgentEgress(
  response: DaemonLocalServicePublicPreviewRevokeResponseV1,
): DaemonLocalServicePublicPreviewRevokeResponseV1 {
  return {
    ...response,
    snapshot: redactLocalServicePublicPreviewSnapshotForAgentEgress(response.snapshot),
  };
}

export const DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }).check(z.superRefine(refinePublicServiceBinding)));
export type DaemonLocalServicePublicPreviewCopyUrlRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema
>;

export const DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    publicUrl: LocalServicePublicUrlV1Schema,
  }).check(z.superRefine(refinePublicServiceBinding)));
export type DaemonLocalServicePublicPreviewCopyUrlResponseV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema
>;

export const LocalServicePublicPreviewExchangeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    publicToken: z.string().check(z.trim(), z.minLength(1), z.maxLength(4096)),
  }));
export type LocalServicePublicPreviewExchangeRequestV1 = z.infer<
  typeof LocalServicePublicPreviewExchangeRequestV1Schema
>;

export const LocalServicePublicPreviewExchangeResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    exposureId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    publicToken: z.string().check(z.trim(), z.minLength(1), z.maxLength(4096)),
    expiresAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type LocalServicePublicPreviewExchangeResponseV1 = z.infer<
  typeof LocalServicePublicPreviewExchangeResponseV1Schema
>;

/** Why a signed-in viewer was not admitted to a `people` exposure. */
export const LocalServicePublicPreviewAdmissionFailureReasonV1Schema = lazyZodSchema(() => z.enum([
  'exposure_not_found', 'expired', 'revoked', 'not_people_share', 'not_in_audience', 'service_unavailable', 'audit_sink_unavailable',
]));
export type LocalServicePublicPreviewAdmissionFailureReasonV1 = z.infer<typeof LocalServicePublicPreviewAdmissionFailureReasonV1Schema>;

/** A one-use URL on the exposure's isolated origin; opening it sets the viewer-bound cookie. */
export const LocalServicePublicPreviewAdmissionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
  admissionUrl: LocalServicePublicUrlV1Schema,
  expiresAt: z.number().check(z.int(), z.nonnegative()),
}));
export type LocalServicePublicPreviewAdmissionResponseV1 = z.infer<typeof LocalServicePublicPreviewAdmissionResponseV1Schema>;

export const LocalServicePublicPreviewAdmissionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('public_preview_admission_denied'),
  reasonCode: LocalServicePublicPreviewAdmissionFailureReasonV1Schema,
}));

/** The app landing a `people` share's link points at. */
export function formatLocalServicePublicPreviewLandingPathV1(exposureId: string): string {
  return `/preview-link/${encodeURIComponent(exposureId)}`;
}
