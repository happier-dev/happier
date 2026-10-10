import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { MachineLiveStreamCodecIdV1Schema } from '../../machines/peer/mediation/stream/codecsV1.js';
import { MachineLiveStreamInputControlKindV1Schema } from '../../machines/peer/mediation/stream/controlV1.js';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().trim().min(1).max(512));
const DiagnosticRecordSchema = lazyZodSchema(() => z.record(z.string(), z.unknown()));

export const IosSimulatorAdapterUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'unsupported_host',
  'xcode_unavailable',
  'xcode_private_frameworks_unavailable',
  'helper_artifact_missing',
  'helper_artifact_unsigned',
  'helper_artifact_digest_mismatch',
  'helper_version_mismatch',
  'private_framework_symbol_mismatch',
  'simulator_not_booted',
  'ios_private_helper_unavailable',
  'screen_capture_permission_required',
]));
export type IosSimulatorAdapterUnavailableReasonV1 = z.infer<
  typeof IosSimulatorAdapterUnavailableReasonV1Schema
>;

export const IosSimulatorAdapterCapabilitiesV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    platform: z.literal('ios'),
    usesPrivateFrameworks: z.literal(true),
    helperDistribution: z.enum(['prebuilt-signed', 'development-build']),
    requiredPrivateFrameworks: z.tuple([
      z.literal('CoreSimulator'),
      z.literal('SimulatorKit'),
    ]),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    supportedInputKinds: z.array(MachineLiveStreamInputControlKindV1Schema).default([]),
    helperVersion: NonEmptyStringSchema.optional(),
    xcodeVersion: NonEmptyStringSchema.optional(),
  })
  .strict());
export type IosSimulatorAdapterCapabilitiesV1 = z.infer<
  typeof IosSimulatorAdapterCapabilitiesV1Schema
>;

export const IosSimulatorAdapterHealthV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  IosSimulatorAdapterCapabilitiesV1Schema.extend({
    status: z.literal('available'),
  }).strict(),
  z
    .object({
      v: z.literal(1),
      platform: z.literal('ios'),
      status: z.literal('unavailable'),
      reasonCode: IosSimulatorAdapterUnavailableReasonV1Schema,
      diagnostics: z.array(DiagnosticRecordSchema).default([]),
    })
    .strict(),
]));
export type IosSimulatorAdapterHealthV1 = z.infer<typeof IosSimulatorAdapterHealthV1Schema>;
