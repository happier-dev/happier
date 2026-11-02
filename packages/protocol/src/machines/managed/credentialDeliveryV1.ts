import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { ProviderErrorCodeV1Schema } from '../../providers/errors.js';
import { SessionTeamCredentialNativeDeliveryV1Schema, SessionTeamCredentialProviderModelSelectionV1Schema } from '../../teams/credentials/sessionBindingIntentV1.js';
import { ProviderBindingAuthorizationTicketV1Schema } from '../../providers/grants/v1.js';
import { DaemonProviderNativeSourceV1Schema } from '../../rpc/providers.js';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '../../teams/credentials/resourceV1.js';
import { ManagedRefusalCodeV1Schema } from './providerFactsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));

/** Comparison operands address one accepted binding; they convey no source or cloud authority. */
export const ManagedCredentialInstallInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), managedId: id(), sessionId: id(), executionRunId: z.optional(id()), bindingKey: id(),
  operation: z.optional(z.enum(['install', 'release'])),
  expectedResourceRevision: z.int().check(z.gte(0)), expectedSourceRevision: id(), expectedProviderTicket: id(),
}));
export type ManagedCredentialInstallInputV1 = z.infer<typeof ManagedCredentialInstallInputV1Schema>;

export const ManagedCredentialDeliveryFailureCodeV1Schema = lazyZodSchema(() => z.union([
  ManagedRefusalCodeV1Schema, ProviderBrokerAdmissionFailureCodeV1Schema, ProviderErrorCodeV1Schema,
  z.literal('action_outcome_unknown'),
]));
export type ManagedCredentialDeliveryFailureCodeV1 = z.infer<typeof ManagedCredentialDeliveryFailureCodeV1Schema>;

/** Vendor messages, secret headers and raw placeholders never enter retained Action outcomes. */
export const ManagedCredentialDeliveryResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirmed'), binding: SessionTeamCredentialNativeDeliveryV1Schema }),
  z.strictObject({ kind: z.literal('unknown'), code: ManagedCredentialDeliveryFailureCodeV1Schema }),
  z.strictObject({ kind: z.literal('refused'), code: ManagedCredentialDeliveryFailureCodeV1Schema }),
]));
export type ManagedCredentialDeliveryResultV1 = z.infer<typeof ManagedCredentialDeliveryResultV1Schema>;

/** Private exact-controller read, never a managed list, Action result or activity projection. */
export const ManagedNativeCredentialBindingV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: id(), accountId: id(), custodianAccountId: id(), resourceId: id(),
  resourceRevision: z.int().check(z.gte(0)), managedId: id(),
  providerModelSelection: SessionTeamCredentialProviderModelSelectionV1Schema,
  safeFacet: SessionTeamCredentialNativeDeliveryV1Schema,
  installation: z.enum(['prepared', 'confirmed', 'unknown']),
  submission: z.optional(z.strictObject({ requestId: id(), operation: z.enum(['install', 'release']) })),
  delivery: z.strictObject({
    safeFacet: SessionTeamCredentialNativeDeliveryV1Schema, placeholder: id(),
    providerAuthorizationTicket: ProviderBindingAuthorizationTicketV1Schema,
    endpoint: DaemonProviderNativeSourceV1Schema.shape.endpoint,
    credentialTransport: DaemonProviderNativeSourceV1Schema.shape.credentialTransport,
    model: TeamCredentialProviderModelCatalogEntryV1Schema,
  }),
}));
export type ManagedNativeCredentialBindingV1 = z.infer<typeof ManagedNativeCredentialBindingV1Schema>;
