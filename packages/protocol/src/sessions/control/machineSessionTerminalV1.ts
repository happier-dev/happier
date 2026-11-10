import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1 =
  'machine-session-terminal-capture-v1' as const;
export const MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1 =
  'machine-session-terminal-finalize-v1' as const;

const MachineSessionTerminalSessionIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const MachineSessionTerminalFenceMsV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
export const SessionPublisherGenerationV1Schema = lazyZodSchema(() => z
  .string().check(z.refine((value) => (
    /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n
  ))));

export const MachineSessionTerminalAuthorityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('generation'),
    publisherGeneration: SessionPublisherGenerationV1Schema,
  }),
  z.strictObject({
    kind: z.literal('legacy-heartbeat'),
    committedFenceMs: MachineSessionTerminalFenceMsV1Schema,
  }),
]));
export type MachineSessionTerminalAuthorityV1 =
  z.infer<typeof MachineSessionTerminalAuthorityV1Schema>;

export const MachineSessionTerminalCaptureRequestV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
  }));
export type MachineSessionTerminalCaptureRequestV1 =
  z.infer<typeof MachineSessionTerminalCaptureRequestV1Schema>;

export const MachineSessionTerminalCaptureResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    v: z.literal(1),
    status: z.literal('captured'),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
    authority: MachineSessionTerminalAuthorityV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    status: z.literal('already_inactive'),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    status: z.literal('rejected'),
    sessionId: z.optional(MachineSessionTerminalSessionIdV1Schema),
    reason: z.enum([
      'invalid_request',
      'wrong_machine_socket',
      'not_found',
      'unauthorized',
      'archived',
      'unsupported',
      'internal_error',
    ]),
  }),
]));
export type MachineSessionTerminalCaptureResponseV1 =
  z.infer<typeof MachineSessionTerminalCaptureResponseV1Schema>;

export const MachineSessionTerminalFinalizeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
    authority: MachineSessionTerminalAuthorityV1Schema,
  }));
export type MachineSessionTerminalFinalizeRequestV1 =
  z.infer<typeof MachineSessionTerminalFinalizeRequestV1Schema>;

export const MachineSessionTerminalFinalizeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    v: z.literal(1),
    status: z.enum(['closed', 'already_inactive', 'superseded']),
    sessionId: MachineSessionTerminalSessionIdV1Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    status: z.literal('rejected'),
    sessionId: z.optional(MachineSessionTerminalSessionIdV1Schema),
    reason: z.enum([
      'invalid_request',
      'wrong_machine_socket',
      'not_found',
      'unauthorized',
      'archived',
      'unsupported',
      'internal_error',
    ]),
  }),
]));
export type MachineSessionTerminalFinalizeResponseV1 =
  z.infer<typeof MachineSessionTerminalFinalizeResponseV1Schema>;
