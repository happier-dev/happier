import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
import { ServerRetentionCapabilitiesSchema, type ServerRetentionCapabilities } from './serverRetentionCapabilities.js';
import { ServerUsageAnalyticsCapabilitiesSchema, type ServerUsageAnalyticsCapabilities } from './serverUsageAnalyticsCapabilities.js';

const OptionalNonEmptyString = z.string().trim().min(1).optional();

export const ServerCapabilitiesSchema = lazyZodSchema(() => z
  .object({
    canonicalServerUrl: OptionalNonEmptyString,
    webappUrl: OptionalNonEmptyString,
    retention: ServerRetentionCapabilitiesSchema.optional(),
    usageAnalytics: ServerUsageAnalyticsCapabilitiesSchema.optional(),
  })
  .strict());

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type { ServerRetentionCapabilities, ServerUsageAnalyticsCapabilities };

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {};
