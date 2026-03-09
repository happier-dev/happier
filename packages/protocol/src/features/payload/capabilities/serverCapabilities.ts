import { z } from 'zod';
import { ServerRetentionCapabilitiesSchema, type ServerRetentionCapabilities } from './serverRetentionCapabilities.js';

const OptionalNonEmptyString = z.string().trim().min(1).optional();

export const ServerCapabilitiesSchema = z
  .object({
    canonicalServerUrl: OptionalNonEmptyString,
    webappUrl: OptionalNonEmptyString,
    retention: ServerRetentionCapabilitiesSchema.optional(),
  })
  .strict();

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type { ServerRetentionCapabilities };

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {};
