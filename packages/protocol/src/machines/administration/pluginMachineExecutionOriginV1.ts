import { z } from 'zod';

import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import {
  PluginMachineMaterializationRefV1JsonSchema,
  PluginMachineMaterializationRefV1Schema,
} from '../../plugins/availability/materializationRefV1.js';
import type { PluginJsonSchemaV2 } from '../../plugins/contributions/publicTypes.js';

/**
 * Administration's Account-portable choice of one exact machine
 * materialization. Artifact owns the nested reference and validation facts;
 * Administration alone composes it with canonical server identity.
 */
export const PluginMachineExecutionOriginV1Schema = z.object({
  serverIdentityId: z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN),
  materializationRef: PluginMachineMaterializationRefV1Schema,
}).strict();

export type PluginMachineExecutionOriginV1 = z.infer<typeof PluginMachineExecutionOriginV1Schema>;

/**
 * Exact identity comparison for a host-stamped plugin execution origin.
 * Callers use this only as an equality precondition/currentness check; it
 * never resolves, selects, or discloses a replacement origin.
 */
export function arePluginMachineExecutionOriginsEqual(
  left: PluginMachineExecutionOriginV1,
  right: PluginMachineExecutionOriginV1,
): boolean {
  return left.serverIdentityId === right.serverIdentityId
    && left.materializationRef.pluginId === right.materializationRef.pluginId
    && left.materializationRef.machineId === right.materializationRef.machineId
    && left.materializationRef.materializationId === right.materializationRef.materializationId;
}

/**
 * Reusable public JSON-schema projection for the canonical persisted
 * execution origin. Collection declarations must compose this fragment rather
 * than restating a parallel, looser identity shape.
 */
export const PluginMachineExecutionOriginV1JsonSchema = {
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
} satisfies PluginJsonSchemaV2;
