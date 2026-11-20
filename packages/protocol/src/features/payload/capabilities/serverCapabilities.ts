import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { ServerRetentionCapabilitiesSchema, type ServerRetentionCapabilities } from './serverRetentionCapabilities.js';
import { ServerUsageAnalyticsCapabilitiesSchema, type ServerUsageAnalyticsCapabilities } from './serverUsageAnalyticsCapabilities.js';
import { PrivateBinaryStorageUnavailableReasonV1Schema } from '../../../storage/binaryBlobV1.js';

const OptionalNonEmptyString = z.optional(z.string().check(z.trim(), z.minLength(1)));

const FileStorageAvailableSchema = z.object({ status: z.literal('available') });
const PublicFileStorageUnavailableSchema = z.union([
    z.object({ status: z.literal('unavailable'), reason: z.literal('s3_configuration_invalid'), setting: z.enum([
        'S3_HOST', 'S3_PORT', 'S3_BUCKET', 'S3_PUBLIC_URL', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_PRIVATE_BUCKET',
    ]) }),
    z.object({ status: z.literal('unavailable'), reason: z.enum(['s3_public_bucket_missing', 's3_access_denied', 'backend_unavailable']) }),
]);
export type PublicFileStorageUnavailable = z.infer<typeof PublicFileStorageUnavailableSchema>;

const FileStorageCapabilitySchema = z.object({
    public: z.union([FileStorageAvailableSchema, PublicFileStorageUnavailableSchema]),
    private: z.union([FileStorageAvailableSchema, z.object({
        status: z.literal('unavailable'),
        reason: PrivateBinaryStorageUnavailableReasonV1Schema,
    })]),
});
export type FileStorageCapability = z.infer<typeof FileStorageCapabilitySchema>;

export const ServerCapabilitiesSchema = lazyZodSchema(() => z.object({
    canonicalServerUrl: OptionalNonEmptyString,
    webappUrl: OptionalNonEmptyString,
    retention: z.optional(ServerRetentionCapabilitiesSchema),
    usageAnalytics: z.optional(ServerUsageAnalyticsCapabilitiesSchema),
    fileStorage: z.optional(FileStorageCapabilitySchema),
  }));

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type { ServerRetentionCapabilities, ServerUsageAnalyticsCapabilities };

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {};
