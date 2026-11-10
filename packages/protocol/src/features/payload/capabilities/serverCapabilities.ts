import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { ServerRetentionCapabilitiesSchema, type ServerRetentionCapabilities } from './serverRetentionCapabilities.js';
import { ServerUsageAnalyticsCapabilitiesSchema, type ServerUsageAnalyticsCapabilities } from './serverUsageAnalyticsCapabilities.js';

const OptionalNonEmptyString = z.optional(z.string().check(z.trim(), z.minLength(1)));

export const ServerCapabilitiesSchema = lazyZodSchema(() => z.object({
    canonicalServerUrl: OptionalNonEmptyString,
    webappUrl: OptionalNonEmptyString,
    retention: z.optional(ServerRetentionCapabilitiesSchema),
    usageAnalytics: z.optional(ServerUsageAnalyticsCapabilitiesSchema),
  }));

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type { ServerRetentionCapabilities, ServerUsageAnalyticsCapabilities };

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {};
