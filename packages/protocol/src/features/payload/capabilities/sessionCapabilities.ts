import { z } from 'zod';

import { SessionStateCapabilitiesV1Schema } from '../../../sessions/state/capabilitySchema.js';

export const DEFAULT_SESSION_MESSAGES_CAPABILITIES = Object.freeze({
  role: false,
});

export const SessionMessagesCapabilitiesSchema = z
  .object({
    role: z.boolean().optional().default(DEFAULT_SESSION_MESSAGES_CAPABILITIES.role),
  })
  .optional()
  .default(DEFAULT_SESSION_MESSAGES_CAPABILITIES);

export type SessionMessagesCapabilities = z.infer<typeof SessionMessagesCapabilitiesSchema>;

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({
  state: {},
  messages: DEFAULT_SESSION_MESSAGES_CAPABILITIES,
});

export const SessionCapabilitiesSchema = z
  .object({
    state: SessionStateCapabilitiesV1Schema.optional().default({}),
    messages: SessionMessagesCapabilitiesSchema,
  })
  .strict()
  .optional()
  .default(DEFAULT_SESSION_CAPABILITIES);

export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
