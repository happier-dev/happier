import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BackendTargetKeyV2Schema } from '../../backends/targets/backendTargetRefV2.js';

// Keep new restrictions outside the released strict spawn-policy V1 object.
// A malformed list denies that selection family instead of opening it.
export const SessionAgentStartAllowListsV1StrictSchema = lazyZodSchema(() => z.strictObject({
  v: z._default(z.literal(1), 1),
  allowedRoleIds: z._default(z.nullable(z.array(z.string().check(z.trim(), z.minLength(1)))), null),
  allowedAgentTargetKeys: z._default(z.nullable(z.array(BackendTargetKeyV2Schema)), null),
}));

export const SessionAgentStartAllowListsV1Schema = lazyZodSchema(() => z.catch((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(SessionAgentStartAllowListsV1StrictSchema, {
  allowedRoleIds: z.catch(SessionAgentStartAllowListsV1StrictSchema.shape.allowedRoleIds, []),
  allowedAgentTargetKeys: z.catch(SessionAgentStartAllowListsV1StrictSchema.shape.allowedAgentTargetKeys, []),
})), { v: 1, allowedRoleIds: [], allowedAgentTargetKeys: [] }));

export type SessionAgentStartAllowListsV1 = z.infer<typeof SessionAgentStartAllowListsV1Schema>;
export const DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1 = SessionAgentStartAllowListsV1Schema.parse({});
