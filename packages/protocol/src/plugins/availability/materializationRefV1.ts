import { z } from 'zod';

import type { PluginJsonSchemaV2 } from '../contributions/publicTypes.js';
import { PluginIdJsonSchema, PluginIdSchema } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/**
 * Cycle-free portable identity for one installed plugin materialization. It
 * intentionally excludes server identity; Administration composes that fact.
 */
export const PluginMachineMaterializationMachineIdV1Schema = z.string()
  .trim()
  .min(1)
  .max(256);
export const PluginMachineMaterializationIdV1Schema = z.string()
  .trim()
  .min(1)
  .max(256);

export const PluginMachineMaterializationRefV1Schema = z.object({
    machineId: PluginMachineMaterializationMachineIdV1Schema,
    materializationId: PluginMachineMaterializationIdV1Schema,
    pluginId: asProtocolZod(PluginIdSchema),
}).strict();
export type PluginMachineMaterializationRefV1 = z.infer<
    typeof PluginMachineMaterializationRefV1Schema
>;

/**
 * Collection schemas carry already-canonical identity values, rather than
 * applying Zod's boundary trimming while persisting an identity.
 */
const CANONICAL_NON_EMPTY_TRIMMED_STRING_PATTERN = '^\\S(?:[\\s\\S]*\\S)?$';

/**
 * Reusable public JSON-schema projection for persisted portable
 * materialization identities. Consumers compose this value instead of
 * restating its fields as unconstrained strings.
 */
export const PluginMachineMaterializationRefV1JsonSchema = {
    type: 'object',
    properties: {
        machineId: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            pattern: CANONICAL_NON_EMPTY_TRIMMED_STRING_PATTERN,
        },
        materializationId: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            pattern: CANONICAL_NON_EMPTY_TRIMMED_STRING_PATTERN,
        },
        pluginId: PluginIdJsonSchema,
    },
    required: ['machineId', 'materializationId', 'pluginId'],
    additionalProperties: false,
} satisfies PluginJsonSchemaV2;
