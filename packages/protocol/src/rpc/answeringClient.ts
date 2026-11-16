import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeviceLabelSchema } from '../auth/deviceLabel.js';

/** Closed answering-client routing input; socket ids expire on reconnect. */
export const SocketRpcAnsweringClientV1Schema = lazyZodSchema(() => z.strictObject({
  clientId: z.optional(z.string().check(z.minLength(1))),
  requireSingle: z.optional(z.literal(true)),
  includeCandidates: z.optional(z.literal(true)),
}));
export type SocketRpcAnsweringClientV1 = Readonly<z.infer<typeof SocketRpcAnsweringClientV1Schema>>;
/** Ephemeral, non-content receiver facts; labels remain unknown when not advertised. */
export const SocketRpcAnsweringClientCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  deviceLabel: DeviceLabelSchema,
  state: z.optional(z.strictObject({ computer: z.boolean(), focused: z.boolean(),
    lastFocusedAt: z.optional(z.number().check(z.nonnegative())) })),
}));
export const SocketRpcAnsweringClientCandidatesV1Schema = lazyZodSchema(() => z.array(SocketRpcAnsweringClientCandidateV1Schema));
export type SocketRpcAnsweringClientCandidateV1 = Readonly<z.infer<typeof SocketRpcAnsweringClientCandidateV1Schema>>;
