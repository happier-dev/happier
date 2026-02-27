import { z } from 'zod';

const OptionalNonEmptyString = z.string().trim().min(1).optional();

export const ServerCapabilitiesSchema = z
  .object({
    canonicalServerUrl: OptionalNonEmptyString,
    webappUrl: OptionalNonEmptyString,
  })
  .strict();

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {};
