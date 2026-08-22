import { z } from 'zod';

import {
  PluginContributionLocalIdSchema,
  PluginIdSchema,
} from '@happier-dev/protocol';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

/**
 * Restricted to the disposable packed-test daemon. This is a read-only
 * projection of the current registry's already-admitted targeted snapshot;
 * it is not a second admission, catalog, or plugin-facing API.
 */
export const PACKED_TEST_TARGETED_ADMISSION_READ_PATH =
  '/plugins/packed-test/targeted-admission/read';

const ProtocolIdSchema = z.string().trim().min(1).max(256);
const ProtocolSchema = z.object({
  id: ProtocolIdSchema,
  version: z.number().int().positive().safe(),
}).strict();
const ImmutableGenerationIdSchema = z.string().trim().min(1).max(512);
const HostPluginIdSchema = asHostProtocolZod(PluginIdSchema);
const HostPluginContributionLocalIdSchema = asHostProtocolZod(
  PluginContributionLocalIdSchema,
);

export const PackedTestTargetedAdmissionReadRequestSchema = z.object({
  targetPluginId: HostPluginIdSchema,
  pointId: HostPluginContributionLocalIdSchema,
  protocol: ProtocolSchema,
}).strict();

export type PackedTestTargetedAdmissionReadRequest = z.infer<
  typeof PackedTestTargetedAdmissionReadRequestSchema
>;

export const PackedTestTargetedAdmissionReadResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('available'),
    target: z.object({
      pluginId: HostPluginIdSchema,
      pointId: HostPluginContributionLocalIdSchema,
      immutableGenerationId: ImmutableGenerationIdSchema,
    }).strict(),
    protocol: ProtocolSchema,
    contributors: z.array(z.object({
      pluginId: HostPluginIdSchema,
      contributionId: HostPluginContributionLocalIdSchema,
      immutableGenerationId: ImmutableGenerationIdSchema,
    }).strict()).max(256),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    code: z.enum([
      'plugin_packed_targeted_admission_invalid_request',
      'plugin_packed_targeted_admission_runtime_unavailable',
      'plugin_packed_targeted_admission_reader_missing',
      'plugin_packed_targeted_admission_snapshot_missing',
      'plugin_packed_targeted_admission_snapshot_mismatch',
      'plugin_packed_targeted_admission_stale',
    ]),
  }).strict(),
]);

export type PackedTestTargetedAdmissionReadResponse = z.infer<
  typeof PackedTestTargetedAdmissionReadResponseSchema
>;

function unavailable(
  code: Extract<PackedTestTargetedAdmissionReadResponse, { kind: 'unavailable' }>['code'],
): PackedTestTargetedAdmissionReadResponse {
  return Object.freeze({ kind: 'unavailable', code });
}

/**
 * Reads one exact target point from the incumbent runtime registry while its
 * lease remains current. The registry remains the sole admission owner.
 */
export async function readPackedTestTargetedAdmission(params: Readonly<{
  reloadController: PluginReloadController;
  request: PackedTestTargetedAdmissionReadRequest;
}>): Promise<PackedTestTargetedAdmissionReadResponse> {
  const lease = params.reloadController.tryAcquireRuntimeRegistry?.() ?? null;
  if (!lease) return unavailable('plugin_packed_targeted_admission_runtime_unavailable');
  try {
    if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
      return unavailable('plugin_packed_targeted_admission_stale');
    }
    const reader = lease.registry.readAdmittedTargetedContributions;
    if (!reader) return unavailable('plugin_packed_targeted_admission_reader_missing');
    const snapshot = reader(params.request);
    if (!snapshot) return unavailable('plugin_packed_targeted_admission_snapshot_missing');
    if (
      snapshot.target.pluginId !== params.request.targetPluginId
      || snapshot.target.pointId !== params.request.pointId
    ) {
      return unavailable('plugin_packed_targeted_admission_snapshot_mismatch');
    }
    if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
      return unavailable('plugin_packed_targeted_admission_stale');
    }
    return PackedTestTargetedAdmissionReadResponseSchema.parse({
      kind: 'available',
      target: snapshot.target,
      protocol: params.request.protocol,
      contributors: snapshot.contributions.map((contribution) => contribution.contributor),
    });
  } finally {
    await lease.release();
  }
}
