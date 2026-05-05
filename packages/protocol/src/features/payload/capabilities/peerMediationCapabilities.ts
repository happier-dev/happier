import { z } from 'zod';

export const PeerMediationGrantSigningKeyCapabilitySchema = z.object({
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
  expiresAt: z.number().int().positive().nullable().optional().default(null),
});

export type PeerMediationGrantSigningKeyCapability = z.infer<typeof PeerMediationGrantSigningKeyCapabilitySchema>;

export const PeerMediationCapabilitiesSchema = z.object({
  grantSigningKeys: z.array(PeerMediationGrantSigningKeyCapabilitySchema).optional().default([]),
});

export type PeerMediationCapabilities = z.infer<typeof PeerMediationCapabilitiesSchema>;

export const DEFAULT_PEER_MEDIATION_CAPABILITIES: PeerMediationCapabilities = {
  grantSigningKeys: [],
};
