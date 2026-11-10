import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { PeerMediationObservabilityEventKindV1Schema } from '../../../machines/peer/mediation/observability/v1.js';
import { PeerFlowKindV1Schema } from '../../../machines/peer/mediation/flowKind.js';

export const PeerMediationGrantSigningKeyCapabilitySchema = lazyZodSchema(() => z.object({
  keyId: z.string().check(z.minLength(1)),
  publicKey: z.string().check(z.minLength(1)),
  expiresAt: z._default(z.optional(z.nullable(z.number().check(z.int(), z.positive()))), null),
}));

export type PeerMediationGrantSigningKeyCapability = z.infer<typeof PeerMediationGrantSigningKeyCapabilitySchema>;

const CaptureAvailabilitySchema = lazyZodSchema(() => z.enum(['unavailable', 'off', 'metadataOnly']));

export const PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS = {
  perFlowEvents: 512,
  perMachineEvents: 2048,
  eventPayloadMaxBytes: 16_384,
  retentionWindowMs: 900_000,
  uiStoreMaxBytesPerMachine: 4_194_304,
  maxCounterSampleHz: 2,
} as const;

export const PeerMediationObservabilityRetentionCapabilitiesSchema = lazyZodSchema(() => z.object({
    perFlowEvents: z._default(z.optional(z.number().check(z.int(), z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perFlowEvents))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perFlowEvents),
    perMachineEvents: z._default(z.optional(z.number().check(z.int(), z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perMachineEvents))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.perMachineEvents),
    eventPayloadMaxBytes: z._default(z.optional(z.number().check(z.int(), z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.eventPayloadMaxBytes))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.eventPayloadMaxBytes),
    retentionWindowMs: z._default(z.optional(z.number().check(z.int(), z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.retentionWindowMs))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.retentionWindowMs),
    uiStoreMaxBytesPerMachine: z._default(z.optional(z.number().check(z.int(), z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.uiStoreMaxBytesPerMachine))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.uiStoreMaxBytesPerMachine),
    maxCounterSampleHz: z._default(z.optional(z.number().check(z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz),
  }));
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

export const PeerMediationObservabilitySamplingCapabilitiesSchema = lazyZodSchema(() => z.object({
    counterSampleHz: z._default(z.optional(z.number().check(z.positive(), z.maximum(PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz))), PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPS.maxCounterSampleHz),
    throughputWindowMs: z._default(z.optional(z.number().check(z.int(), z.positive())), 1000),
  }));
export type PeerMediationObservabilitySamplingCapabilities = z.infer<
  typeof PeerMediationObservabilitySamplingCapabilitiesSchema
>;

export const DEFAULT_PEER_MEDIATION_OBSERVABILITY_SAMPLING_CAPABILITIES: PeerMediationObservabilitySamplingCapabilities = {
  counterSampleHz: 2,
  throughputWindowMs: 1000,
};

export const PeerMediationObservabilityCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedFlowKinds: z._default(z.optional(z.array(PeerFlowKindV1Schema)), []),
    supportedEventKinds: z._default(z.optional(z.array(PeerMediationObservabilityEventKindV1Schema)), []),
    retention: z._default(z.optional(PeerMediationObservabilityRetentionCapabilitiesSchema), DEFAULT_PEER_MEDIATION_OBSERVABILITY_RETENTION_CAPABILITIES),
    sampling: z._default(z.optional(PeerMediationObservabilitySamplingCapabilitiesSchema), DEFAULT_PEER_MEDIATION_OBSERVABILITY_SAMPLING_CAPABILITIES),
    bodyCapture: z._default(z.optional(CaptureAvailabilitySchema), 'unavailable'),
    payloadCapture: z._default(z.optional(CaptureAvailabilitySchema), 'unavailable'),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
    publicPreviewScopedSummaries: z._default(z.optional(z.boolean()), false),
  }));
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

export const PeerMediationCapabilitiesSchema = lazyZodSchema(() => z.object({
  grantSigningKeys: z._default(z.optional(z.array(PeerMediationGrantSigningKeyCapabilitySchema)), []),
  tcpTunnelRelayAuthorizationMintVersions: z._default(z.optional(z.array(z.literal(2)).check(z.maxLength(1))), []),
  observability: z._default(z.optional(PeerMediationObservabilityCapabilitiesSchema), DEFAULT_PEER_MEDIATION_OBSERVABILITY_CAPABILITIES),
}));

export type PeerMediationCapabilities = z.infer<typeof PeerMediationCapabilitiesSchema>;

export const DEFAULT_PEER_MEDIATION_CAPABILITIES: PeerMediationCapabilities = {
  grantSigningKeys: [],
  tcpTunnelRelayAuthorizationMintVersions: [],
  observability: DEFAULT_PEER_MEDIATION_OBSERVABILITY_CAPABILITIES,
};
