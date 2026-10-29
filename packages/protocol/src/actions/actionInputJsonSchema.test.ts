import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv from 'ajv';
import { z } from 'zod/mini';
import * as m from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationDefinitionCreateRequestSchema } from '../automations/automationApiV3.js';
import { getActionSpec, listActionSpecs, PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';
import { actionSpecToActionDefinitionV1 } from './actionCatalog.js';
import { createActionExecutor } from './actionExecutor.js';
import { RawIngressStructuredInputV1Schema } from '../runtime/input/structuredInputV1.js';
import { compileActionInputJsonSchema, supportsSessionMessageInputJsonSchema } from './actionInputJsonSchemaValidation.js';
import { compilePluginJsonSchema, createPluginJsonSchemaZodObjectAdapter } from '../plugins/actions/jsonSchemaValidation.js';

import {
  ActionJsonSchemaProjectionError,
  forEachJsonSchemaChild,
  type JsonSchemaObject,
  zodSchemaToJsonSchemaObject,
} from './actionInputJsonSchema.js';

describe('actionInputJsonSchema', () => {
  it('normalizes readonly annotations in embedded native schema fragments', () => {
    const native = z.strictObject({ entries: z.readonly(z.array(z.string().check(z.minLength(1)))) });
    const { $schema: _dialect, ...fragment } = z.toJSONSchema(native, { target: 'draft-7', io: 'input' });
    const parent = z.strictObject({ value: z.unknown().check(z.meta(fragment)) });
    const validate = compilePluginJsonSchema(zodSchemaToJsonSchemaObject(parent, { target: 'draft-7' }));
    expect(validate({ value: { entries: ['kept'] } })).toBe(true);
    expect(validate({ value: { entries: [''] } })).toBe(false);
    expect(validate({ value: { entries: [7] } })).toBe(false);
  });

  it.each(['draft-7', 'draft-2020-12'] as const)('projects native readonly wrappers as portable parser constraints on %s', target => {
    const literal = { readOnly: 'literal data', entries: [{ name: 'kept' }] };
    const schema = z.readonly(z.strictObject({
      readOnly: z.string(),
      entries: z.readonly(z.array(z.readonly(z.strictObject({
        name: z.string().check(z.minLength(1)),
      }))).check(z.minLength(1))),
    })).check(z.meta({ default: literal }));
    const projected = zodSchemaToJsonSchemaObject(schema, { target });
    expect(projected).not.toHaveProperty('readOnly');
    expect(projected.default).toEqual(literal);
    expect(projected.properties).toHaveProperty('readOnly', { type: 'string' });
    const validate = target === 'draft-7'
      ? compilePluginJsonSchema(projected)
      : compileActionInputJsonSchema(projected);
    expect(validate(literal)).toBe(true);
    for (const invalid of [
      { ...literal, entries: [] },
      { ...literal, entries: [{ name: '' }] },
      { ...literal, entries: [{ name: 'kept', extra: true }] },
      { ...literal, readOnly: false },
    ]) {
      expect(schema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
      expect(validate(invalid), JSON.stringify(invalid)).toBe(false);
    }
    expect(Object.isFrozen(schema.parse(literal).entries)).toBe(true);
  });

  it.each(['agent', 'ui', 'cli'] as const)('publishes the Session configuration accepted by the start owner on %s', async surface => {
    const executor = createActionExecutor({});
    const input = {
      executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'agent' } },
      permissionMode: 'read-only',
      configuration: {
        mode: { value: null, updatedAtMs: 1 },
        model: { value: 'model', updatedAtMs: 2 },
        permissionIntent: { value: 'read-only', updatedAtMs: 3 },
        options: { reasoning_effort: { value: 'low', updatedAtMs: 4 } },
      },
    };
    const invalidConfigurations = [
      {},
      { reasoning_effort: 'low' },
      { ...input.configuration, model: { value: { value: 'model', label: 'Model' }, updatedAtMs: 2 } },
      { ...input.configuration, permissionIntent: { value: 'read_only', updatedAtMs: 3 } },
      { ...input.configuration, options: { v: 1, updatedAt: 4, overrides: {} } },
    ];
    const read = async (schemaPath?: string) => {
      const result = await executor.execute('action.spec.get', { id: 'session.spawn_new',
        ...(schemaPath ? { schemaPath } : {}) }, { surface });
      if (!result.ok) throw new Error(result.errorCode);
      return PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(result.result);
    };
    const root = (await read()).actionSpec.inputSchema;
    const configurationSchema = (root.properties as Record<string, JsonSchemaObject>).configuration!;
    // Read the configuration's actual referenced sections, without pulling unrelated
    // trigger/workflow grammars into this configuration contract test.
    const definitions: Record<string, unknown> = { ...(root.definitions as Record<string, unknown> ?? {}) };
    const pending: unknown[] = [configurationSchema];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const schema = node as JsonSchemaObject;
      if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/definitions/')) {
        const name = schema.$ref.slice('#/definitions/'.length);
        if (!(name in definitions)) {
          const section = (await read(`/inputSchema/definitions/${name}`)).schemaSection;
          if (!section) throw new Error('Missing configuration section');
          definitions[name] = section.schema;
          pending.push(section.schema);
        }
      }
      forEachJsonSchemaChild(schema, child => pending.push(child));
    }
    const validate = new Ajv({ strict: false, validateFormats: false }).compile({
      ...configurationSchema, definitions,
    });
    expect(validate(input.configuration), surface).toBe(true);
    expect(getActionSpec('session.spawn_new').inputSchema.safeParse(input).success).toBe(true);
    for (const configuration of invalidConfigurations) {
      const invalid = { ...input, configuration };
      expect(getActionSpec('session.spawn_new').inputSchema.safeParse(invalid).success).toBe(false);
      expect(validate(configuration), `${surface}: ${JSON.stringify(configuration)}`).toBe(false);
    }
  });

  it('requires declared remote support for each supplied nonnullable structured Session member', () => {
    const fields = {
      reviewComments: { sessionId: 'source', comments: [] },
      composerAttachments: [],
      browserContext: {
        contexts: [{ v: 1, kind: 'browserPageReference', contextId: 'context', sourceViewId: 'view',
          sourceAdapterKind: 'chromiumSidecar', fidelity: 'cdp', capturedAtMs: 1, navigationGeneration: 1,
          lifecycleState: 'available', redactionLevel: 'metadataOnly' }],
        attachments: [{ v: 1, attachmentId: 'attachment', contextId: 'context', sourceViewId: 'view',
          capturedNavigationGeneration: 1, currentNavigationGeneration: 1, state: 'available' }],
      },
      imageInputs: [], mentions: [], vendorPluginMentions: [], skillMentions: [],
      discussionSelectionSourceV1: { kind: 'discussion', serverId: 'home', discussionId: 'discussion', messageIds: ['message'] },
      sessionAttachments: [],
    };
    const current = actionSpecToActionDefinitionV1(getActionSpec('session.message.send')).inputSchema;
    const object = (value: unknown): value is Record<string, unknown> => value !== null
      && typeof value === 'object' && !Array.isArray(value);
    for (const [field, value] of Object.entries(fields)) {
      const structuredInput = RawIngressStructuredInputV1Schema.parse({ v: 1, [field]: value });
      expect(RawIngressStructuredInputV1Schema.safeParse({ v: 1, [field]: null }).success, field).toBe(false);
      const input = { sessionId: 'target', message: 'Inspect the selected context.', structuredInput };
      const predecessor = structuredClone(current);
      let removed = 0;
      const omitMember = (node: unknown): void => {
        if (!object(node)) return;
        if (object(node.properties) && 'composerAttachments' in node.properties && 'browserContext' in node.properties) {
          expect(node.properties).toHaveProperty(field);
          delete node.properties[field];
          // The predecessor still parses the structured envelope, but does not
          // understand this newer member in its existing additive object.
          node.additionalProperties = true;
          removed++;
        }
        forEachJsonSchemaChild(node, omitMember);
      };
      omitMember(predecessor);
      expect(removed, field).toBe(1);
      const validatePredecessor = compileActionInputJsonSchema(predecessor);
      expect(validatePredecessor(input), field).toBe(true);
      expect(validatePredecessor({ ...input, structuredInput: { ...structuredInput, [field]: null } }), field).toBe(true);
      expect(supportsSessionMessageInputJsonSchema(predecessor, input), field).toBe(false);
      expect(supportsSessionMessageInputJsonSchema(current, input), field).toBe(true);
    }
    // The additive envelope still accepts unknown, ignorable extension values;
    // this is not a requirement that every nested member reject null.
    expect(supportsSessionMessageInputJsonSchema(current, { sessionId: 'target', message: 'Plain message.',
      structuredInput: { v: 1, futureContext: null } })).toBe(true);
  });

  it.each([
    { field: 'modelOverride', value: 'model-1', schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    { field: 'providerConnectionId', value: 'connection-1', schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    { field: 'attachments', value: [], schema: { type: 'array' } },
    { field: 'source', value: {}, schema: { type: 'object' } },
    { field: 'idempotencyKey', value: 'request-1', schema: { type: 'string', minLength: 1 } },
  ])('requires declared remote support for supplied Session operand $field', ({ field, value, schema }) => {
    // Remote boundary projections deliberately differ only in whether the
    // authored operand is parsed or silently accepted as an unknown property.
    const base = { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: true };
    const input = { message: 'Inspect it.', [field]: value };
    expect(supportsSessionMessageInputJsonSchema(base, input)).toBe(false);
    expect(supportsSessionMessageInputJsonSchema({ ...base, properties: { ...base.properties, [field]: schema } }, input)).toBe(true);
  });

  it('preserves nullable input contracts through strict Plugin admission', () => {
    const schema = z.strictObject({ label: z.nullable(z.string()), count: z.nullable(z.number()) });
    const validate = compilePluginJsonSchema(zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' }));
    expect(validate({ label: null, count: 2 })).toBe(true);
    expect(validate({ label: 'kept', count: null })).toBe(true);
    expect(validate({ label: 42, count: null })).toBe(false);
    expect(validate({ label: null, count: 'invalid' })).toBe(false);
  });

  it('preserves conjunctive constraints and literal JSON while projecting type unions', () => {
    const literal = { type: ['number', 'null'], format: 'starts_with' };
    const schema = z.unknown().check(z.meta({
      type: ['string', 'null'],
      anyOf: [{ type: 'string', pattern: '^k' }, { type: 'null' }],
      allOf: [{ not: { const: 'knot' } }],
      default: literal,
      examples: [literal],
      $defs: { literal: { enum: [literal] } },
    }));
    const projected = zodSchemaToJsonSchemaObject(schema);
    const validate = compileActionInputJsonSchema(projected);
    expect(validate('kept')).toBe(true);
    expect(validate(null)).toBe(true);
    for (const invalid of ['else', 'knot', 42]) expect(validate(invalid)).toBe(false);
    expect(projected.default).toEqual(literal);
    expect(projected.examples).toEqual([literal]);
    expect(projected.$defs).toEqual({ literal: { enum: [literal] } });
    // Plugin admission remains deliberately narrower than standard JSON Schema.
    const { $schema: _dialect, examples: _examples, ...pluginSchema } = projected;
    const validatePlugin = compilePluginJsonSchema(pluginSchema);
    expect(validatePlugin('kept')).toBe(true);
    for (const invalid of ['else', 'knot', 42]) expect(validatePlugin(invalid)).toBe(false);
  });

  it('compacts repeated Action schemas without weakening their advertised inputs', () => {
    const target = z.strictObject({ kind: z.literal('workspace'), path: z.string().check(z.minLength(1)) });
    const schema = z.strictObject({ source: target, destination: target,
      archives: z.optional(z.array(target)), alternatives: z.optional(z.array(target)),
    });
    const inline = zodSchemaToJsonSchemaObject(schema);
    const compact = zodSchemaToJsonSchemaObject(schema, { reused: 'ref' });
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(inline).length);
    const advertised = new Ajv2020({ strict: false }).compile(compact);
    expect(advertised({ source: { kind: 'workspace', path: '/a' }, destination: { kind: 'workspace', path: '/b' } })).toBe(true);
    expect(advertised({ source: { kind: 'workspace', path: '' }, destination: { kind: 'workspace', path: '/b' } })).toBe(false);
    expect(advertised({ source: { kind: 'workspace', path: '/a' }, destination: { kind: 'project', path: '/b' } })).toBe(false);
    expect(advertised({ source: { kind: 'workspace', path: '/a', secret: true }, destination: { kind: 'workspace', path: '/b' } })).toBe(false);
  });
  it('projects the MCP input and output for every advertised Action from the real registry', () => {
    for (const spec of listActionSpecs().filter(spec => spec.surfaces.mcp)) {
      // MCP eagerly registers every advertised input; a missing export must
      // fail this census rather than being skipped and aborting initialize.
      expect(spec.inputSchema, spec.id).toBeDefined();
      for (const [kind, schema] of Object.entries({ input: spec.inputSchema, agentInput: spec.agentInputSchema, output: spec.outputSchema })) {
        if (!schema) continue;
        try {
          const projected = zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' });
          expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
        } catch (error) {
          throw new Error(`Action ${spec.id} ${kind} schema projection failed`, { cause: error });
        }
      }
    }
  });

  it('projects genuine Mini lazy children without losing their input constraints', () => {
    const schema = z.strictObject({
      name: m.lazy(() => m.string().check(m.minLength(2))),
    });
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(zodSchemaToJsonSchemaObject(schema, { target })).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 2 } },
      });
    }
  });

  it('validates its published recursive dialect while keeping Plugin admission draft-07-only', () => {
    const item = z.strictObject({ name: z.string().check(z.minLength(1)) });
    const input = z.strictObject({ first: item, second: item, tuple: z.tuple([z.string(), z.number()]) });
    const published = zodSchemaToJsonSchemaObject(input);
    const validate = compileActionInputJsonSchema(published);
    expect(validate({ first: { name: 'one' }, second: { name: 'two' }, tuple: ['text', 1] })).toBe(true);
    expect(validate({ first: { name: '' }, second: { name: 'two' }, tuple: ['text', 1] })).toBe(false);
    expect(validate({ first: { name: 'one' }, second: { name: 'two' }, tuple: [1, 'text'] })).toBe(false);
    expect(() => compilePluginJsonSchema(published)).toThrow();
  });

  it('refuses non-local references in unused published Action definitions without interpreting literal JSON as schema', () => {
    for (const $ref of ['https://example.test/schema.json', 'other.json#/node', '#anchor']) {
      expect(() => compileActionInputJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string', $defs: { unused: { $ref } },
      })).toThrow();
    }
    const validate = compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      const: { $ref: 'https://example.test/literal' },
    });
    expect(validate({ $ref: 'https://example.test/literal' })).toBe(true);
    expect(() => compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string', $async: true,
    })).toThrow();
  });

  it('retains Protocol strict JSON equality and UTF8 semantics in the published Action dialect', () => {
    const native = createPluginJsonSchemaZodObjectAdapter({
      type: 'object', properties: {
        text: { type: 'string', 'x-happier-max-utf8-bytes': 4 },
        values: { type: 'array', uniqueItems: true, items: { enum: [{ a: 1, b: 2 }] } },
      }, required: ['text', 'values'], additionalProperties: false,
    });
    const validate = compileActionInputJsonSchema(zodSchemaToJsonSchemaObject(native));
    expect(validate({ text: 'éé', values: [{ b: 2, a: 1 }] })).toBe(true);
    expect(validate({ text: 'ééé', values: [{ a: 1, b: 2 }] })).toBe(false);
    expect(validate({ text: 'éé', values: [{ a: 1, b: 2 }, { b: 2, a: 1 }] })).toBe(false);
    expect(() => compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string', 'x-happier-unbounded-bytes': 4,
    })).toThrow();
  });
  it('preserves the canonical JSON Schema constraints and descriptions that Action inputs advertise', () => {
    const schema = z.strictObject({
      name: z.string().check(z.minLength(2), z.maxLength(12), z.regex(/^[a-z]+$/), z.describe('Lowercase action name')),
      retries: z.number().check(z.minimum(1), z.maximum(5), z.describe('Retry limit')),
      tags: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(3), z.describe('Action tags')),
      mode: z.enum(['safe', 'fast']).check(z.describe('Execution mode')),
      target: z.union([z.literal('workspace'), z.literal('project')]).check(z.describe('Execution target')),
    }).check(z.describe('Agent action input'));

    const json = zodSchemaToJsonSchemaObject(schema);

    expect(json).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      description: 'Agent action input',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 2,
          maxLength: 12,
          pattern: '^[a-z]+$',
          description: 'Lowercase action name',
        },
        retries: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Retry limit',
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description: 'Action tags',
          items: { type: 'string', minLength: 1 },
        },
        mode: {
          type: 'string',
          enum: ['safe', 'fast'],
          description: 'Execution mode',
        },
        target: {
          anyOf: [
            { type: 'string', const: 'workspace' },
            { type: 'string', const: 'project' },
          ],
          description: 'Execution target',
        },
      },
    });
    expect(json).toEqual(z.toJSONSchema(schema, {
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    }));
  });

  it('projects the same Action contract to draft-07 for consumers that require that dialect', () => {
    const json = zodSchemaToJsonSchemaObject(
      z.strictObject({ value: z.string().check(z.trim(), z.minLength(1)) }),
      { target: 'draft-7' },
    );

    expect(json).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    });
  });

  it('uses the canonical open-object projection for passthrough schemas', () => {
    const json = zodSchemaToJsonSchemaObject(z.looseObject({ value: z.string() }));

    expect(json).toMatchObject({ type: 'object' });
    expect(json.additionalProperties).toEqual({});
  });

  it('does not leak Zod standard-schema metadata into the JSON boundary', () => {
    const json = zodSchemaToJsonSchemaObject(z.strictObject({ value: z.string() }));

    expect(Object.getOwnPropertyDescriptor(json, '~standard')).toBeUndefined();
  });

  it('rejects Zod constructs that cannot be represented by an Action JSON Schema', () => {
    let projectionError: unknown;
    try {
      zodSchemaToJsonSchemaObject(z.date());
    } catch (error) {
      projectionError = error;
    }

    expect(projectionError).toBeInstanceOf(ActionJsonSchemaProjectionError);
    expect(projectionError).toMatchObject({
      name: 'ActionJsonSchemaProjectionError',
      code: 'action_schema_unrepresentable',
    });
  });

  it('converts a zod object schema into a JSON schema object (no refs)', () => {
    const schema = z.looseObject({
        sessionId: z.optional(z.string().check(z.minLength(1))),
        message: z.string().check(z.minLength(1)),
        flags: z.optional(z.array(z.string().check(z.minLength(1)))),
      });

    const json = zodSchemaToJsonSchemaObject(schema);

    expect(json).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        sessionId: expect.any(Object),
        message: expect.any(Object),
      }),
    });
    expect((json as any).$ref).toBeUndefined();
    expect((json as any).definitions).toBeUndefined();
  });

  it('converts string literal unions through the canonical JSON Schema union', () => {
    const schema = z.object({
      kind: z.union([z.literal('none'), z.literal('branch')]),
    });

    const json = zodSchemaToJsonSchemaObject(schema);
    const kindSchema = (json as any)?.properties?.kind;

    // The Zod projection represents literal branches as JSON Schema constants.
    expect(kindSchema).toMatchObject({
      anyOf: expect.any(Array),
    });
    expect(kindSchema.anyOf?.[0]).toMatchObject({ type: 'string' });
    expect(JSON.stringify(kindSchema)).toContain('none');
    expect(JSON.stringify(kindSchema)).toContain('branch');
  });
});

it('projects lazy Mini roots and children without weakening typed refusals', () => {
 const wrapped = lazyZodSchema(() => z.strictObject({ name: m.string().check(m.trim(),m.minLength(1)), count: m._default(m.number().check(m.int()),3) }));
 const concrete = z.strictObject({ name: z.string().check(z.trim(), z.minLength(1)), count: z._default(z.number().check(z.int()), 3) });
 for(const target of ['draft-7','draft-2020-12'] as const) {
  expect(zodSchemaToJsonSchemaObject(wrapped,{target})).toEqual(zodSchemaToJsonSchemaObject(concrete,{target}));
  const unsupported = lazyZodSchema(() => z.strictObject({ value: m.date() }));
  expect(()=>zodSchemaToJsonSchemaObject(unsupported,{target})).toThrow(ActionJsonSchemaProjectionError);
  try { zodSchemaToJsonSchemaObject(unsupported,{target}); } catch(error) {
   expect(error).toMatchObject({name:'ActionJsonSchemaProjectionError',code:'action_schema_unrepresentable'});
  }
 }
 expect(wrapped.parse({name:' kept '})).toEqual(concrete.parse({name:' kept '}));
 expect(()=>wrapped.parse({name:''})).toThrow(z.core.$ZodError);
});
it('keeps ref-rich lazy Action roots at their concrete public projection', async () => {
 const { AutomationDefinitionCreateRequestSchema: automationDefinitionSchema } = await import('../automations/automationApiV3.js');
 const repeated=z.strictObject({id:z.string().check(z.minLength(1))}).check(z.describe('Repeated argument'));
 const concrete=z.strictObject({first:repeated,second:repeated});
 for(const target of ['draft-7','draft-2020-12'] as const) {
  expect(zodSchemaToJsonSchemaObject(lazyZodSchema(()=>concrete),{target})).toEqual(zodSchemaToJsonSchemaObject(concrete,{target}));
  const automation=zodSchemaToJsonSchemaObject(automationDefinitionSchema,{target});
  expect(automation).toMatchObject({type:'object',required:['automationId','name','enabled','executionRecipe','triggers']});
  expect(automation.$ref).toBeUndefined();
 }
});
