import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { PluginLiveStreamReferenceV1Schema } from '../plugins/ui/liveStream.js';
import { MachineLiveStreamCodecIdV1Schema } from '../machines/peer/mediation/stream/codecsV1.js';

export const DaemonPluginUiCaptureSourceReadRequestSchema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  callerPluginId: z.string().trim().min(1),
  expectedCallerOccurrenceId: z.string().trim().min(1),
  reference: PluginLiveStreamReferenceV1Schema,
}).strict());
export type DaemonPluginUiCaptureSourceReadRequest = z.infer<typeof DaemonPluginUiCaptureSourceReadRequestSchema>;
export const DaemonPluginUiCaptureSourceDescriptorV1Schema = lazyZodSchema(() => z.object({
  sourceId: z.string().min(1),
  sourceOccurrenceId: z.string().min(1),
  streamFamily: z.string().min(1),
  supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
  requiresApproval: z.boolean(),
}).strict());
export type DaemonPluginUiCaptureSourceDescriptorV1 = z.infer<typeof DaemonPluginUiCaptureSourceDescriptorV1Schema>;
export const DaemonPluginUiCaptureSourceReadResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), source: DaemonPluginUiCaptureSourceDescriptorV1Schema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['capture_source_denied', 'capture_source_unavailable', 'plugin_occurrence_stale', 'invalid_payload']) }).strict(),
]));
export type DaemonPluginUiCaptureSourceReadResponse = z.infer<typeof DaemonPluginUiCaptureSourceReadResponseSchema>;
