import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PluginLiveStreamReferenceV1Schema } from '../plugins/ui/liveStream.js';
import { MachineLiveStreamCodecIdV1Schema } from '../machines/peer/mediation/stream/codecsV1.js';

export const DaemonPluginUiCaptureSourceReadRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  callerPluginId: z.string().check(z.trim(), z.minLength(1)),
  expectedCallerOccurrenceId: z.string().check(z.trim(), z.minLength(1)),
  reference: PluginLiveStreamReferenceV1Schema,
}));
export type DaemonPluginUiCaptureSourceReadRequest = z.infer<typeof DaemonPluginUiCaptureSourceReadRequestSchema>;
export const DaemonPluginUiCaptureSourceDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  sourceId: z.string().check(z.minLength(1)),
  sourceOccurrenceId: z.string().check(z.minLength(1)),
  streamFamily: z.string().check(z.minLength(1)),
  supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).check(z.minLength(1)),
  requiresApproval: z.boolean(),
}));
export type DaemonPluginUiCaptureSourceDescriptorV1 = z.infer<typeof DaemonPluginUiCaptureSourceDescriptorV1Schema>;
export const DaemonPluginUiCaptureSourceReadResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), source: DaemonPluginUiCaptureSourceDescriptorV1Schema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['capture_source_denied', 'capture_source_unavailable', 'plugin_occurrence_stale', 'invalid_payload']) }),
]));
export type DaemonPluginUiCaptureSourceReadResponse = z.infer<typeof DaemonPluginUiCaptureSourceReadResponseSchema>;
