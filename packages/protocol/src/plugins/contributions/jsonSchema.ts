/**
 * The JSON value and JSON Schema dialect are deliberately independent from
 * plugin identity and contribution declarations. Keeping this owner neutral
 * lets protocol roots use the canonical schema constructors without a module
 * initialization cycle through contribution identity.
 */
import { z } from 'zod';

/**
 * Mutable structural JSON authored into declarations and carried on wire
 * payloads, admitted by `PluginJsonValueV2Schema`. It is deliberately distinct
 * from the strict runtime value in `json/strictJsonValue.ts`: this spelling
 * describes data before strict normalization, so it stays mutable and carries
 * none of the prototype, accessor, dense-array, well-formed-Unicode, or
 * aggregate-byte guarantees that the strict normalizer enforces. Values of
 * this type may be passed where a strict runtime value is expected; a strict
 * runtime value may not be passed back the other way.
 */
export type PluginJsonValueV2 =
  | null
  | boolean
  | number
  | string
  | PluginJsonValueV2[]
  | { [key: string]: PluginJsonValueV2 };

export const PluginJsonValueV2Schema: z.ZodType<PluginJsonValueV2> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(PluginJsonValueV2Schema),
  z.record(z.string(), PluginJsonValueV2Schema),
]));

export type PluginJsonSchemaV2 = {
  $schema?: 'http://json-schema.org/draft-07/schema#';
  type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  format?: 'date-time' | 'time' | 'date' | 'duration' | 'uri' | 'uri-reference' | 'uri-template' | 'url' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'regex' | 'uuid' | 'json-pointer' | 'relative-json-pointer';
  title?: string;
  description?: string;
  default?: PluginJsonValueV2;
  enum?: PluginJsonValueV2[];
  const?: PluginJsonValueV2;
  properties?: Record<string, PluginJsonSchemaV2>;
  required?: string[];
  additionalProperties?: boolean | PluginJsonSchemaV2;
  items?: PluginJsonSchemaV2;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  'x-happier-max-utf8-bytes'?: number;
  'x-happier-max-serialized-utf8-bytes'?: number;
  pattern?: string;
  anyOf?: PluginJsonSchemaV2[];
  oneOf?: PluginJsonSchemaV2[];
  allOf?: PluginJsonSchemaV2[];
};

export const PluginJsonSchemaV2Schema: z.ZodType<PluginJsonSchemaV2> = z.lazy(() => z.object({
  $schema: z.literal('http://json-schema.org/draft-07/schema#').optional(),
  type: z.enum(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']).optional(),
  format: z.enum(['date-time', 'time', 'date', 'duration', 'uri', 'uri-reference', 'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'relative-json-pointer']).optional(),
  title: z.string().optional(), description: z.string().optional(),
  default: PluginJsonValueV2Schema.optional(), enum: z.array(PluginJsonValueV2Schema).optional(), const: PluginJsonValueV2Schema.optional(),
  properties: z.record(z.string(), PluginJsonSchemaV2Schema).optional(), required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), PluginJsonSchemaV2Schema]).optional(), items: PluginJsonSchemaV2Schema.optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  uniqueItems: z.boolean().optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(), pattern: z.string().optional(),
  'x-happier-max-utf8-bytes': z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  'x-happier-max-serialized-utf8-bytes': z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  anyOf: z.array(PluginJsonSchemaV2Schema).optional(), oneOf: z.array(PluginJsonSchemaV2Schema).optional(), allOf: z.array(PluginJsonSchemaV2Schema).optional(),
}).strict());
