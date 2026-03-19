import { z } from 'zod';

export const SESSION_ATTACH_METADATA_IDENTITY_POLICIES = [
    'preserve_current_identity',
    'replace_with_runtime_identity',
] as const;

export type SessionAttachMetadataIdentityPolicy =
    (typeof SESSION_ATTACH_METADATA_IDENTITY_POLICIES)[number];

export const SessionAttachMetadataIdentityPolicySchema = z.enum(
    SESSION_ATTACH_METADATA_IDENTITY_POLICIES,
);
