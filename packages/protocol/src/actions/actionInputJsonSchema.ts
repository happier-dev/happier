import { z } from 'zod';

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

type JsonSchema = Record<string, unknown>;

function unwrap(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean; nullable: boolean } {
  let current = schema;
  let optional = false;
  let nullable = false;

  for (;;) {
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = (current as any)._def.schema;
      continue;
    }
    break;
  }

  return { schema: current, optional, nullable };
}

function mergeNullable(base: JsonSchema, nullable: boolean): JsonSchema {
  if (!nullable) return base;
  // JSON Schema: represent nullable with a union for broad compatibility.
  return { anyOf: [base, { type: 'null' }] };
}

function schemaToJson(schema: z.ZodTypeAny): JsonSchema {
  const { schema: core, nullable } = unwrap(schema);

  const out: JsonSchema = (() => {
    if (core instanceof z.ZodObject) {
      const shape = (core as any).shape ?? ((core as any)._def?.shape ? (core as any)._def.shape() : {});
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape ?? {})) {
        const unwrapped = unwrap(value as z.ZodTypeAny);
        properties[key] = schemaToJson(unwrapped.schema);
        if (!unwrapped.optional) required.push(key);
      }

      const unknownKeys = (core as any)._def?.unknownKeys;
      const passthrough = unknownKeys === 'passthrough';

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(passthrough ? { additionalProperties: true } : {}),
      };
    }

    if (core instanceof z.ZodArray) {
      const inner = (core as any)._def?.type;
      return { type: 'array', items: inner ? schemaToJson(inner) : {} };
    }

    if (core instanceof z.ZodString) return { type: 'string' };
    if (core instanceof z.ZodNumber) return { type: 'number' };
    if (core instanceof z.ZodBoolean) return { type: 'boolean' };

    if (core instanceof z.ZodLiteral) {
      const value = (core as any)._def?.value;
      if (value === null) return { type: 'null' };
      if (typeof value === 'string') return { type: 'string', enum: [value] };
      if (typeof value === 'number') return { type: 'number', enum: [value] };
      if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
      // Fallback: represent unknown literal as an unconstrained string.
      return { type: 'string' };
    }

    if (core instanceof z.ZodEnum) {
      const values = (core as any)._def?.values;
      return { type: 'string', ...(Array.isArray(values) ? { enum: values } : {}) };
    }

    if (core instanceof z.ZodNativeEnum) {
      const values = Object.values((core as any)._def?.values ?? {}).filter((v) => typeof v === 'string');
      return { type: 'string', ...(values.length > 0 ? { enum: values } : {}) };
    }

    if (core instanceof z.ZodUnion) {
      const options = (core as any)._def?.options ?? [];
      return { oneOf: Array.isArray(options) ? options.map((s: any) => schemaToJson(s)) : [] };
    }

    if (core instanceof z.ZodDiscriminatedUnion) {
      const options = Array.from((core as any)._def?.options?.values?.() ?? []);
      return { oneOf: options.map((s: any) => schemaToJson(s)) };
    }

    // Fallback: accept any object.
    return { type: 'object', additionalProperties: true };
  })();

  return mergeNullable(out, nullable);
}

export function zodSchemaToJsonSchemaObject(schema: z.ZodTypeAny): JsonSchemaObject {
  return schemaToJson(schema) as JsonSchemaObject;
}
