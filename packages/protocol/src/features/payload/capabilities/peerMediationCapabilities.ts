import { z } from 'zod';

import { PeerMediationObservabilityEventKindV1Schema } from '../../../machines/peer/mediation/observability/v1.js';
import { PeerFlowKindV1Schema } from '../../../machines/peer/mediation/flowKind.js';

export const PeerMediationGrantSigningKeyCapabilitySchema = z.object({
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
  expiresAt: z.number().int().positive().nullable().optional().default(null),
});

export type PeerMediationGrantSigningKeyCapability = z.infer<typeof PeerMediationGrantSigningKeyCapabilitySchema>;

const CaptureAvailabilitySchema = z.enum(['unavailable', 'off', 'metadataOnly']);

export const PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS = {
  perFlowEvents: 512,
  perMachineEvents: 2048,
  eventPayloadMaxBytes: 16_384,
  retentionWindowMs: 900_000,
  uiStoreMaxBytesPerMachine: 4_194_304,
  maxCounterSampleHz: 2,
} as const;

export const PeerMediationObservabilityRetentionCapabilitiesSchema = z
  .object({
    perFlowEvents: z.number().int().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perFlowEvents).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perFlowEvents),
    perMachineEvents: z.number().int().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perMachineEvents).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perMachineEvents),
    eventPayloadMaxBytes: z.number().int().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.eventPayloadMaxBytes).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.eventPayloadMaxBytes),
    retentionWindowMs: z.number().int().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.retentionWindowMs).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.retentionWindowMs),
    uiStoreMaxBytesPerMachine: z.number().int().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.uiStoreMaxBytesPerMachine).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.uiStoreMaxBytesPerMachine),
    maxCounterSampleHz: z.number().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz),
  })
  .strict();
export type PeerMediationObservabilityRetentionCapabilities = z.infer<
  typeof PeerMediationObservabilityRetentionCapabilitiesSchema
>;

export const DEFAULT_PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPABILITIES: PeerMediationObservabilityRetentionCapabilities = {
  perFlowEvents: PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perFlowEvents,
  perMachineEvents: PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perMachineEvents,
  eventPayloadMaxBytes: PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.eventPayloadMaxBytes,
  retentionWindowMs: PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.retentionWindowMs,
  uiStoreMaxBytesPerMachine: PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.uiStoreMaxBytesPerMachine,
  maxCounterSampleHz: PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz,
};

export const PeerMediationObservabilitySamplingCapabilitiesSchema = z
  .object({
    counterSampleHz: z.number().positive().max(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz).optional().default(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz),
    throughputWindowMs: z.number().int().positive().optional().default(1000),
  })
  .strict();
export type PeerMediationObservabilitySamplingCapabilities = z.infer<
  typeof PeerMediationObservabilitySamplingCapabilitiesSchema
>;

export const DEFAULT_PEER_MEDIATION_OBSERVABILITY_SAMPLING_CAPABILITIES: PeerMediationObservabilitySamplingCapabilities = {
  counterSampleHz: 2,
  throughputWindowMs: 1000,
};

export const PeerMediationObservabilityCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedFlowKinds: z.array(PeerFlowKindV1Schema).optional().default([]),
    supportedEventKinds: z.array(PeerMediationObservabilityEventKindV1Schema).optional().default([]),
    retention: PeerMediationObservabilityRetentionCapabilitiesSchema.optional().default(
      DEFAULT_PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPABILITIES,
    ),
    sampling: PeerMediationObservabilitySamplingCapabilitiesSchema.optional().default(
      DEFAULT_PEER_MEDIATION_OBSERVABILITY_SAMPLING_CAPABILITIES,
    ),
    bodyCapture: CaptureAvailabilitySchema.optional().default('unavailable'),
    payloadCapture: CaptureAvailabilitySchema.optional().default('unavailable'),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
    publicPreviewScopedSummaries: z.boolean().optional().default(false),
  })
  .strict();
export type PeerMediationObservabilityCapabilities = z.infer<
  typeof PeerMediationObservabilityCapabilitiesSchema
>;

export const DEFAULT_PEER_MEDIATION_OBSERVABILITY_CAPABILITIES: PeerMediationObservabilityCapabilities = {
  enabled: false,
  available: false,
  supportedFlowKinds: [],
  supportedEventKinds: [],
  retention: DEFAULT_PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPABILITIES,
  sampling: DEFAULT_PEER_MEDIATION_OBSERVABILITY_SAMPLING_CAPABILITIES,
  bodyCapture: 'unavailable',
  payloadCapture: 'unavailable',
  disabledReasons: [],
  publicPreviewScopedSummaries: false,
};

export const PeerMediationCapabilitiesSchema = z.object({
  grantSigningKeys: z.array(PeerMediationGrantSigningKeyCapabilitySchema).optional().default([]),
  observability: PeerMediationObservabilityCapabilitiesSchema.optional().default(
    DEFAULT_PEER_MEDIATION_OBSERVABILITY_CAPABILITIES,
  ),
});

export type PeerMediationCapabilities = z.infer<typeof PeerMediationCapabilitiesSchema>;

export const DEFAULT_PEER_MEDIATION_CAPABILITIES: PeerMediationCapabilities = {
  grantSigningKeys: [],
  observability: DEFAULT_PEER_MEDIATION_OBSERVABILITY_CAPABILITIES,
};
