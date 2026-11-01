import { z } from 'zod';
import { ConnectedServiceIdSchema } from '../../../connect/connectedServiceBindings.js';
import { RELEASED_CONNECTED_SERVICE_IDS } from '../../../connect/connectedServiceReaderSupport.js';
import { lazySchema } from '../../../lazySchema.js';

export const DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES = Object.freeze({
  revisionGuard: false,
});

export const DEFAULT_CONNECTED_SERVICES_CREDENTIAL_WRITE_CAPABILITIES = Object.freeze({ revisionGuard: false });
export const ConnectedServicesCredentialWriteCapabilitiesSchema = lazySchema(() => z.object({
  revisionGuard: z.boolean().optional().default(false),
}).default(DEFAULT_CONNECTED_SERVICES_CREDENTIAL_WRITE_CAPABILITIES));

export const ConnectedServicesCredentialDeleteCapabilitiesSchema = lazySchema(() => z
  .object({
    revisionGuard: z.boolean().optional().default(DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES.revisionGuard),
  })
  .default(DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES));

export const DEFAULT_CONNECTED_SERVICES_CAPABILITIES = Object.freeze({
  credentialWrite: DEFAULT_CONNECTED_SERVICES_CREDENTIAL_WRITE_CAPABILITIES,
  credentialDelete: DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES,
  supportedServiceIds: [...RELEASED_CONNECTED_SERVICE_IDS],
});

export const ConnectedServicesCapabilitiesSchema = lazySchema(() => z
  .object({
    supportedServiceIds: z.array(ConnectedServiceIdSchema).catch([...RELEASED_CONNECTED_SERVICE_IDS]).default([...RELEASED_CONNECTED_SERVICE_IDS]),
    credentialDelete: ConnectedServicesCredentialDeleteCapabilitiesSchema.optional().default(
      DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES,
    ),
    credentialWrite: ConnectedServicesCredentialWriteCapabilitiesSchema.optional().default(DEFAULT_CONNECTED_SERVICES_CREDENTIAL_WRITE_CAPABILITIES),
  })
  .default(DEFAULT_CONNECTED_SERVICES_CAPABILITIES));

export type ConnectedServicesCapabilities = z.infer<typeof ConnectedServicesCapabilitiesSchema>;
