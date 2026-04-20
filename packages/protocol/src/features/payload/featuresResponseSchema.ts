import { z } from 'zod';

import { CapabilitiesSchema, type Capabilities } from './capabilities/capabilitiesSchema.js';
import { FeatureGatesSchema, type FeatureGates } from './featureGatesSchema.js';
import { isRecord } from './isRecord.js';
import { coerceBugReportsCapabilitiesFromFeaturesPayload } from './capabilities/bugReportsCapabilities.js';

function coerceFeaturesResponsePayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  // Robustness: malformed bugReports capabilities must not invalidate unrelated feature gates.
  // Coerce it to a safe default while preserving the rest of the payload.
  const next = { ...raw } as Record<string, unknown>;
  if (!isRecord(next.capabilities)) {
    next.capabilities = {};
  }

  // Robustness: missing voice enabled bits must be treated as disabled rather than invalidating the payload.
  if (isRecord(next.features)) {
    const features = { ...(next.features as Record<string, unknown>) };
    const voice = features.voice;
    if (isRecord(voice)) {
      const coercedVoice: Record<string, unknown> = { ...voice };
      if (typeof coercedVoice.enabled !== 'boolean') {
        coercedVoice.enabled = false;
      }
      const happierVoice = coercedVoice.happierVoice;
      if (isRecord(happierVoice)) {
        const coercedHappierVoice: Record<string, unknown> = { ...happierVoice };
        if (typeof coercedHappierVoice.enabled !== 'boolean') {
          coercedHappierVoice.enabled = false;
        }
        coercedVoice.happierVoice = coercedHappierVoice;
      }
      features.voice = coercedVoice;
      next.features = features;
    }
  }

  return {
    ...next,
    capabilities: {
      ...(next.capabilities as Record<string, unknown>),
      bugReports: coerceBugReportsCapabilitiesFromFeaturesPayload(next),
    },
  };
}

export const FeaturesResponseSchema = z.preprocess(
  coerceFeaturesResponsePayload,
  z.object({
    features: FeatureGatesSchema,
    capabilities: CapabilitiesSchema,
  }),
);

export type FeaturesResponse = Readonly<{
  features: FeatureGates;
  capabilities: Capabilities;
}>;
