import { z } from 'zod';

import {
  ClientKindAppVersionMapV1Schema,
  ClientKindUpgradeUrlMapV1Schema,
  ExternalSessionImportPublicationFenceVersionSchema,
  PendingInputProtocolVersionSchema,
  SessionSyncProtocolVersionSchema,
} from './primitives.js';

export const SessionSyncCompatibilityEnforcementSchema = z.enum(['observe', 'required']);

export const SessionSyncServerRequirementsV1Schema = z
  .object({
    v: z.literal(1),
    enforcement: SessionSyncCompatibilityEnforcementSchema,
    minimumSessionSyncProtocolVersion: SessionSyncProtocolVersionSchema,
    currentSessionSyncProtocolVersion: SessionSyncProtocolVersionSchema,
    declarationTransport: z.literal('headers-v1'),
    minimumVersionsByClientKind: ClientKindAppVersionMapV1Schema.optional(),
    upgradeUrlsByClientKind: ClientKindUpgradeUrlMapV1Schema.optional(),
  })
  .strict();

export type SessionSyncServerRequirementsV1 = z.infer<typeof SessionSyncServerRequirementsV1Schema>;

export const PendingInputServerContractV1Schema = z
  .object({
    currentPendingInputProtocolVersion: PendingInputProtocolVersionSchema,
  })
  .strict();

export type PendingInputServerContractV1 = z.infer<typeof PendingInputServerContractV1Schema>;

export const ExternalSessionImportServerContractV1Schema = z
  .object({
    currentPublicationFenceVersion: ExternalSessionImportPublicationFenceVersionSchema,
  })
  .strict();

export type ExternalSessionImportServerContractV1 = z.infer<
  typeof ExternalSessionImportServerContractV1Schema
>;

export const ClientCompatibilityCapabilitiesV1Schema = z
  .object({
    v: z.literal(1),
    sessionSync: SessionSyncServerRequirementsV1Schema,
    pendingInput: PendingInputServerContractV1Schema.optional(),
    externalSessionImport: ExternalSessionImportServerContractV1Schema.optional(),
  })
  .strict();

export type ClientCompatibilityCapabilitiesV1 = z.infer<typeof ClientCompatibilityCapabilitiesV1Schema>;

export const SessionSyncPendingInputCompatibilityPingAckV1Schema = z
  .object({
    v: z.literal(1),
    compatibility: ClientCompatibilityCapabilitiesV1Schema,
  })
  .strict();

export type SessionSyncPendingInputCompatibilityPingAckV1 = z.infer<typeof SessionSyncPendingInputCompatibilityPingAckV1Schema>;
