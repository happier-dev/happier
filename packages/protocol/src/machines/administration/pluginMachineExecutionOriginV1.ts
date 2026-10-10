import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import {
  PluginMachineMaterializationRefV1JsonSchema,
  PluginMachineMaterializationRefV1Schema,
  type PluginMachineMaterializationRefV1,
} from '../../plugins/availability/materializationRefV1.js';
import type { PluginJsonSchemaV2 } from '../../plugins/contributions/publicTypes.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginSourceCustodyV1Schema, PluginSourceCustodyV1ProtocolSchema, pluginSourceCustodyV1Equal } from '../../plugins/runtime/sourceCustody.js';

const PluginMachineSourceRefV1Schema = lazyZodSchema(() => z.object({
  machineId: PluginMachineMaterializationRefV1Schema.shape.machineId,
  pluginId: asProtocolZod(PluginIdSchema),
  sourceCustody: PluginSourceCustodyV1Schema,
}).strict());

/**
 * Administration's Account-portable choice of one exact machine
 * materialization. Artifact owns the nested reference and validation facts;
 * Administration alone composes it with canonical server identity.
 */
export const PluginMachineMaterializationExecutionOriginV1Schema = lazyZodSchema(() => z.object({
  serverIdentityId: z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN),
  materializationRef: PluginMachineMaterializationRefV1Schema,
}).strict());
export type PluginMachineMaterializationExecutionOriginV1 = z.infer<typeof PluginMachineMaterializationExecutionOriginV1Schema>;
export const PluginMachineExecutionOriginV1Schema = lazyZodSchema(() => z.union([PluginMachineMaterializationExecutionOriginV1Schema, z.object({
  serverIdentityId: z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN),
  sourceRef: PluginMachineSourceRefV1Schema,
}).strict()]));

export type PluginMachineExecutionOriginV1 = z.infer<typeof PluginMachineExecutionOriginV1Schema>;

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
