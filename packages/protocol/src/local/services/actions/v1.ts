import { z } from 'zod';

export const LocalServiceActionKindV1Schema = z.enum([
  'copy_url',
  'open_preview',
  'forget',
  'stop_managed',
  'restart_managed',
  'terminate_detected',
]);
export type LocalServiceActionKindV1 = z.infer<typeof LocalServiceActionKindV1Schema>;

export const LocalServiceActionTargetV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inventory_entry'),
      inventoryEntryId: z.string().trim().min(1).max(256),
      machineId: z.string().trim().min(1).max(256),
      sessionId: z.string().trim().min(1).max(256).optional(),
      workspaceId: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('managed_service'),
      managedServiceId: z.string().trim().min(1).max(256),
      machineId: z.string().trim().min(1).max(256),
      sessionId: z.string().trim().min(1).max(256).optional(),
      workspaceId: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
]);
export type LocalServiceActionTargetV1 = z.infer<typeof LocalServiceActionTargetV1Schema>;

export const LocalServiceActionDecisionV1Schema = z
  .object({
    kind: LocalServiceActionKindV1Schema,
    enabled: z.boolean(),
    requiresConfirmation: z.boolean(),
    requiresSecondConfirmation: z.boolean().optional().default(false),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    auditRequired: z.boolean(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (!decision.enabled && !decision.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Disabled action decisions must include a reasonCode.',
      });
    }
  });
export type LocalServiceActionDecisionV1 = z.infer<typeof LocalServiceActionDecisionV1Schema>;

export const LocalServiceActionRequestV1Schema = z
  .object({
    requestId: z.string().trim().min(1).max(256),
    target: LocalServiceActionTargetV1Schema,
    action: LocalServiceActionKindV1Schema,
    confirmationNonce: z.string().trim().min(1).max(256).optional(),
    force: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      (request.action === 'stop_managed'
        || request.action === 'restart_managed'
        || request.action === 'terminate_detected')
      && !request.confirmationNonce
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationNonce'],
        message: 'Managed and destructive local service actions require a confirmationNonce.',
      });
    }
    if (request.force && !request.confirmationNonce) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationNonce'],
        message: 'Force actions require a confirmationNonce.',
      });
    }
  });
export type LocalServiceActionRequestV1 = z.infer<typeof LocalServiceActionRequestV1Schema>;

const LOCAL_SERVICE_ACTION_CONFIRMATION_NONCE_PREFIX_V1 = 'lsact1_';

function normalizeConfirmationScopePart(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalLocalServiceActionConfirmationPayloadV1(
  request: LocalServiceActionRequestV1,
): string {
  const target = request.target.kind === 'inventory_entry'
    ? [
      request.target.kind,
      request.target.inventoryEntryId,
      request.target.machineId,
      normalizeConfirmationScopePart(request.target.sessionId),
      normalizeConfirmationScopePart(request.target.workspaceId),
    ]
    : [
      request.target.kind,
      request.target.managedServiceId,
      request.target.machineId,
      normalizeConfirmationScopePart(request.target.sessionId),
      normalizeConfirmationScopePart(request.target.workspaceId),
    ];
  return JSON.stringify([
    1,
    request.requestId,
    request.action,
    request.force === true,
    ...target,
  ]);
}

function stableConfirmationHashV1(payload: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export function createLocalServiceActionConfirmationNonceV1(
  request: LocalServiceActionRequestV1,
): string {
  /*
   * Deterministic request-binding token for UI confirmation flows.
   * This is not secret authorization: any caller with the request can recompute it,
   * so daemon callers must still rely on authenticated routes and target ownership checks.
   */
  return `${LOCAL_SERVICE_ACTION_CONFIRMATION_NONCE_PREFIX_V1}${
    stableConfirmationHashV1(canonicalLocalServiceActionConfirmationPayloadV1(request))
  }`;
}

export function isLocalServiceActionConfirmationNonceV1(
  request: LocalServiceActionRequestV1,
): boolean {
  return request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request);
}

export const LocalServiceActionAuditEventV1Schema = z
  .object({
    v: z.literal(1),
    eventId: z.string().trim().min(1).max(256),
    requestId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    action: LocalServiceActionKindV1Schema,
    result: z.enum(['requested', 'denied', 'confirmed', 'succeeded', 'failed']),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict();
export type LocalServiceActionAuditEventV1 = z.infer<typeof LocalServiceActionAuditEventV1Schema>;

export const LocalServiceActionResultV1Schema = z
  .object({
    v: z.literal(1),
    requestId: z.string().trim().min(1).max(256),
    action: LocalServiceActionKindV1Schema,
    status: z.enum(['succeeded', 'denied', 'failed']),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    auditEvents: z.array(LocalServiceActionAuditEventV1Schema),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status !== 'succeeded' && !result.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Unsuccessful action results must include a reasonCode.',
      });
    }
  });
export type LocalServiceActionResultV1 = z.infer<typeof LocalServiceActionResultV1Schema>;

export const DaemonLocalServiceActionExecuteRequestV1Schema = LocalServiceActionRequestV1Schema;
export type DaemonLocalServiceActionExecuteRequestV1 = z.infer<
  typeof DaemonLocalServiceActionExecuteRequestV1Schema
>;

export const DaemonLocalServiceActionExecuteResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    result: LocalServiceActionResultV1Schema,
  })
  .strict();
export type DaemonLocalServiceActionExecuteResponseV1 = z.infer<
  typeof DaemonLocalServiceActionExecuteResponseV1Schema
>;
