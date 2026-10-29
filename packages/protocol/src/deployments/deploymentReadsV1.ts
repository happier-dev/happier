import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { MachineServiceIdentityV1Schema } from '../local/services/serviceIdentityV1.js';
import { ManagedServiceNativeStateV1Schema } from '../local/services/nativeStateV1.js';
import { ManagedServiceNativeLogCursorV1Schema, ManagedServiceNativeLogResultV1Schema,
  ManagedServiceUnavailableReasonV1Schema } from '../local/services/nativeLogsV1.js';

const target = { environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id };
const input = { serverId: id, ...target };
const service = { service: MachineServiceIdentityV1Schema };
const matchesService = (value: { environmentId: string; machineId: string; service: z.infer<typeof MachineServiceIdentityV1Schema> }) =>
  value.environmentId === value.service.environmentId && value.machineId === value.service.machineId;
const serviceIdentityCheck = { message: 'The stable service belongs to the selected Environment and Machine.' };
const freshness = { observedAtMs: z.nullable(timestamp), freshness: z.enum(['current', 'stale', 'unavailable']) };

/** No caller-owned native facts, probes, deadlines or mutation operands. */
export const DeploymentHealthReadInputV1Schema = lazyZodSchema(() => z.strictObject({ ...input, ...service })
  .check(z.refine(matchesService, serviceIdentityCheck)));
export const DeploymentDriftReadInputV1Schema = lazyZodSchema(() => z.strictObject({ ...input, ...service, expectedRevision: revision })
  .check(z.refine(matchesService, serviceIdentityCheck)));
export const DeploymentLogsReadInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...input, kind: z.literal('build'), cursor: z.optional(ManagedServiceNativeLogCursorV1Schema) }),
  z.strictObject({ ...input, ...service, kind: z.literal('runtime'), cursor: z.optional(ManagedServiceNativeLogCursorV1Schema) })
    .check(z.refine(matchesService, serviceIdentityCheck)),
]));
export type DeploymentHealthReadInputV1 = z.infer<typeof DeploymentHealthReadInputV1Schema>;
export type DeploymentDriftReadInputV1 = z.infer<typeof DeploymentDriftReadInputV1Schema>;
export type DeploymentLogsReadInputV1 = z.infer<typeof DeploymentLogsReadInputV1Schema>;

/** L2 supplies current P30 observations and matching receipt evidence, not a second observer. */
export const DeploymentHealthReadSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), ...target, ...service, ...freshness,
  native: z.nullable(ManagedServiceNativeStateV1Schema),
  health: z.enum(['healthy', 'unhealthy', 'running_unverified', 'unknown']),
  evidence: z.array(z.strictObject({ source: z.enum(['native', 'receipt']), observedAtMs: z.nullable(timestamp),
    revision: z.optional(id) })),
  unavailableReason: z.optional(ManagedServiceUnavailableReasonV1Schema),
}).check(z.refine(matchesService, serviceIdentityCheck)));
export const DeploymentDriftFieldV1Schema = lazyZodSchema(() => z.enum([
  'environmentRevision', 'activeDeployment', 'targetInstallation', 'serviceIdentity',
  'composeDigest', 'configDigest', 'materializationReceipt', 'ownerLabels',
]));
export const DeploymentDriftReadSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), ...target, ...service, ...freshness, revision,
  status: z.enum(['in_sync', 'drifted', 'unknown']),
  differingFields: z.array(DeploymentDriftFieldV1Schema), missingFields: z.array(DeploymentDriftFieldV1Schema),
}).check(z.refine(matchesService, serviceIdentityCheck)));
/** Both front doors reuse the native source-bound cursor/result grammar without another byte budget. */
export const DeploymentLogsReadSuccessV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ok: z.literal(true), ...target, kind: z.literal('build'), logs: ManagedServiceNativeLogResultV1Schema }),
  z.strictObject({ ok: z.literal(true), ...target, ...service, kind: z.literal('runtime'), logs: ManagedServiceNativeLogResultV1Schema })
    .check(z.refine(matchesService, serviceIdentityCheck)),
]));
