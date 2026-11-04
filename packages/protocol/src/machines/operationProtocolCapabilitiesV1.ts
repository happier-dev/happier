import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { IrohEndpointDescriptorV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

export const MachineOperationProtocolVersionsV1Schema = lazyZodSchema(() => z.readonly(z
  .tuple([z.literal(1)])));

export const MachineOperationProtocolCapabilityV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
    protocolVersions: MachineOperationProtocolVersionsV1Schema,
  })));

const MachineOperationProtocolCapabilityThroughV2Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  protocolVersions: z.union([
    MachineOperationProtocolVersionsV1Schema,
    z.readonly(z.tuple([z.literal(1), z.literal(2)])),
  ]),
})));

/** Spawn V3 observes committed birth; V4 recovers asleep birth and admitted pre-Agent setup. */
export const MachineSessionSpawnProtocolCapabilityV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  protocolVersions: z.union([
    MachineOperationProtocolVersionsV1Schema,
    z.readonly(z.tuple([z.literal(1), z.literal(2)])),
    z.readonly(z.tuple([z.literal(1), z.literal(2), z.literal(3)])),
    z.readonly(z.tuple([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])),
  ]),
})));

/**
 * Current transport identity published by the authenticated daemon through the
 * existing complete Machine projection. The projection's server-assigned
 * revision supplies currentness; optional connection hints use the same bounded
 * descriptor validation as every other Iroh endpoint projection.
 */
export const MachineIrohEndpointCapabilityV1Schema = lazyZodSchema(() => z.readonly((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(IrohEndpointDescriptorV1Schema, {
    protocolVersions: MachineOperationProtocolVersionsV1Schema,
  }))));

const MachineOperationProtocolCapabilitiesV1ObjectSchema = lazyZodSchema(() => z.strictObject({
    // Installed ingress enforces the admitted requester's execution/file boundary
    // or refuses before effects. This is not native setup/effectiveness evidence.
    requesterExecutionIsolation: z.optional(MachineOperationProtocolCapabilityV1Schema),
    sessionInputAdmission: z.optional(MachineOperationProtocolCapabilityThroughV2Schema),
    sessionMessageReply: z.optional(MachineOperationProtocolCapabilityV1Schema),
    // Published only once the admitted host can open B witnesses and release held Pending input.
    sessionPendingResetStart: z.optional(MachineOperationProtocolCapabilityV1Schema),
    sessionSpawn: z.optional(MachineSessionSpawnProtocolCapabilityV1Schema),
    sessionSpawnPlacementOrigin: z.optional(MachineOperationProtocolCapabilityV1Schema),
    sessionSpawnAuthoringOrigin: z.optional(MachineOperationProtocolCapabilityV1Schema),
    pluginWebhookClaim: z.optional(MachineOperationProtocolCapabilityV1Schema),
    /** Exact parent-PAT plus installation-signed downstream request support. */
    externalActionExecutionAuthorization: z.optional(MachineOperationProtocolCapabilityV1Schema),
    irohMachineEndpoint: z.optional(MachineIrohEndpointCapabilityV1Schema),
    localServicePreviewNativeAccess: z.optional(MachineOperationProtocolCapabilityV1Schema),
    // This declares the broker application ingress, not source/resource readiness.
    // Daemons publish it only after handler registration and Home support negotiation.
    providerBrokerIngress: z.optional(MachineOperationProtocolCapabilityThroughV2Schema),
    // Bounded finite-transfer RPC ingress. A host publishes it only after those
    // handlers are installed, which is what lets a client that has no daemon
    // state at all — an ephemeral Session Runner — still be reachable for
    // attachment transfer without inferring support from liveness or version.
    finiteTransferRpc: z.optional(MachineOperationProtocolCapabilityV1Schema),
    // Finite Project execution support is installed-handler-backed, independently
    // of user accepting policy and current queue capacity.
    projectFiniteExecution: z.optional(MachineOperationProtocolCapabilityV1Schema),
    // Host-owned optional context composition. Wake is deliberately absent
    // until the centralized context-only producer exists.
    sessionFollow: z.optional(z.readonly(z.strictObject({
      contextV1: z.literal(true),
      wakeOnHumanChangeV1: z.optional(z.literal(true)),
    }))),
  }));

export const MachineOperationProtocolCapabilitiesV1Schema = defineStoredReadProjection(
  lazyZodSchema(() => z.readonly(MachineOperationProtocolCapabilitiesV1ObjectSchema)),
  () => {
    const shape = MachineOperationProtocolCapabilitiesV1ObjectSchema.shape;
    // Every optional leaf retains its own value validation. A newer or malformed
    // leaf supplies no support, without withdrawing independently valid siblings.
    const readShape = Object.fromEntries(Object.entries(shape).map(([name, schema]) => [
      name, z.catch(createStoredReadSchema(schema), undefined),
    ])) as { [K in keyof typeof shape]: z.ZodMiniCatch<(typeof shape)[K]> };
    return z.readonly(z.object(readShape));
  },
);

/** Retained reads strip extras and isolate invalid leaves; writes stay strict. */
export const MachineOperationProtocolCapabilitiesV1StoredReadSchema = createStoredReadSchema(
  MachineOperationProtocolCapabilitiesV1Schema,
);

export type MachineOperationProtocolCapabilityV1 = z.infer<
  typeof MachineOperationProtocolCapabilityV1Schema
>;
export type MachineOperationProtocolCapabilitiesV1 = z.infer<
  typeof MachineOperationProtocolCapabilitiesV1Schema
>;
export type MachineOperationProtocolCapabilityNameV1 = keyof MachineOperationProtocolCapabilitiesV1;
export type MachineIrohEndpointAuthorityV1 = Readonly<{
  endpointId: string;
  relayUrls?: readonly string[];
  directAddresses?: readonly string[];
  revision: number;
}>;

/** Fail-closed reader for endpoint facts plus their accepted projection revision. */
export function readMachineIrohEndpointAuthorityV1(input: Readonly<{
  capabilities: unknown;
  revision: unknown;
}>): MachineIrohEndpointAuthorityV1 | null {
  const capabilities = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(input.capabilities);
  if (
    !capabilities.success
    || !Number.isInteger(input.revision)
    || (input.revision as number) < 1
    || !capabilities.data.irohMachineEndpoint
  ) return null;
  return {
    endpointId: capabilities.data.irohMachineEndpoint.endpointId,
    ...(capabilities.data.irohMachineEndpoint.relayUrls
      ? { relayUrls: capabilities.data.irohMachineEndpoint.relayUrls }
      : {}),
    ...(capabilities.data.irohMachineEndpoint.directAddresses
      ? { directAddresses: capabilities.data.irohMachineEndpoint.directAddresses }
      : {}),
    revision: input.revision as number,
  };
}

/**
 * This is intentionally a narrow Machine mutation rather than a generic
 * capability registry. The authenticated socket identity remains authoritative
 * when the optional payload id is absent or disagrees.
 */
export const MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 =
  'machine-update-operation-protocol-capabilities';

const MachineOperationProtocolCapabilityMachineIdSchema = lazyZodSchema(() => z
  .string().check(z.trim(), z.minLength(1), z.maxLength(256)));

/**
 * A daemon always sends its complete current projection. Persisted projections
 * replace rather than merge, so omitting a leaf explicitly withdraws it.
 */
export const MachineUpdateOperationProtocolCapabilitiesRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
    machineId: z.optional(MachineOperationProtocolCapabilityMachineIdSchema),
    capabilities: MachineOperationProtocolCapabilitiesV1Schema,
  })));

export type MachineUpdateOperationProtocolCapabilitiesRequestV1 = z.infer<
  typeof MachineUpdateOperationProtocolCapabilitiesRequestV1Schema
>;

export const MachineUpdateOperationProtocolCapabilitiesResponseV1Schema = lazyZodSchema(() => z.readonly(z
  .discriminatedUnion('result', [
    z.strictObject({
      v: z.literal(1),
      result: z.literal('success'),
      revision: z.number().check(z.int(), z.positive()),
    }),
    z.strictObject({
      v: z.literal(1),
      result: z.literal('error'),
      code: z.enum(['invalid_request', 'machine_unavailable', 'internal_error']),
    }),
  ])));

export type MachineUpdateOperationProtocolCapabilitiesResponseV1 = z.infer<
  typeof MachineUpdateOperationProtocolCapabilitiesResponseV1Schema
>;

/**
 * Capability absence or malformed persisted data is incompatible. This is the
 * sole predicate for exact Machine-operation protocol leaves; callers must not
 * infer support from daemon version, liveness, or encrypted daemon state.
 */
export function supportsMachineOperationProtocolCapabilityV1(
  capabilities: unknown,
  capability: MachineOperationProtocolCapabilityNameV1,
): boolean {
  const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
  if (!parsed.success) return false;
  const leaf = parsed.data[capability];
  return leaf !== undefined
    && 'protocolVersions' in leaf
    && leaf.protocolVersions[0] === 1;
}

export function supportsMachineSessionSpawnProtocolVersionV1(
  capabilities: unknown,
  protocolVersion: 1 | 2 | 3 | 4,
): boolean {
  const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
  return parsed.success
    && parsed.data.sessionSpawn?.protocolVersions.some((version) => version === protocolVersion) === true;
}

/** Target input uses V2; a main-only admission leaf must never authorize it. */
export function supportsMachineSessionInputAdmissionProtocolVersion(
  capabilities: unknown,
  version: 1 | 2,
): boolean {
  const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
  if (!parsed.success) return false;
  const protocolVersions = parsed.data.sessionInputAdmission?.protocolVersions;
  return version === 1
    ? protocolVersions?.[0] === 1
    : protocolVersions?.[1] === 2;
}

/** Follow is supported only by a valid complete stored Machine projection. */
export function supportsMachineSessionFollowContextV1(capabilities: unknown): boolean {
  const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
  return parsed.success && parsed.data.sessionFollow?.contextV1 === true;
}

export function supportsMachineSessionFollowWakeOnHumanChangeV1(capabilities: unknown): boolean {
  const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
  return parsed.success
    && parsed.data.sessionFollow?.contextV1 === true
    && parsed.data.sessionFollow.wakeOnHumanChangeV1 === true;
}
