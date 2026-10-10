import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { IrohEndpointDescriptorV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

export const MachineOperationProtocolVersionsV1Schema = lazyZodSchema(() => z
  .tuple([z.literal(1)])
  .readonly());

export const MachineOperationProtocolCapabilityV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersions: MachineOperationProtocolVersionsV1Schema,
  })
  .strict()
  .readonly());

const MachineOperationProtocolCapabilityThroughV2Schema = lazyZodSchema(() => z.object({
  protocolVersions: z.union([
    MachineOperationProtocolVersionsV1Schema,
    z.tuple([z.literal(1), z.literal(2)]).readonly(),
  ]),
}).strict().readonly());

/**
 * Current transport identity published by the authenticated daemon through the
 * existing complete Machine projection. The projection's server-assigned
 * revision supplies currentness; optional connection hints use the same bounded
 * descriptor validation as every other Iroh endpoint projection.
 */
export const MachineIrohEndpointCapabilityV1Schema = lazyZodSchema(() => IrohEndpointDescriptorV1Schema
  .extend({
    protocolVersions: MachineOperationProtocolVersionsV1Schema,
  })
  .strict()
  .readonly());

export const MachineOperationProtocolCapabilitiesV1Schema = lazyZodSchema(() => z
  .object({
    sessionInputAdmission: MachineOperationProtocolCapabilityThroughV2Schema.optional(),
    // Published only once the admitted host can open B witnesses and release held Pending input.
    sessionPendingResetStart: MachineOperationProtocolCapabilityV1Schema.optional(),
    sessionSpawn: MachineOperationProtocolCapabilityThroughV2Schema.optional(),
    sessionSpawnPlacementOrigin: MachineOperationProtocolCapabilityV1Schema.optional(),
    pluginWebhookClaim: MachineOperationProtocolCapabilityV1Schema.optional(),
    /** Exact parent-PAT plus installation-signed downstream request support. */
    externalActionExecutionAuthorization: MachineOperationProtocolCapabilityV1Schema.optional(),
    irohMachineEndpoint: MachineIrohEndpointCapabilityV1Schema.optional(),
    localServicePreviewNativeAccess: MachineOperationProtocolCapabilityV1Schema.optional(),
    // This declares the broker application ingress, not source/resource readiness.
    // Daemons publish it only after handler registration and Home support negotiation.
    providerBrokerIngress: MachineOperationProtocolCapabilityThroughV2Schema.optional(),
    // Bounded finite-transfer RPC ingress. A host publishes it only after those
    // handlers are installed, which is what lets a client that has no daemon
    // state at all — an ephemeral Session Runner — still be reachable for
    // attachment transfer without inferring support from liveness or version.
    finiteTransferRpc: MachineOperationProtocolCapabilityV1Schema.optional(),
    // Finite Project execution support is installed-handler-backed, independently
    // of user accepting policy and current queue capacity.
    projectFiniteExecution: MachineOperationProtocolCapabilityV1Schema.optional(),
    // Host-owned optional context composition. Wake is deliberately absent
    // until the centralized context-only producer exists.
    sessionFollow: z.object({
      contextV1: z.literal(true),
      wakeOnHumanChangeV1: z.literal(true).optional(),
    }).strict().readonly().optional(),
  })
  .strict()
  .readonly());

/** Retained Machine reads strip extras; publication and events stay strict. */
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
  .string()
  .trim()
  .min(1)
  .max(256));

/**
 * A daemon always sends its complete current projection. Persisted projections
 * replace rather than merge, so omitting a leaf explicitly withdraws it.
 */
export const MachineUpdateOperationProtocolCapabilitiesRequestV1Schema = lazyZodSchema(() => z
  .object({
    machineId: MachineOperationProtocolCapabilityMachineIdSchema.optional(),
    capabilities: MachineOperationProtocolCapabilitiesV1Schema,
  })
  .strict()
  .readonly());

export type MachineUpdateOperationProtocolCapabilitiesRequestV1 = z.infer<
  typeof MachineUpdateOperationProtocolCapabilitiesRequestV1Schema
>;

export const MachineUpdateOperationProtocolCapabilitiesResponseV1Schema = lazyZodSchema(() => z
  .discriminatedUnion('result', [
    z.object({
      v: z.literal(1),
      result: z.literal('success'),
      revision: z.number().int().positive(),
    }).strict(),
    z.object({
      v: z.literal(1),
      result: z.literal('error'),
      code: z.enum(['invalid_request', 'machine_unavailable', 'internal_error']),
    }).strict(),
  ])
  .readonly());

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
  protocolVersion: 1 | 2,
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
