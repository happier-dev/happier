import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { MachineLiveStreamCodecIdV1Schema } from '../../machines/peer/mediation/stream/codecsV1.js';

/** Manifest-owned, read-only capture. Input remains a host Action capability. */
export const PluginCaptureSourceContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  displayName: z.string().check(z.trim(), z.minLength(1)),
  streamFamily: z.string().check(z.trim(), z.minLength(1)),
  supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).check(z.minLength(1)),
}));
export type PluginCaptureSourceContributionV1 = z.infer<typeof PluginCaptureSourceContributionV1Schema>;
