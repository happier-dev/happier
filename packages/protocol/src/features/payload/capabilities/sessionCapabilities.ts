import { z } from 'zod';

export const DEFAULT_SESSION_MESSAGES_CAPABILITIES = Object.freeze({
  role: false,
  /**
   * Turn projection on the message listing: one row per prompt plus the LAST reply of that
   * turn. Defaults to false so a server that predates it is never sent `projection=turns` —
   * an unknown query parameter is ignored rather than rejected, and the client would then be
   * handed the ordinary listing while believing it asked for the projection.
   */
  turns: false,
});

export const SessionMessagesCapabilitiesSchema = z
  .object({
    role: z.boolean().optional().default(DEFAULT_SESSION_MESSAGES_CAPABILITIES.role),
    turns: z.boolean().optional().default(DEFAULT_SESSION_MESSAGES_CAPABILITIES.turns),
  })
  .optional()
  .default(DEFAULT_SESSION_MESSAGES_CAPABILITIES);

export type SessionMessagesCapabilities = z.infer<typeof SessionMessagesCapabilitiesSchema>;

const SessionProtocolCapabilitySchema = z.object({
  protocolVersion: z.number().int().positive(),
}).strict();

export const SessionRuntimeActivityCapabilitiesSchema = SessionProtocolCapabilitySchema;
export const SessionPendingInputCapabilitiesSchema = SessionProtocolCapabilitySchema;

export type SessionRuntimeActivityCapabilities = z.infer<typeof SessionRuntimeActivityCapabilitiesSchema>;
export type SessionPendingInputCapabilities = z.infer<typeof SessionPendingInputCapabilitiesSchema>;

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({
  messages: DEFAULT_SESSION_MESSAGES_CAPABILITIES,
});

export const SessionCapabilitiesSchema = z
  .object({
    messages: SessionMessagesCapabilitiesSchema,
    runtimeActivity: SessionRuntimeActivityCapabilitiesSchema.optional(),
    pendingInput: SessionPendingInputCapabilitiesSchema.optional(),
  })
  .optional()
  .default(DEFAULT_SESSION_CAPABILITIES);

export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
