import { z } from 'zod';

export const MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1 =
  'machine-session-terminal-capture-v1' as const;
export const MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1 =
  'machine-session-terminal-finalize-v1' as const;

const MachineSessionTerminalSessionIdV1Schema = z.string().trim().min(1);
const MachineSessionTerminalFenceMsV1Schema = z.number().int().nonnegative();
const MachineSessionTerminalPublisherGenerationV1Schema = z
  .string()
  .refine((value) => (
    /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n
  ));

export const MachineSessionTerminalAuthorityV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('generation'),
    publisherGeneration: MachineSessionTerminalPublisherGenerationV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('legacy-heartbeat'),
    committedFenceMs: MachineSessionTerminalFenceMsV1Schema,
  }).strict(),
]);
export type MachineSessionTerminalAuthorityV1 =
  z.infer<typeof MachineSessionTerminalAuthorityV1Schema>;

export const MachineSessionTerminalCaptureRequestV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
  })
  .strict();
export type MachineSessionTerminalCaptureRequestV1 =
  z.infer<typeof MachineSessionTerminalCaptureRequestV1Schema>;

export const MachineSessionTerminalCaptureResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    status: z.literal('captured'),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
    authority: MachineSessionTerminalAuthorityV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    status: z.literal('already_inactive'),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    status: z.literal('rejected'),
    sessionId: MachineSessionTerminalSessionIdV1Schema.optional(),
    reason: z.enum([
      'invalid_request',
      'wrong_machine_socket',
      'not_found',
      'unauthorized',
      'archived',
      'unsupported',
      'internal_error',
    ]),
  }).strict(),
]);
export type MachineSessionTerminalCaptureResponseV1 =
  z.infer<typeof MachineSessionTerminalCaptureResponseV1Schema>;

export const MachineSessionTerminalFinalizeRequestV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
    authority: MachineSessionTerminalAuthorityV1Schema,
  })
  .strict();
export type MachineSessionTerminalFinalizeRequestV1 =
  z.infer<typeof MachineSessionTerminalFinalizeRequestV1Schema>;

export const MachineSessionTerminalFinalizeResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    status: z.enum(['closed', 'already_inactive', 'superseded']),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    status: z.literal('rejected'),
    sessionId: MachineSessionTerminalSessionIdV1Schema.optional(),
    reason: z.enum([
      'invalid_request',
      'wrong_machine_socket',
      'not_found',
      'unauthorized',
      'archived',
      'unsupported',
      'internal_error',
    ]),
  }).strict(),
]);
export type MachineSessionTerminalFinalizeResponseV1 =
  z.infer<typeof MachineSessionTerminalFinalizeResponseV1Schema>;
