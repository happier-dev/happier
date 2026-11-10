import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export const SESSION_CAPABILITY_NOTICE_SIDECAR_KEY = 'capabilityNoticeV1';

export const SessionCapabilityNoticeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  items: z.array(z.strictObject({
    kind: z.enum(['mcp_server', 'skill', 'prompt_library']),
    name: z.string().check(z.minLength(1)),
    itemId: z.optional(z.string().check(z.minLength(1))),
    code: z.string().check(z.minLength(1)),
    detail: z.optional(z.string().check(z.minLength(1))),
  })),
}));
export type SessionCapabilityNoticeV1 = z.infer<typeof SessionCapabilityNoticeV1Schema>;

/** A malformed or future notice leaves the ordinary message text readable. */
export function readSessionCapabilityNoticeV1(event: unknown): SessionCapabilityNoticeV1 | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  if (record.type !== 'message') return null;
  const parsed = createStoredReadSchema(SessionCapabilityNoticeV1Schema)
    .safeParse(record[SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]);
  return parsed.success ? parsed.data : null;
}
