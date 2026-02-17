import type { ActionInputFieldHint, ActionSpec } from './actionSpecs.js';
import { zodSchemaToJsonSchemaObject, type JsonSchemaObject } from './actionInputJsonSchema.js';

type JsonSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function startCase(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return 'Parameter';
  return raw
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function buildHintDescriptionByPath(hints: ActionSpec['inputHints'] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const fields = Array.isArray(hints?.fields) ? (hints?.fields as ActionInputFieldHint[]) : [];
  for (const field of fields) {
    const path = typeof (field as any)?.path === 'string' ? String((field as any).path).trim() : '';
    if (!path) continue;
    const desc =
      normalizeDescription((field as any).description) ??
      normalizeDescription((field as any).title) ??
      startCase(path.split('.').slice(-1)[0] ?? 'parameter');
    map.set(path, desc);
  }
  return map;
}

function pickNonNullBranch(anyOf: unknown): JsonSchema | null {
  if (!Array.isArray(anyOf)) return null;
  const branches = anyOf.filter((b) => isPlainObject(b)) as JsonSchema[];
  const nonNull = branches.filter((b) => b.type !== 'null');
  if (nonNull.length === 1) return nonNull[0]!;
  // If multiple, prefer the first non-null branch.
  return nonNull[0] ?? null;
}

function mergeEnumValues(values: unknown[]): string[] | null {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') return null;
    if (!out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : null;
}

function mergePropertySchemas(schemas: JsonSchema[]): JsonSchema {
  if (schemas.length === 0) return { type: 'string', description: 'Parameter' };
  if (schemas.length === 1) return schemas[0]!;

  const base = schemas[0]!;
  const baseType = typeof base.type === 'string' ? (base.type as string) : null;

  // Merge string enums when possible (used heavily for discriminators like `base.kind`).
  if (baseType === 'string') {
    const enums: string[] = [];
    for (const s of schemas) {
      const t = typeof s.type === 'string' ? (s.type as string) : null;
      if (t !== 'string') return base;
      if (Array.isArray(s.enum)) {
        const merged = mergeEnumValues([...enums, ...(s.enum as unknown[])]);
        if (!merged) return base;
        enums.splice(0, enums.length, ...merged);
      }
    }
    if (enums.length > 0) {
      return { ...base, enum: enums };
    }
  }

  return base;
}

function flattenOneOfObjectSchemas(options: JsonSchema[]): JsonSchema | null {
  if (options.length === 0) return null;
  const objects = options.filter((o) => isPlainObject(o) && (o.type === 'object' || isPlainObject(o.properties))) as JsonSchema[];
  if (objects.length !== options.length) return null;

  const propsByKey = new Map<string, JsonSchema[]>();
  const requiredSets: Array<Set<string>> = [];

  for (const opt of objects) {
    const props = isPlainObject(opt.properties) ? (opt.properties as Record<string, unknown>) : {};
    for (const [key, rawSchema] of Object.entries(props)) {
      if (!propsByKey.has(key)) propsByKey.set(key, []);
      propsByKey.get(key)!.push(isPlainObject(rawSchema) ? (rawSchema as JsonSchema) : {});
    }
    const required = Array.isArray(opt.required) ? (opt.required as unknown[]).filter((v) => typeof v === 'string') as string[] : [];
    requiredSets.push(new Set(required));
  }

  const requiredIntersection = (() => {
    if (requiredSets.length === 0) return [];
    const [first, ...rest] = requiredSets;
    const out: string[] = [];
    for (const key of first!) {
      if (rest.every((s) => s.has(key))) out.push(key);
    }
    return out;
  })();

  const mergedProperties: Record<string, unknown> = {};
  for (const [key, schemas] of propsByKey.entries()) {
    mergedProperties[key] = mergePropertySchemas(schemas);
  }

  return {
    type: 'object',
    properties: mergedProperties,
    ...(requiredIntersection.length > 0 ? { required: requiredIntersection } : {}),
  };
}

function sanitizeForElevenLabs(
  schemaRaw: unknown,
  path: string[],
  hintDescByPath: Map<string, string>,
  fallbackName: string,
): JsonSchema {
  const schema = isPlainObject(schemaRaw) ? ({ ...schemaRaw } as JsonSchema) : ({} as JsonSchema);

  // ElevenLabs parameter schemas are NOT full JSON Schema; strip unsupported keys.
  delete (schema as any).additionalProperties;
  delete (schema as any).$schema;
  delete (schema as any).$ref;
  delete (schema as any).definitions;

  // Collapse nullable `anyOf` unions (we represent optionality via missing `required`).
  if (Array.isArray((schema as any).anyOf)) {
    const picked = pickNonNullBranch((schema as any).anyOf);
    if (picked) {
      return sanitizeForElevenLabs(picked, path, hintDescByPath, fallbackName);
    }
    delete (schema as any).anyOf;
  }

  // ElevenLabs rejects JSON-schema `oneOf`; flatten object unions when possible.
  if (Array.isArray((schema as any).oneOf)) {
    const options = ((schema as any).oneOf as unknown[]).map((opt) => sanitizeForElevenLabs(opt, path, hintDescByPath, fallbackName));
    const flattened = flattenOneOfObjectSchemas(options);
    if (flattened) {
      return sanitizeForElevenLabs(flattened, path, hintDescByPath, fallbackName);
    }
    // Fallback: pick the first option to keep schema usable for the agent UI.
    const first = options[0];
    if (first) {
      return first;
    }
    delete (schema as any).oneOf;
  }

  const hintKey = path.join('.');
  const hintDesc = hintDescByPath.get(hintKey);
  const description = normalizeDescription(schema.description) ?? hintDesc ?? startCase(fallbackName);
  schema.description = description;

  const type = typeof schema.type === 'string' ? schema.type : null;

  if (type === 'object' || isPlainObject(schema.properties)) {
    const rawProps = isPlainObject(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
    const nextProps: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(rawProps)) {
      nextProps[key] = sanitizeForElevenLabs(child, [...path, key], hintDescByPath, key);
    }
    const required = Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter((v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(nextProps, v)) as string[]
      : [];

    return {
      type: 'object',
      description,
      properties: nextProps,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (type === 'array') {
    const items = sanitizeForElevenLabs(schema.items, [...path, '[]'], hintDescByPath, `${fallbackName} item`);
    return {
      type: 'array',
      description,
      items: { ...items, description: normalizeDescription((items as any).description) ?? startCase(`${fallbackName} item`) },
    };
  }

  // Primitive types: keep enum when present.
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'null') {
    const out: JsonSchema = { type, description };
    if (Array.isArray(schema.enum)) out.enum = schema.enum;
    return out;
  }

  // Fallback: treat unknown schemas as strings.
  const out: JsonSchema = { type: 'string', description };
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  return out;
}

/**
 * Build an ElevenLabs "client tool" parameters schema from an ActionSpec.
 *
 * ElevenLabs validates tool parameters more strictly than JSON Schema:
 * - leaf schemas must carry a description/dynamic variable/etc.
 * - `additionalProperties` is rejected
 * - unions (`oneOf`/`anyOf`) are rejected
 *
 * This helper converts the Zod input schema and then sanitizes it into an
 * ElevenLabs-compatible subset, using `inputHints` for per-field descriptions.
 */
export function actionSpecToElevenLabsClientToolParameters(spec: Pick<ActionSpec, 'title' | 'description' | 'inputSchema' | 'inputHints'>): JsonSchemaObject {
  const base = zodSchemaToJsonSchemaObject(spec.inputSchema as any) as unknown;
  const hints = buildHintDescriptionByPath(spec.inputHints);

  const rootFallback = normalizeDescription(spec.description) ?? normalizeDescription((spec as any).title) ?? 'Parameters';
  const sanitized = sanitizeForElevenLabs(base, [], hints, rootFallback);

  // Ensure root is always object-shaped (ElevenLabs expects that for client tools).
  const props = isPlainObject((sanitized as any).properties) ? (sanitized as any).properties : {};
  const required = Array.isArray((sanitized as any).required) ? (sanitized as any).required : [];
  return {
    type: 'object',
    description: normalizeDescription((sanitized as any).description) ?? rootFallback,
    properties: props,
    ...(required.length > 0 ? { required } : {}),
  } as JsonSchemaObject;
}

