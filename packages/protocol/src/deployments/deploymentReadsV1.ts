import { z } from '../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { MachineDeploymentServiceIdentityV1Schema } from '../local/services/serviceIdentityV1.js';
import { ManagedServiceNativeStateV1Schema } from '../local/services/nativeStateV1.js';
import { HealthCheckResultV1Schema } from './healthCheckV1.js';
import { DeploymentReferenceSourceV1Schema, EnvironmentVariableBindingV1Schema } from './storedAppInputV1.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '../account/settings/savedSecretReferenceV1.js';
import { ManagedServiceNativeLogCursorV1Schema, ManagedServiceNativeLogResultV1Schema,
  ManagedServiceUnavailableReasonV1Schema } from '../local/services/nativeLogsV1.js';

const target = { environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id };
const input = { serverId: id, ...target };
const service = { service: MachineDeploymentServiceIdentityV1Schema };
const referenceBinding = () => ({ name: EnvironmentVariableBindingV1Schema.shape.name,
  phase: EnvironmentVariableBindingV1Schema.shape.phase, source: DeploymentReferenceSourceV1Schema });
/** Nonsecret address actually supplied to the exact installed build/runtime phase. */
export const DeploymentReferenceAddressV1Schema = lazyZodSchema(() => z.strictObject({
  ...referenceBinding(), machineId: id, installationId: id, address: z.string(),
  route: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('iroh'), observedPath: z.enum(['direct', 'relay', 'unknown']), containerNetworkId: z.optional(id) }),
    z.strictObject({ kind: z.literal('privateNetwork'), networkIdentity: id }),
  ])),
}));
export type DeploymentReferenceAddressV1 = z.infer<typeof DeploymentReferenceAddressV1Schema>;
export const DeploymentSecretRevisionFactV1Schema = lazyZodSchema(() => z.strictObject({
  name: EnvironmentVariableBindingV1Schema.shape.name, phase: EnvironmentVariableBindingV1Schema.shape.phase,
  ref: SharedSavedSecretReferenceSelectionV1Schema.shape.ref,
  runningRevision: z.nullable(revision), currentRevision: z.nullable(revision),
  status: z.enum(['unchanged', 'redeploy_required', 'unavailable', 'unknown']), reason: z.optional(z.string()),
}));
export type DeploymentSecretRevisionFactV1 = z.infer<typeof DeploymentSecretRevisionFactV1Schema>;
const matchesService = (value: { environmentId: string; machineId: string; service: z.infer<typeof MachineDeploymentServiceIdentityV1Schema> }) =>
  value.environmentId === value.service.environmentId && value.machineId === value.service.machineId;
const serviceIdentityCheck = { message: 'The stable service belongs to the selected Environment and Machine.' };
const freshness = { observedAtMs: z.nullable(timestamp), freshness: z.enum(['current', 'stale', 'unavailable']) };

/** Reads the admitted observer's current fact; never accepts a probe destination. */
export const DeploymentHealthCurrentInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id, environmentId: id, targetLinkId: id,
  /** Selected Domain rows only; omitted by the existing edge aggregate reader. */
  domainIds: z.optional(z.array(id).check(z.minLength(1))),
}));
const domainVantage = () => z.enum(['sameMachine', 'outside']);
/** Existing saved-check evidence, never a new probe or scheduling contract. */
export const DeploymentCurrentDomainObservationV1Schema = lazyZodSchema(() => z.strictObject({
  domainId: id, domainRevision: revision, targetLinkRevision: revision,
  kind: z.enum(['http', 'certificate']), observerMachineId: id, vantage: domainVantage(),
  result: HealthCheckResultV1Schema,
}));
export type DeploymentCurrentDomainObservationV1 = z.infer<typeof DeploymentCurrentDomainObservationV1Schema>;
export const DeploymentDomainHealthFactsV1Schema = lazyZodSchema(() => z.strictObject({
  availability: z.enum(['observed', 'not_checked', 'unavailable']), unavailableReason: z.nullable(id),
  observedAt: z.nullable(timestamp), vantage: z.nullable(domainVantage()),
  certificate: z.strictObject({ state: z.enum(['not_checked', 'valid', 'invalid', 'expired', 'expiresSoon']),
    expiresAt: z.nullable(timestamp) }),
  needsYou: z.nullable(z.strictObject({ cause: z.enum(['dns', 'network', 'certificate', 'http']),
    reason: id, vantage: z.nullable(domainVantage()) })),
}));
export type DeploymentDomainHealthFactsV1 = z.infer<typeof DeploymentDomainHealthFactsV1Schema>;
export const DeploymentCurrentEdgeObservationV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: id, targetLinkId: id, targetLinkRevision: revision,
  machineId: id, installationId: z.optional(id), role: z.literal('edge'),
  status: z.enum(['up', 'down', 'degraded', 'unknown']), observedAtMs: timestamp,
  latencyMs: z.optional(z.number().check(z.minimum(0))), reason: z.optional(z.string()),
  expectedOperationId: z.optional(id),
  source: z.strictObject({ kind: z.literal('domain'), observerMachineId: id }),
}));
export const DeploymentHealthCurrentSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), environmentId: id, targetLinkId: id,
  observation: z.nullable(DeploymentCurrentEdgeObservationV1Schema),
  domainHealth: z.optional(z.array(z.strictObject({ domainId: id, domainRevision: revision,
    facts: DeploymentDomainHealthFactsV1Schema, observations: z.array(DeploymentCurrentDomainObservationV1Schema) }))),
}).check(z.refine(value => value.observation === null || (
  value.observation.environmentId === value.environmentId && value.observation.targetLinkId === value.targetLinkId
), { message: 'The current observation belongs to the selected Environment and target link.' })));
export type DeploymentHealthCurrentInputV1 = z.infer<typeof DeploymentHealthCurrentInputV1Schema>;
export type DeploymentCurrentEdgeObservationV1 = z.infer<typeof DeploymentCurrentEdgeObservationV1Schema>;

/** No caller-owned native facts, probes, deadlines or mutation operands. */
export const DeploymentHealthReadInputV1Schema = lazyZodSchema(() => z.strictObject({ ...input, ...service })
  .check(z.refine(matchesService, serviceIdentityCheck)));
export const DeploymentDriftReadInputV1Schema = lazyZodSchema(() => z.strictObject({ ...input, ...service, expectedRevision: revision })
  .check(z.refine(matchesService, serviceIdentityCheck)));
export const DeploymentStageLogsReadInputV1Schema = lazyZodSchema(() => z.strictObject({ ...input,
  kind: z.literal('build'), ref: z.optional(id), tail: z.optional(z.literal(true)),
  cursor: z.optional(ManagedServiceNativeLogCursorV1Schema) }));
export const DeploymentLogsReadInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  DeploymentStageLogsReadInputV1Schema,
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

/** Clients bind strings using their own parameter syntax, including managed positional keys. */
export const DeploymentDataQueryStatementV1Schema = lazyZodSchema(() => z.strictObject({
  sql: z.string().check(z.minLength(1)), params: z.record(z.string(), z.string()),
}));
export type DeploymentDataQueryStatementV1 = z.infer<typeof DeploymentDataQueryStatementV1Schema>;

/** Native client variables use lowercase ASCII identifiers. Uppercase psql
 * controls and the host-owned happier_ namespace cannot be caller parameters. */
export const DeploymentNativeDataQueryParameterNameV1Schema = lazyZodSchema(() => z.string()
  .check(z.regex(/^(?!happier_)[a-z][a-z0-9_]*$/, { message: 'invalid_query_parameter' })));
export const DeploymentNativeDataQueryParamsV1Schema = lazyZodSchema(() =>
  z.record(DeploymentNativeDataQueryParameterNameV1Schema, z.string()));

/** An own-server database is a service in the exact admitted deployment, never a managed data link. */
export const DeploymentDataQueryInputV1Schema = lazyZodSchema(() => z.extend(DeploymentDataQueryStatementV1Schema, {
  params: DeploymentNativeDataQueryParamsV1Schema,
  serverId: id, environmentId: id, expectedRevision: revision, deploymentId: id,
  targetLinkId: id, machineId: id, installationId: id, service: id,
}));
export type DeploymentDataQueryInputV1 = z.infer<typeof DeploymentDataQueryInputV1Schema>;

/** One result set, shared by the native and qualified managed query Actions. */
export const DeploymentDataQuerySuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), columns: z.array(z.strictObject({ name: z.string() })),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  complete: z.boolean(), diagnostic: z.optional(z.strictObject({ code: id })),
}).check(z.refine(value => value.rows.every(row => row.length === value.columns.length), {
  message: 'Each query row retains every declared column, in order.',
})));
export type DeploymentDataQuerySuccessV1 = z.infer<typeof DeploymentDataQuerySuccessV1Schema>;
/** Setup and client support failures retain their first, secret-free cause. */
export const DeploymentDataQueryUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), error: z.enum(['deployment_unavailable', 'deployment_access_denied', 'unsupported_action']),
  diagnostic: z.strictObject({ code: id }),
}));
export type DeploymentDataQueryUnavailableV1 = z.infer<typeof DeploymentDataQueryUnavailableV1Schema>;
export const DeploymentDataQueryStatementV1ProtocolSchema = projectZodProtocolSchema(DeploymentDataQueryStatementV1Schema);
export const DeploymentDataQuerySuccessV1ProtocolSchema = projectZodProtocolSchema(DeploymentDataQuerySuccessV1Schema);
export const DeploymentDataQueryUnavailableV1ProtocolSchema = projectZodProtocolSchema(DeploymentDataQueryUnavailableV1Schema);
