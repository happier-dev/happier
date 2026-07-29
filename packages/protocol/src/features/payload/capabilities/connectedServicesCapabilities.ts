import { z } from 'zod';

export const DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES = Object.freeze({
  revisionGuard: false,
});

export const ConnectedServicesCredentialDeleteCapabilitiesSchema = z
  .object({
    revisionGuard: z.boolean().optional().default(DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES.revisionGuard),
  })
  .default(DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES);

export const DEFAULT_CONNECTED_SERVICES_CAPABILITIES = Object.freeze({
  credentialDelete: DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES,
});

export const ConnectedServicesQualifiedAccountsCapabilitiesSchema = z.object({
  protocolVersion: z.literal(4),
}).strict();

export const ConnectedServicesCapabilitiesSchema = z
  .object({
    credentialDelete: ConnectedServicesCredentialDeleteCapabilitiesSchema.optional().default(
      DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES,
    ),
    qualifiedAccounts: ConnectedServicesQualifiedAccountsCapabilitiesSchema.optional(),
  })
  .default(DEFAULT_CONNECTED_SERVICES_CAPABILITIES);

export type ConnectedServicesCapabilities = z.infer<typeof ConnectedServicesCapabilitiesSchema>;
