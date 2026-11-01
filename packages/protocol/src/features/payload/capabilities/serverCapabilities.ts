import { z } from 'zod';
import { ServerRetentionCapabilitiesSchema, type ServerRetentionCapabilities } from './serverRetentionCapabilities.js';
import { lazySchema } from '../../../lazySchema.js';

const OptionalNonEmptyString = lazySchema(() => z.string().trim().min(1).optional());

export const ServerCapabilitiesSchema = lazySchema(() => z
  .object({
    canonicalServerUrl: OptionalNonEmptyString,
    webappUrl: OptionalNonEmptyString,
    retention: ServerRetentionCapabilitiesSchema.optional(),
  })
  .strict());

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type { ServerRetentionCapabilities };

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {};
