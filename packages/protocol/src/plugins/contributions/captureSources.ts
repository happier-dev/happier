import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { MachineLiveStreamCodecIdV1Schema } from '../../machines/peer/mediation/stream/codecsV1.js';

/** Manifest-owned, read-only capture. Input remains a host Action capability. */
export const PluginCaptureSourceContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  displayName: z.string().trim().min(1),
  streamFamily: z.string().trim().min(1),
  supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
}).strict());
export type PluginCaptureSourceContributionV1 = z.infer<typeof PluginCaptureSourceContributionV1Schema>;
