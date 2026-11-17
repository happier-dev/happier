/**
 * Canonical owner of the AJV-backed plugin JSON Schema compiler and of the Zod
 * object adapter built on it.
 *
 * The composable-schema DSL and JSON Schema normalization live in
 * `protocolComposableSchema.ts` and are re-exported here unchanged: this module
 * stays the published `./plugins/actions/json-schema-validation` surface, while
 * consumers that only construct or parse schemas import the DSL module directly
 * and keep AJV out of their module graph.
 */
import type { ErrorObject } from 'ajv';
import { z } from '../../zodRuntimePolicy.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

import { compileProtocolJsonSchema } from './jsonSchemaCompiler.js';
import { jsonSchemaContainsReference } from '../../actions/actionInputJsonSchema.js';

import type { PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';
import {
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  cloneStrictPluginJsonValue,
  pluginJsonValuesEqual,
  embedProtocolJsonSchema,
  type PluginJsonSchemaValidator,
  type ProtocolJsonValue,
} from './protocolComposableSchema.js';

// The composable-schema surface is re-exported name-for-name so this module's
// published subpath keeps the exact contract it had before the compiler split.
export {
  createProtocolStoredReadSchema,
  cloneStrictPluginJsonValue,
  containsEquivalentPluginJsonValue,
  defineProtocolArray,
  defineProtocolJsonValue,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUniqueArray,
  defineProtocolUtf8String,
  isValidPluginJsonSchemaValue,
  measurePluginJsonUtf8Bytes,
  measureSerializedStrictPluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
  normalizePluginJsonSchema,
  pluginJsonValuesEqual,
  ProtocolValidationError,
  rehydrateCanonicalProtocolComposableSchema,
} from './protocolComposableSchema.js';
export type {
  ProtocolStoredReadSchema,
  PluginJsonSchema,
  PluginJsonSchemaValidator,
  ProtocolArrayOptions,
  ProtocolComposableSchema,
  ProtocolJsonValue,
  ProtocolJsonValueOptions,
  ProtocolNumberOptions,
  ProtocolObjectEvolutionPolicy,
  ProtocolObjectOptions,
  ProtocolSchemaSafeParseResult,
  ProtocolStringOptions,
  ProtocolUniqueJsonArrayOptions,
  ProtocolUtf8StringOptions,
  ProtocolValidationIssue,
} from './protocolComposableSchema.js';

/**
 * The one normalized schema and executable validator prepared for a single
 * admitted schema lifetime in one JavaScript realm. The pair itself has no
 * authority semantics; the caller owns retaining and retiring the pair.
 */
export type PreparedPluginJsonSchema = Readonly<{
  jsonSchema: PluginJsonSchemaV2;
  validate: PluginJsonSchemaValidator;
}>;

/**
 * Prepares one bounded canonical projection and compiles it once. Consumers
 * retain this pair at their admitted schema/generation lifecycle. Repeated
 * preparations of the same schema identity share the canonical compiler's
 * validator; the weak identity lookup does not retain retired declarations.
 */
export function preparePluginJsonSchema(schema: object): PreparedPluginJsonSchema {
  const jsonSchema = normalizePluginJsonSchema(schema);
  return Object.freeze({
    jsonSchema,
    validate: compileProtocolJsonSchema(jsonSchema, 'draft-07'),
  });
}

export function compilePluginJsonSchema(schema: object): PluginJsonSchemaValidator {
  return preparePluginJsonSchema(schema).validate;
}

export type PluginJsonSchemaValueIssue = Readonly<{ pointer: string; message: string }>;

/** Projects the most recent AJV validation errors without exposing AJV in the public validator type. */
export function describePluginJsonSchemaValueIssues(
  validate: PluginJsonSchemaValidator,
): readonly PluginJsonSchemaValueIssue[] {
  // compilePluginJsonSchema returns an AJV callable; its error bag is an implementation boundary.
  const errors = (validate as PluginJsonSchemaValidator & { errors?: readonly ErrorObject[] | null }).errors;
  return (errors ?? []).map((error) => {
    const property = error.keyword === 'required'
      ? error.params.missingProperty
      : error.keyword === 'additionalProperties'
        ? error.params.additionalProperty
        : undefined;
    const suffix = typeof property === 'string' ? `/${property.replace(/~/g, '~0').replace(/\//g, '~1')}` : '';
    return { pointer: `${error.instancePath}${suffix}`, message: error.message ?? error.keyword };
  });
}

/**
 * Adapts the protocol-owned JSON Schema vocabulary to Zod consumers that
 * require an object schema, without making Zod a second schema-semantics owner.
 */
export function createPluginJsonSchemaZodObjectAdapter(schema: object) {
  return createPluginJsonSchemaZodAdapter(schema, z.looseObject({}), true);
}

/** Native contributions may declare any ordinary JSON root, not only an object. */
export function createPluginJsonSchemaZodValueAdapter(schema: object) {
  // AJV admits the strict JSON value at this boundary. An unknown base keeps
  // Zod's exporter representable before the canonical projection hook runs.
  return createPluginJsonSchemaZodAdapter(schema, z.unknown(), false) as z.ZodMiniType<ProtocolJsonValue>;
}

/** Whether a schema fragment carries a document-local `$ref` anywhere in its schema tree. */
function createPluginJsonSchemaZodAdapter<Schema extends z.ZodMiniType>(schema: object, root: Schema, objectRoot: boolean) {
  const prepared = preparePluginJsonSchema(schema);
  const { jsonSchema: normalized, validate } = prepared;
  const adapter = root.check(z.superRefine((value, ctx) => {
    if (!isValidPluginJsonSchemaValue(validate, value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Value does not match the plugin JSON Schema',
      });
    }
  }));

  // The pinned Zod exporter exposes a processor hook for boundary adapters.
  // Copy a fresh protocol-validated value because the exporter mutates its
  // destination while adding the selected draft marker.
  adapter._zod.processJSONSchema = (_ctx, json) => {
    Object.assign(json, normalized);
    if (objectRoot) json.type = 'object';
  };
  return defineStoredReadProjection(adapter, () => {
    const branchValidators = new WeakMap<object, PluginJsonSchemaValidator>();
    // A trial arm is a fragment of this document. Keep every local reference
    // rooted in the original document, including pointers outside $defs.
    // Only an arm that refers into the document needs that root: a
    // self-contained arm compiles alone, so a large contract (Channels'
    // channel-state is 545 KB) is not re-processed by every union trial.
    let referenceRoot: PluginJsonSchemaV2 | undefined;
    const matches = (branch: PluginJsonSchemaV2, value: unknown): boolean => {
      let validator = branchValidators.get(branch);
      if (!validator) {
        // A conflicting supplied constant cannot match this arm. Avoid
        // generating a trial validator just to reject that discriminator;
        // possible matches still use AJV. Ref siblings retain AJV ownership.
        if (branch.$ref === undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
          for (const [field, property] of Object.entries(branch.properties ?? {})) {
            if (property.$ref === undefined && Object.hasOwn(property, 'const') && Object.hasOwn(value, field)
              && !pluginJsonValuesEqual(property.const, (value as Readonly<Record<string, unknown>>)[field])) {
              return false;
            }
          }
        }
        // Both fragments are already admitted. Use the canonical compiler
        // directly rather than cloning/re-admitting the whole root per arm.
        validator = compileProtocolJsonSchema(jsonSchemaContainsReference(branch) ? {
          $defs: { storedReadRoot: referenceRoot ??= embedProtocolJsonSchema(normalized, ['$defs', 'storedReadRoot']) },
          allOf: [embedProtocolJsonSchema(branch, ['$defs', 'storedReadRoot'])],
        } : branch, 'draft-07');
        branchValidators.set(branch, validator);
      }
      return isValidPluginJsonSchemaValue(validator, value);
    };
    const reference = (pointer: string): PluginJsonSchemaV2 => {
      let node: unknown = normalized;
      for (const segment of pointer.slice(2).split('/').filter(() => pointer !== '#')) {
        if (!node || typeof node !== 'object') throw new Error('Invalid stored schema reference');
        node = Reflect.get(node, segment.replace(/~1/g, '/').replace(/~0/g, '~'));
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid stored schema reference');
      return node as PluginJsonSchemaV2;
    };
    // Projection changes only unknown-field handling. Every projected value
    // is re-admitted by the original portable compiler, including refinements.
    const project = (definition: PluginJsonSchemaV2, value: unknown, retainUnionFields = false): unknown => {
      const members: PluginJsonSchemaV2[] = [];
      const visited = new Set<PluginJsonSchemaV2>();
      let unmatchedUnion = false;
      const collect = (node: PluginJsonSchemaV2): void => {
        if (visited.has(node)) return;
        visited.add(node);
        members.push(node);
        if (node.$ref) collect(reference(node.$ref));
        node.allOf?.forEach(collect);
        for (const choices of [node.anyOf, node.oneOf]) {
          if (!choices) continue;
          if (retainUnionFields) {
            choices.forEach(collect);
            continue;
          }
          // Reuse this projection to identify fields declared by any arm,
          // including nested fields. Tolerating retired extras must never
          // erase a known field to synthesize a different valid identity.
          const unionFields = { allOf: choices };
          const known = project(unionFields, value, true);
          const preservesKnownFields = (choice: PluginJsonSchemaV2): boolean => {
            const candidate = project(choice, value);
            return matches(choice, candidate)
              && pluginJsonValuesEqual(known, project(unionFields, candidate, true));
          };
          // Prefer an already-valid arm, provided its read projection also
          // preserves the union's known fields (open arms can otherwise lose
          // fields declared by a neighboring arm).
          const branch = choices.find((choice) => matches(choice, value) && preservesKnownFields(choice))
            ?? choices.find(preservesKnownFields);
          if (branch) collect(branch);
          else unmatchedUnion = true;
        }
      };
      collect(definition);
      // Preserve the failed subtree for strict re-admission. Projecting only
      // shared root properties could otherwise synthesize a valid empty arm.
      if (unmatchedUnion) return value;
      if (Array.isArray(value)) {
        return value.map((item, index) => {
          const schemas = members.flatMap((member) => {
            const child = Array.isArray(member.items)
              ? member.items[index] ?? (typeof member.additionalItems === 'object' ? member.additionalItems : undefined)
              : member.items;
            return child ? [child] : [];
          });
          return schemas.length ? project({ allOf: schemas }, item, retainUnionFields) : item;
        });
      }
      if (!value || typeof value !== 'object') return value;
      const objectMembers = members.filter((member) => member.type === 'object' || member.properties);
      if (!objectMembers.length) return value;
      // A propertyless open object declares arbitrary JSON map data. It is not
      // a typed object whose undeclared fields should be discarded.
      if (objectMembers.every((member) => Object.keys(member.properties ?? {}).length === 0
        && (member.additionalProperties === undefined || member.additionalProperties === true))) return value;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const declared = objectMembers.flatMap((member) => member.properties?.[key] ? [member.properties[key]!] : []);
        const catchalls = objectMembers.flatMap((member) => typeof member.additionalProperties === 'object' ? [member.additionalProperties] : []);
        const definitions = declared.length ? declared : catchalls;
        if (definitions.length) Object.defineProperty(output, key, {
          value: project({ allOf: definitions }, child, retainUnionFields), enumerable: true, configurable: true, writable: true,
        });
      }
      return output;
    };
    return z.pipe(z.unknown(), z.transform((value, context) => {
      let projected: unknown;
      try { projected = project(normalized, cloneStrictPluginJsonValue(value, 'stored value')); }
      catch { context.issues.push({ code: 'custom', message: 'Stored value is not valid JSON', input: context.value }); return z.NEVER; }
      const parsed = adapter.safeParse(projected);
      if (!parsed.success) { context.issues.push({ code: 'custom', message: 'Stored value does not match the declared plugin JSON Schema', input: context.value }); return z.NEVER; }
      return parsed.data;
    }));
  });
}
