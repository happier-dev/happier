import { z } from 'zod';

import { SessionStateCapabilitiesV1Schema } from '../../../sessions/state/capabilitySchema.js';

export const DEFAULT_SESSION_MESSAGES_CAPABILITIES = Object.freeze({
  role: false,
  /**
   * Turn projection on the message listing: one row per prompt plus that turn's final reply.
   * Defaults to false so a server that predates it is never sent `projection=turns` — an
   * unknown query parameter is ignored rather than rejected, and the client would then be
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
export const SessionPublisherAuthorityCapabilitiesSchema = SessionProtocolCapabilitySchema;

export const SessionExternalImportCapabilitiesSchema = z.object({
  publicationFenceVersion: z.number().int().positive(),
}).strict();

export const SessionSystemRecordsCapabilitiesSchema = z.object({
  protocolVersions: z.tuple([z.literal(1)]),
}).strict();
export type SessionSystemRecordsCapabilities = z.infer<typeof SessionSystemRecordsCapabilitiesSchema>;

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({
  state: {},
  messages: DEFAULT_SESSION_MESSAGES_CAPABILITIES,
});

export const SessionCapabilitiesSchema = z
  .object({
    state: SessionStateCapabilitiesV1Schema.optional().default({}),
    messages: SessionMessagesCapabilitiesSchema,
    systemRecords: SessionSystemRecordsCapabilitiesSchema.optional(),
    runtimeActivity: SessionRuntimeActivityCapabilitiesSchema.optional(),
    pendingInput: SessionPendingInputCapabilitiesSchema.optional(),
    publisherAuthority: SessionPublisherAuthorityCapabilitiesSchema.optional(),
    externalImport: SessionExternalImportCapabilitiesSchema.optional(),
  })
  .strict()
  .optional()
  .default(DEFAULT_SESSION_CAPABILITIES);

export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
