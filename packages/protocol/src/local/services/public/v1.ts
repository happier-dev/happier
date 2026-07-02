import { z } from 'zod';

function hasHttpProtocol(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
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
    policyDiagnostics: z.record(z.string(), z.unknown()).optional(),
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

export const LocalServicePublicAuditEventV1Schema = z
  .object({
    eventId: z.string().trim().min(1).max(256),
    exposureId: z.string().trim().min(1).max(256),
    action: z.enum(['create', 'access', 'revoke', 'expire', 'rate_limit']),
    occurredAt: z.number().int().nonnegative(),
    actorId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type LocalServicePublicAuditEventV1 = z.infer<typeof LocalServicePublicAuditEventV1Schema>;
