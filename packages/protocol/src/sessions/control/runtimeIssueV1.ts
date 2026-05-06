import { z } from 'zod';

export const TurnTerminalStatusV1Schema = z.enum(['completed', 'cancelled', 'failed']);
export type TurnTerminalStatusV1 = z.infer<typeof TurnTerminalStatusV1Schema>;

export const PrimaryTurnStatusV1Schema = z.union([
  z.literal('in_progress'),
  TurnTerminalStatusV1Schema,
]);
export type PrimaryTurnStatusV1 = z.infer<typeof PrimaryTurnStatusV1Schema>;

export const SessionRuntimeIssueSourceV1Schema = z.enum([
  'provider_status_error',
  'provider_process_exit',
  'provider_session_error',
  'usage_limit',
  'auth_error',
  'stream_error',
  'permission_blocked',
  'unknown',
]);
export type SessionRuntimeIssueSourceV1 = z.infer<typeof SessionRuntimeIssueSourceV1Schema>;

export const SessionRuntimeIssueV1Schema = z
  .object({
    v: z.literal(1),
    scope: z.literal('primary_session'),
    status: z.literal('failed'),
    code: z.string().trim().min(1),
    source: SessionRuntimeIssueSourceV1Schema,
    occurredAt: z.number().int().nonnegative(),
    sessionSeq: z.number().int().nonnegative().optional(),
    provider: z.string().trim().min(1).optional(),
    providerTurnId: z.string().trim().min(1).optional(),
    sanitizedPreview: z.string().trim().min(1).optional(),
  })
  .readonly();
export type SessionRuntimeIssueV1 = z.infer<typeof SessionRuntimeIssueV1Schema>;
