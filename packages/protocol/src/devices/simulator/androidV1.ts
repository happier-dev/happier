import { z } from 'zod';

import {
  MachineLiveStreamCodecIdV1Schema,
  MachineLiveStreamInputControlKindV1Schema,
} from '../../machines/peer/mediation/stream/index.js';

const NonEmptyStringSchema = z.string().trim().min(1).max(512);
const DiagnosticRecordSchema = z.record(z.string(), z.unknown());

export const AndroidSimulatorAdapterUnavailableReasonV1Schema = z.enum([
  'adb_unavailable',
  'android_emulator_unavailable',
  'android_device_unauthorized',
  'android_device_offline',
  'physical_device_not_supported_v1',
  'scrcpy_server_artifact_missing',
  'scrcpy_server_digest_mismatch',
  'scrcpy_server_version_mismatch',
  'scrcpy_server_push_failed',
  'encoder_unavailable',
  'control_disabled',
  'clipboard_disabled',
  'android_emulator_bridge_unavailable',
]);
export type AndroidSimulatorAdapterUnavailableReasonV1 = z.infer<
  typeof AndroidSimulatorAdapterUnavailableReasonV1Schema
>;

export const AndroidSimulatorAdapterCapabilitiesV1Schema = z
  .object({
    v: z.literal(1),
    platform: z.literal('android'),
    transport: z.enum(['scrcpy-local-sockets-over-pms', 'adb-screencap-degraded']),
    physicalDevicesSupported: z.literal(false),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    supportedInputKinds: z.array(MachineLiveStreamInputControlKindV1Schema).default([]),
    clipboardSyncDefault: z.literal('disabled'),
    adbVersion: NonEmptyStringSchema.optional(),
    scrcpyServerVersion: NonEmptyStringSchema.optional(),
    scrcpyServerDigest: NonEmptyStringSchema.optional(),
  })
  .strict();
export type AndroidSimulatorAdapterCapabilitiesV1 = z.infer<
  typeof AndroidSimulatorAdapterCapabilitiesV1Schema
>;

export const AndroidSimulatorAdapterHealthV1Schema = z.discriminatedUnion('status', [
  AndroidSimulatorAdapterCapabilitiesV1Schema.extend({
    status: z.literal('available'),
  }).strict(),
  z
    .object({
      v: z.literal(1),
      platform: z.literal('android'),
      status: z.literal('unavailable'),
      reasonCode: AndroidSimulatorAdapterUnavailableReasonV1Schema,
      diagnostics: z.array(DiagnosticRecordSchema).default([]),
    })
    .strict(),
]);
export type AndroidSimulatorAdapterHealthV1 = z.infer<typeof AndroidSimulatorAdapterHealthV1Schema>;
