import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import {
  PluginMachineMaterializationRefV1JsonSchema,
  PluginMachineMaterializationRefV1Schema,
  type PluginMachineMaterializationRefV1,
} from '../../plugins/availability/materializationRefV1.js';
import type { PluginJsonSchemaV2 } from '../../plugins/contributions/publicTypes.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolObject, defineProtocolString } from '../../plugins/actions/protocolComposableSchema.js';
import { PluginSourceCustodyV1Schema, PluginSourceCustodyV1ProtocolSchema, pluginSourceCustodyV1Equal } from '../../plugins/runtime/sourceCustody.js';

const PluginMachineSourceRefV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: PluginMachineMaterializationRefV1Schema.shape.machineId,
  pluginId: asProtocolZod(PluginIdSchema),
  sourceCustody: PluginSourceCustodyV1Schema,
}));

/**
 * Administration's Account-portable choice of one exact machine
 * materialization. Artifact owns the nested reference and validation facts;
 * Administration alone composes it with canonical server identity.
 */
export const PluginMachineMaterializationExecutionOriginV1Schema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)),
  materializationRef: PluginMachineMaterializationRefV1Schema,
}));
export type PluginMachineMaterializationExecutionOriginV1 = z.infer<typeof PluginMachineMaterializationExecutionOriginV1Schema>;
export const PluginMachineExecutionOriginV1Schema = lazyZodSchema(() => z.union([PluginMachineMaterializationExecutionOriginV1Schema, z.strictObject({
  serverIdentityId: z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)),
  sourceRef: PluginMachineSourceRefV1Schema,
})]));

export type PluginMachineExecutionOriginV1 = z.infer<typeof PluginMachineExecutionOriginV1Schema>;

/** Placement follows the currently admitted implementation, independently of source custody. */
export const PluginMachineExecutionRoutingV1Schema = defineProtocolObject({
  serverIdentityId: defineProtocolString({ pattern: SERVER_IDENTITY_ID_PATTERN.source }),
  machineId: defineProtocolString(PluginMachineMaterializationRefV1JsonSchema.properties.machineId),
  pluginId: PluginIdSchema,
}, { policy: 'closed' });
export type PluginMachineExecutionRoutingV1 = ReturnType<typeof PluginMachineExecutionRoutingV1Schema.parse>;

export function getPluginMachineExecutionRouting(
  origin: PluginMachineExecutionOriginV1,
): PluginMachineExecutionRoutingV1 {
  const ref = getPluginMachineExecutionOriginRef(origin);
  return { serverIdentityId: origin.serverIdentityId, machineId: ref.machineId, pluginId: ref.pluginId };
}

export function arePluginMachineExecutionRoutingsEqual(
  left: PluginMachineExecutionRoutingV1,
  right: PluginMachineExecutionRoutingV1,
): boolean {
  return left.serverIdentityId === right.serverIdentityId
    && left.machineId === right.machineId
    && left.pluginId === right.pluginId;
}

export const PluginMachineExecutionRoutingV1JsonSchema: PluginJsonSchemaV2 = /* @__PURE__ */ (() => PluginMachineExecutionRoutingV1Schema.jsonSchema)();

export function getPluginMachineExecutionOriginRef(
  origin: PluginMachineExecutionOriginV1,
): PluginMachineMaterializationRefV1 | Extract<PluginMachineExecutionOriginV1, { sourceRef: unknown }>['sourceRef'] {
  return 'materializationRef' in origin ? origin.materializationRef : origin.sourceRef;
}

/** Exact identity comparison for one host-stamped plugin materialization. */
export function arePluginMachineMaterializationRefsEqual(
  left: PluginMachineMaterializationRefV1,
  right: PluginMachineMaterializationRefV1,
): boolean {
  return left.pluginId === right.pluginId
    && left.machineId === right.machineId
    && left.materializationId === right.materializationId;
}

/**
 * Exact identity comparison for a host-stamped plugin execution origin.
 * Callers use this only as an equality precondition/currentness check; it
 * never resolves, selects, or discloses a replacement origin.
 */
export function arePluginMachineExecutionOriginsEqual(
  left: PluginMachineExecutionOriginV1,
  right: PluginMachineExecutionOriginV1,
): boolean {
  if (left.serverIdentityId !== right.serverIdentityId) return false;
  if ('materializationRef' in left && 'materializationRef' in right) {
    return arePluginMachineMaterializationRefsEqual(left.materializationRef, right.materializationRef);
  }
  return 'sourceRef' in left && 'sourceRef' in right
    && left.sourceRef.machineId === right.sourceRef.machineId
    && left.sourceRef.pluginId === right.sourceRef.pluginId
    && pluginSourceCustodyV1Equal(left.sourceRef.sourceCustody, right.sourceRef.sourceCustody);
}

/**
 * Reusable public JSON-schema projection for the canonical persisted
 * execution origin. Collection declarations must compose this fragment rather
 * than restating a parallel, looser identity shape.
 */
export const PluginMachineExecutionOriginV1JsonSchema: PluginJsonSchemaV2 = {
  anyOf: [{
  type: 'object',
  properties: {
    serverIdentityId: {
      type: 'string',
      minLength: 5,
      maxLength: 64,
      pattern: SERVER_IDENTITY_ID_PATTERN.source,
    },
    materializationRef: PluginMachineMaterializationRefV1JsonSchema,
  },
  required: ['serverIdentityId', 'materializationRef'],
  additionalProperties: false,
  }, {
    type: 'object',
    properties: {
      serverIdentityId: { type: 'string', pattern: SERVER_IDENTITY_ID_PATTERN.source },
      sourceRef: {
        type: 'object',
        properties: {
          machineId: PluginMachineMaterializationRefV1JsonSchema.properties.machineId,
          pluginId: PluginMachineMaterializationRefV1JsonSchema.properties.pluginId,
          sourceCustody: PluginSourceCustodyV1ProtocolSchema.jsonSchema,
        },
        required: ['machineId', 'pluginId', 'sourceCustody'],
        additionalProperties: false,
      },
    },
    required: ['serverIdentityId', 'sourceRef'],
    additionalProperties: false,
  }],
};

/** Domain owners supply identity/content; only admitted current supplies can disagree. */
export function resolveFleetSupplyAgreement<T>(params: Readonly<{
    supplies: readonly Readonly<{ value: T; selectable: boolean }>[];
    identity: (value: T) => string;
}> & (Readonly<{ content: (value: T) => string; sameContent?: never }>
    | Readonly<{ sameContent: (left: T, right: T) => boolean; content?: never }>)): Readonly<{
    variantsByIdentity: ReadonlyMap<string, ReadonlyMap<string, T>>;
    conflictingIdentities: readonly string[];
}> {
    const variantsByIdentity = new Map<string, Map<string, T>>();
    for (const supply of params.supplies) {
        if (!supply.selectable) continue;
        const identity = params.identity(supply.value);
        const variants = variantsByIdentity.get(identity) ?? new Map<string, T>();
        const sameContent = params.sameContent;
        if (sameContent) {
            // Semantic groups have opaque, publication-local keys, not content identities.
            if (![...variants.values()].some(value => sameContent(value, supply.value))) {
                variants.set(String(variants.size), supply.value);
            }
        } else {
            const content = params.content(supply.value);
            if (!variants.has(content)) variants.set(content, supply.value);
        }
        variantsByIdentity.set(identity, variants);
    }
    return {
        variantsByIdentity,
        conflictingIdentities: [...variantsByIdentity].filter(([, variants]) => variants.size > 1).map(([identity]) => identity),
    };
}

/** Byte supply uses content agreement, never permission to execute a plugin on another Machine. */
export function resolvePluginContentSuppliesV1<T>(params: Readonly<{
  supplies: readonly Readonly<{
    value: T;
    origin: PluginMachineExecutionOriginV1 | null;
    version: string;
    contentKey: string;
    available: boolean;
  }>[];
  selectedOrigin?: PluginMachineExecutionOriginV1 | null;
}>): Readonly<{ kind: 'ready'; supplies: readonly T[] }> | Readonly<{ kind: 'conflict' | 'unavailable' }> {
  const selected = params.selectedOrigin;
  const candidates = selected ? params.supplies.filter(supply => supply.origin && arePluginMachineExecutionOriginsEqual(supply.origin, selected))
    : params.supplies;
  const available = candidates.filter(supply => supply.available);
  if (!available.length) return { kind: 'unavailable' };
  const agreement = resolveFleetSupplyAgreement({ supplies: available.map(value => ({ value, selectable: true })),
    identity: () => 'pluginContent', content: supply => JSON.stringify([supply.version, supply.contentKey]) });
  return agreement.conflictingIdentities.length ? { kind: 'conflict' }
    : { kind: 'ready', supplies: available.map(supply => supply.value) };
}
