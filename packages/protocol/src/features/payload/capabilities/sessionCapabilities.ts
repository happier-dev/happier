import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionStateCapabilitiesV1ReadSchema } from '../../../sessions/state/capabilitySchema.js';

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

export const SessionMessagesCapabilitiesSchema = lazyZodSchema(() => z._default(z.optional(z
  .object({
    role: z._default(z.optional(z.boolean()), DEFAULT_SESSION_MESSAGES_CAPABILITIES.role),
    turns: z._default(z.optional(z.boolean()), DEFAULT_SESSION_MESSAGES_CAPABILITIES.turns),
  })), DEFAULT_SESSION_MESSAGES_CAPABILITIES));

export type SessionMessagesCapabilities = z.infer<typeof SessionMessagesCapabilitiesSchema>;

const SessionProtocolCapabilitySchema = lazyZodSchema(() => z.object({
  protocolVersion: z.number().check(z.int(), z.positive()),
}));

export const SessionRuntimeActivityCapabilitiesSchema = SessionProtocolCapabilitySchema;
export const SessionPendingInputCapabilitiesSchema = SessionProtocolCapabilitySchema;
export const SessionPublisherAuthorityCapabilitiesSchema = SessionProtocolCapabilitySchema;

export const SessionExternalImportCapabilitiesSchema = lazyZodSchema(() => z.object({
  publicationFenceVersion: z.number().check(z.int(), z.positive()),
}));

export const SessionSystemRecordsCapabilitiesSchema = lazyZodSchema(() => z.object({
  protocolVersions: z.tuple([z.literal(1)]),
}));
export type SessionSystemRecordsCapabilities = z.infer<typeof SessionSystemRecordsCapabilitiesSchema>;

/** Host-rendered Follow context accepted by the destination Session runtime. */
export const SessionFollowCapabilitiesSchema = lazyZodSchema(() => z.object({
  contextVersion: z.literal(1),
}));
export type SessionFollowCapabilities = z.infer<typeof SessionFollowCapabilitiesSchema>;

export const DEFAULT_SESSION_CAPABILITIES = Object.freeze({
  state: {},
  messages: DEFAULT_SESSION_MESSAGES_CAPABILITIES,
});

export const SessionCapabilitiesSchema = lazyZodSchema(() => z._default(z.optional(z.object({
    state: z._default(z.optional(SessionStateCapabilitiesV1ReadSchema), {}),
    messages: SessionMessagesCapabilitiesSchema,
    systemRecords: z.optional(SessionSystemRecordsCapabilitiesSchema),
    follow: z.optional(SessionFollowCapabilitiesSchema),
    runtimeActivity: z.optional(SessionRuntimeActivityCapabilitiesSchema),
    pendingInput: z.optional(SessionPendingInputCapabilitiesSchema),
    publisherAuthority: z.optional(SessionPublisherAuthorityCapabilitiesSchema),
    externalImport: z.optional(SessionExternalImportCapabilitiesSchema),
  })), DEFAULT_SESSION_CAPABILITIES));

export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
