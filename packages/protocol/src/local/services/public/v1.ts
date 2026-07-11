import { z } from 'zod';

import { isUnsafeTelemetryDataKey } from '../../../common/sensitiveKeys.js';
import { LocalServicePreviewDiagnosticV1Schema } from '../preview/diagnostics/v1.js';

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
  context: z.RefinementCtx,
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
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: 'Public local service policy diagnostics must not contain bodies, cookies, tokens, headers, or grant material.',
      });
      continue;
    }
    rejectUnsafeLocalServicePublicPolicyDiagnosticKeys(nested, context, [...path, key]);
  }
}

export const LocalServicePublicExposureModeV1Schema = z.enum(['authenticated', 'secret_link', 'public']);
export type LocalServicePublicExposureModeV1 = z.infer<typeof LocalServicePublicExposureModeV1Schema>;

export const LocalServicePublicExposureStateV1Schema = z.enum(['pending', 'active', 'revoked', 'expired', 'rate_limited']);
export type LocalServicePublicExposureStateV1 = z.infer<typeof LocalServicePublicExposureStateV1Schema>;

export const LocalServicePublicPolicyV1Schema = z
  .object({
    enabled: z.boolean().optional().default(false),
    allowedModes: z.array(LocalServicePublicExposureModeV1Schema).optional().default([]),
    maxTtlMs: z.number().int().positive().optional(),
    maxConcurrentExposures: z.number().int().positive().optional(),
    dnsTlsRequired: z.boolean().optional().default(true),
    auditRequired: z.boolean().optional().default(true),
    rateLimitProfileIds: z.array(z.string().trim().min(1).max(128)).optional().default([]),
  })
  .strict();
export type LocalServicePublicPolicyV1 = z.infer<typeof LocalServicePublicPolicyV1Schema>;

const LocalServicePublicUrlV1Schema = z.string().trim().url().refine(hasHttpProtocol, {
  message: 'Public local service exposure URLs must use http or https.',
});

export const REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL = 'https://redacted.local-services.invalid/';

const LocalServicePublicPolicyDiagnosticsV1Schema = z
  .record(z.string(), z.unknown())
  .superRefine(rejectUnsafeLocalServicePublicPolicyDiagnosticKeys);

export const LocalServicePublicExposureV1Schema = z
  .object({
    exposureId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    mode: LocalServicePublicExposureModeV1Schema,
    state: LocalServicePublicExposureStateV1Schema,
    publicUrl: LocalServicePublicUrlV1Schema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    revokedAt: z.number().int().nonnegative().optional(),
    auditEventIds: z.array(z.string().trim().min(1).max(256)).default([]),
    rateLimitProfileId: z.string().trim().min(1).max(128),
    policyDiagnostics: LocalServicePublicPolicyDiagnosticsV1Schema.optional(),
  })
  .strict()
  .superRefine((exposure, context) => {
    if (exposure.expiresAt <= exposure.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Public local service exposures must expire after issuance.',
      });
    }
  });
export type LocalServicePublicExposureV1 = z.infer<typeof LocalServicePublicExposureV1Schema>;

export function redactLocalServicePublicExposureForAgentEgress(
  exposure: LocalServicePublicExposureV1,
): LocalServicePublicExposureV1 {
  return {
    ...exposure,
    publicUrl: REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL,
  };
}

export const LocalServicePublicAuditEventV1Schema = z
  .object({
    eventId: z.string().trim().min(1).max(256),
    exposureId: z.string().trim().min(1).max(256),
    action: z.enum(['create', 'access', 'access_denied', 'revoke', 'expire', 'rate_limit']),
    occurredAt: z.number().int().nonnegative(),
    actorId: z.string().trim().min(1).max(256).optional(),
    reasonCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.action === 'access_denied' && !event.reasonCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Denied public local service access audit events require a reason code.',
      });
    }
  });
export type LocalServicePublicAuditEventV1 = z.infer<typeof LocalServicePublicAuditEventV1Schema>;

export const LocalServicePublicPreviewSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    previewId: z.string().trim().min(1).max(256).optional(),
    generatedAt: z.number().int().nonnegative(),
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    policy: LocalServicePublicPolicyV1Schema,
    exposures: z.array(LocalServicePublicExposureV1Schema),
    diagnostics: z.array(LocalServicePreviewDiagnosticV1Schema).default([]),
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (const [index, exposure] of snapshot.exposures.entries()) {
      if (exposure.machineId !== snapshot.machineId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exposures', index, 'machineId'],
          message: 'Public exposure machineId must match the public preview snapshot machineId.',
        });
      }
      if (snapshot.sessionId && exposure.sessionId !== snapshot.sessionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exposures', index, 'sessionId'],
          message: 'Public exposure sessionId must match the public preview snapshot sessionId.',
        });
      }
      if (snapshot.previewId && exposure.previewId !== snapshot.previewId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exposures', index, 'previewId'],
          message: 'Public exposure previewId must match the public preview snapshot previewId.',
        });
      }
    }
  });
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

export const DaemonLocalServicePublicPreviewStatusRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    previewId: z.string().trim().min(1).max(256).optional(),
    exposureId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type DaemonLocalServicePublicPreviewStatusRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewStatusRequestV1Schema
>;

export const DaemonLocalServicePublicPreviewStatusResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    snapshot: LocalServicePublicPreviewSnapshotV1Schema,
  })
  .strict();
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
export const LocalServicePublicPreviewCreateConfirmationV1Schema = z
  .object({
    acknowledged: z.literal(true),
  })
  .strict();
export type LocalServicePublicPreviewCreateConfirmationV1 = z.infer<
  typeof LocalServicePublicPreviewCreateConfirmationV1Schema
>;

export const DaemonLocalServicePublicPreviewCreateRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    mode: LocalServicePublicExposureModeV1Schema,
    ttlMs: z.number().int().positive(),
    rateLimitProfileId: z.string().trim().min(1).max(128).optional(),
    // Optional on the wire (additive, back-compatible) but REQUIRED by the daemon create
    // chokepoint — see `isLocalServicePublicPreviewCreateConfirmed`.
    confirmation: LocalServicePublicPreviewCreateConfirmationV1Schema.optional(),
  })
  .strict();
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

export const DaemonLocalServicePublicPreviewCreateResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    exposure: LocalServicePublicExposureV1Schema,
    snapshot: LocalServicePublicPreviewSnapshotV1Schema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const snapshot = response.snapshot;
    if (!snapshot) return;
    if (response.exposure.machineId !== snapshot.machineId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exposure', 'machineId'],
        message: 'Created public exposure machineId must match the returned snapshot.',
      });
    }
    if (snapshot.sessionId && response.exposure.sessionId !== snapshot.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exposure', 'sessionId'],
        message: 'Created public exposure sessionId must match the returned snapshot.',
      });
    }
    if (snapshot.previewId && response.exposure.previewId !== snapshot.previewId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exposure', 'previewId'],
        message: 'Created public exposure previewId must match the returned snapshot.',
      });
    }
  });
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

export const DaemonLocalServicePublicPreviewRevokeRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    exposureId: z.string().trim().min(1).max(256),
  })
  .strict();
export type DaemonLocalServicePublicPreviewRevokeRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewRevokeRequestV1Schema
>;

export const DaemonLocalServicePublicPreviewRevokeResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    exposureId: z.string().trim().min(1).max(256),
    revokedAt: z.number().int().nonnegative(),
    snapshot: LocalServicePublicPreviewSnapshotV1Schema,
  })
  .strict();
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

export const DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    exposureId: z.string().trim().min(1).max(256),
  })
  .strict();
export type DaemonLocalServicePublicPreviewCopyUrlRequestV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema
>;

export const DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    exposureId: z.string().trim().min(1).max(256),
    publicUrl: LocalServicePublicUrlV1Schema,
  })
  .strict();
export type DaemonLocalServicePublicPreviewCopyUrlResponseV1 = z.infer<
  typeof DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema
>;

export const LocalServicePublicPreviewExchangeRequestV1Schema = z
  .object({
    publicToken: z.string().trim().min(1).max(4096),
  })
  .strict();
export type LocalServicePublicPreviewExchangeRequestV1 = z.infer<
  typeof LocalServicePublicPreviewExchangeRequestV1Schema
>;

export const LocalServicePublicPreviewExchangeResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    exposureId: z.string().trim().min(1).max(256),
    publicToken: z.string().trim().min(1).max(4096),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type LocalServicePublicPreviewExchangeResponseV1 = z.infer<
  typeof LocalServicePublicPreviewExchangeResponseV1Schema
>;
