import { z } from 'zod';

export const SESSION_SYNC_PROTOCOL_VERSION_V1 = 1 as const;
export const SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY = 2 as const;
export const CURRENT_SESSION_SYNC_PROTOCOL_VERSION = 2 as const;
export const PENDING_INPUT_PROTOCOL_VERSION_V1 = 1 as const;
export const CURRENT_PENDING_INPUT_PROTOCOL_VERSION = PENDING_INPUT_PROTOCOL_VERSION_V1;
export const EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1 = 1 as const;
export const EXTERNAL_SESSION_HOSTED_ADMISSION_VERSION_V2 = 2 as const;
export const EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3 = 3 as const;
export const CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION =
  EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3;

export const SessionSyncProtocolVersionSchema = z
  .number()
  .int()
  .min(SESSION_SYNC_PROTOCOL_VERSION_V1)
  .max(Number.MAX_SAFE_INTEGER);

export const PendingInputProtocolVersionSchema = z
  .number()
  .int()
  .min(PENDING_INPUT_PROTOCOL_VERSION_V1)
  .max(Number.MAX_SAFE_INTEGER);

export const ExternalSessionImportPublicationFenceVersionSchema = z
  .number()
  .int()
  .min(EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1)
  .max(Number.MAX_SAFE_INTEGER);

export const ClientKindSchema = z.enum([
  'ui-web',
  'ui-ios',
  'ui-android',
  'ui-desktop',
  'cli',
  'daemon',
  'session-runner',
]);

export type ClientKind = z.infer<typeof ClientKindSchema>;

export const ClientAppVersionSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);

export const ClientReleaseChannelSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const SafeHttpsUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    // WHATWG URL parsing strips leading/trailing whitespace and embedded ASCII
    // tabs/newlines. Reject those bytes instead of validating one URL while
    // returning a different, unnormalised string to downstream consumers.
    if (/[\u0000-\u0020\u007f]/.test(value)) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:'
        && parsed.hostname.length > 0
        && parsed.username.length === 0
        && parsed.password.length === 0;
    } catch {
      return false;
    }
  }, 'Expected a safe HTTPS URL');

export const ClientKindAppVersionMapV1Schema = z
  .object({
    'ui-web': ClientAppVersionSchema.optional(),
    'ui-ios': ClientAppVersionSchema.optional(),
    'ui-android': ClientAppVersionSchema.optional(),
    'ui-desktop': ClientAppVersionSchema.optional(),
    cli: ClientAppVersionSchema.optional(),
    daemon: ClientAppVersionSchema.optional(),
    'session-runner': ClientAppVersionSchema.optional(),
  })
  .strict();

export const ClientKindUpgradeUrlMapV1Schema = z
  .object({
    'ui-web': SafeHttpsUrlSchema.optional(),
    'ui-ios': SafeHttpsUrlSchema.optional(),
    'ui-android': SafeHttpsUrlSchema.optional(),
    'ui-desktop': SafeHttpsUrlSchema.optional(),
    cli: SafeHttpsUrlSchema.optional(),
    daemon: SafeHttpsUrlSchema.optional(),
    'session-runner': SafeHttpsUrlSchema.optional(),
  })
  .strict();
