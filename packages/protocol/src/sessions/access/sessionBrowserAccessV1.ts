import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionEffectiveAccessV1Schema } from './sessionEffectiveAccessV1.js';

/** Home-proven Session access, bound to its installed ephemeral Browser source. */
export const SocketRpcSessionBrowserAuthorizationContextSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session.browser'),
  sessionId: z.string().check(z.minLength(1)),
  actorAccountId: z.string().check(z.minLength(1)),
  custodianAccountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  installationId: z.string().check(z.minLength(1)),
  effectiveAccess: SessionEffectiveAccessV1Schema,
}));

export type SocketRpcSessionBrowserAuthorizationContext = z.infer<typeof SocketRpcSessionBrowserAuthorizationContextSchema>;

export function isSocketRpcSessionBrowserAuthorizationContext(value: unknown): value is SocketRpcSessionBrowserAuthorizationContext {
  return SocketRpcSessionBrowserAuthorizationContextSchema.safeParse(value).success;
}
