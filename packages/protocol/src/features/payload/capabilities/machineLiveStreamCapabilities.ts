import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  MachineLiveStreamRelayCapsV1Schema,
  type MachineLiveStreamRelayCaps,
} from '../../../machines/peer/mediation/stream/v1.js';
import type { FeaturesResponse } from '../featuresResponseSchema.js';
import { isRecord } from '../isRecord.js';

export const MachineLiveStreamRelayDisabledReasonSchema = lazyZodSchema(() => z.enum([
  'relay_not_enabled',
  'relay_caps_missing',
  'server_routed_live_stream_disabled',
  'cap_exceeded',
]));

export type MachineLiveStreamRelayDisabledReason = z.infer<typeof MachineLiveStreamRelayDisabledReasonSchema>;

// The transport owner keeps its extensible resource bag; feature reads project known diagnostics.
const MachineLiveStreamRelayCapsReadSchema = lazyZodSchema(() => z.object(MachineLiveStreamRelayCapsV1Schema.shape));

export const MachineLiveStreamServerRoutedCapabilitiesSchema = lazyZodSchema(() => z.catch(z.object({
    caps: z._default(z.optional(z.nullable(MachineLiveStreamRelayCapsReadSchema)), null),
    disabledReason: z._default(z.optional(z.nullable(MachineLiveStreamRelayDisabledReasonSchema)), 'relay_not_enabled'),
  }), { caps: null, disabledReason: 'relay_caps_missing' }));

export type MachineLiveStreamServerRoutedCapabilities = z.infer<
  typeof MachineLiveStreamServerRoutedCapabilitiesSchema
>;

export const DEFAULT_MACHINE_LIVE_STREAM_SERVER_ROUTED_CAPABILITIES: MachineLiveStreamServerRoutedCapabilities = {
  caps: null,
  disabledReason: 'relay_not_enabled',
};

export const MachineLiveStreamCapabilitiesSchema = lazyZodSchema(() => z.object({
  serverRouted: z._default(z.optional(MachineLiveStreamServerRoutedCapabilitiesSchema), DEFAULT_MACHINE_LIVE_STREAM_SERVER_ROUTED_CAPABILITIES),
}));

export type MachineLiveStreamCapabilities = z.infer<typeof MachineLiveStreamCapabilitiesSchema>;

export const DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES: MachineLiveStreamCapabilities = {
  serverRouted: DEFAULT_MACHINE_LIVE_STREAM_SERVER_ROUTED_CAPABILITIES,
};

export function readMachineLiveStreamRelayCaps(
  features: Pick<FeaturesResponse, 'capabilities'> | null | undefined,
): MachineLiveStreamRelayCaps | null {
  const capabilities = features && isRecord(features.capabilities) ? features.capabilities : null;
  const machines = capabilities && isRecord(capabilities.machines) ? capabilities.machines : null;
  const liveStream = machines && isRecord(machines.liveStream) ? machines.liveStream : null;
  const serverRouted = liveStream && isRecord(liveStream.serverRouted) ? liveStream.serverRouted : null;
  const parsed = MachineLiveStreamRelayCapsV1Schema.safeParse(serverRouted?.caps);
  return parsed.success ? parsed.data : null;
}
