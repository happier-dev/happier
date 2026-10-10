import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { BackendTargetKeyV2Schema } from '../../backends/targets/backendTargetRefV2.js';

// Keep new restrictions outside the released strict spawn-policy V1 object.
// A malformed list denies that selection family instead of opening it.
export const SessionAgentStartAllowListsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1).default(1),
  allowedRoleIds: z.array(z.string().trim().min(1)).nullable().default(null).catch([]),
  allowedAgentTargetKeys: z.array(BackendTargetKeyV2Schema).nullable().default(null).catch([]),
}).strict().catch({ v: 1, allowedRoleIds: [], allowedAgentTargetKeys: [] }));

export type SessionAgentStartAllowListsV1 = z.infer<typeof SessionAgentStartAllowListsV1Schema>;
export const DEFAULT_SESSION_AGENT_START_ALLOW_LISTS_V1 = SessionAgentStartAllowListsV1Schema.parse({});
