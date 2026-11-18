import type { ActionDiscoveryDefinitionV1 } from './actionDefinitionV1.js';
import { forEachJsonSchemaChild, type JsonSchemaObject } from './actionInputJsonSchema.js';
import { ACTION_IDS } from './actionIds.js';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';

const ACTION_ID_SET = new Set<string>(ACTION_IDS);

/**
 * Named grammar belongs to sectioned discovery, not every tool advertisement.
 * Keep inline fields and scalar choices; references to named sections advertise
 * their value type. The executable parser and section reader remain unchanged.
 */
export function projectActionSchemaForToolAdvertisement(schema: JsonSchemaObject): JsonSchemaObject {
  const document = JSON.parse(JSON.stringify(schema)) as JsonSchemaObject;
  const guidance = 'Read the full Action schema and its named sections with action_spec_get (getActionSpec in Voice).';
  let sectioned = false;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const ref = node.$ref;
    if (typeof ref === 'string' && /^#\/(?:definitions|\$defs)\//.test(ref)) {
      let target: unknown = schema;
      for (const part of ref.slice(2).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        target = target && typeof target === 'object' && Object.hasOwn(target, key)
          ? Reflect.get(target, key) : undefined;
      }
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        const type = Reflect.get(target, 'type');
        delete node.$ref;
        // Scalar constraints are useful inline choices, rather than nested grammar.
        if (typeof type === 'string' && type !== 'object' && type !== 'array') {
          Object.assign(node, { ...target, ...node });
        }
        if (type !== undefined && node.type === undefined) node.type = type;
        if (type === 'array' && node.items === undefined) node.items = {};
        sectioned = true;
      }
    }
    // A catalog identifier is discovered, rather than enumerated on every turn.
    if (Array.isArray(node.enum) && node.enum.length === ACTION_ID_SET.size
        && node.enum.every(id => typeof id === 'string' && ACTION_ID_SET.has(id))) {
      delete node.enum;
      node.type = 'string';
      sectioned = true;
    }
    delete node.definitions;
    delete node.$defs;
    forEachJsonSchemaChild(node, visit);
  };
  visit(document);
  return sectioned ? { ...document, description: [document.description, guidance].filter(Boolean).join(' ') } : document;
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function describeDefinition(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Shared grammar';
  const schema = body as JsonSchemaObject;
  if (typeof schema.description === 'string') return schema.description;
  if (typeof schema.title === 'string') return schema.title;
  if (Array.isArray(schema.enum)) return `${schema.enum.length} allowed values`;
  // The path already names this section. Its fields belong to the retrievable
  // grammar; repeating them here overflowed the complete LiveKit result packet.
  return typeof schema.type === 'string' ? schema.type : 'alternative shapes';
}

function schemaSectionPathParts(path: string): string[] {
  const parts = path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!path.startsWith('/') || !['inputSchema', 'outputSchema'].includes(parts[0])) throw new Error('invalid_schema_path');
  if (parts.length % 2 !== 1 || parts.some((part, index) => index % 2 === 1 && part !== 'definitions')) throw new Error('invalid_schema_path');
  return parts;
}

/** Read only own schema properties; a pointer never addresses metadata or prototypes. */
function readSchemaSection(definition: ActionDiscoveryDefinitionV1, path: string): JsonSchemaObject {
  const parts = schemaSectionPathParts(path);
  let value: unknown = definition;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('invalid_schema_path');
    value = (value as Readonly<Record<string, unknown>>)[part];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_schema_path');
  return value as JsonSchemaObject;
}

/**
 * Tools read the same canonical schema in named sections, never a truncated schema.
 * Definitions are already emitted by Zod's shared-schema projection. Keep their
 * local references intact; section paths are relative to the original full spec.
 */
export function projectActionSpecSchemaSections(definition: ActionDiscoveryDefinitionV1, schemaPath?: string) {
  const reference = (path: string) => ({ $ref: `happier-action-spec:${encodeURIComponent(definition.id)}#${path}` });
  const schemaSections: { path: string; description: string }[] = [];
  const project = (schema: JsonSchemaObject, root: string): JsonSchemaObject => {
    const definitions = schema.definitions;
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return schema;
    for (const [name, body] of Object.entries(definitions)) {
      const path = `/${root}/definitions/${escapePointer(name)}`;
      schemaSections.push({ path, description: describeDefinition(body) });
    }
    const { definitions: _definitions, ...rootSchema } = schema;
    return rootSchema;
  };
  if (schemaPath !== undefined) return {
    actionSpec: { ...definition, inputSchema: reference('/inputSchema'),
      ...(definition.outputSchema ? { outputSchema: reference('/outputSchema') } : {}) },
    schemaSection: { path: schemaPath, schema: project(readSchemaSection(definition, schemaPath), schemaPath.slice(1)) }, schemaSections,
  };
  const actionSpec = { ...definition, inputSchema: project(definition.inputSchema, 'inputSchema'),
    ...(definition.outputSchema ? { outputSchema: project(definition.outputSchema, 'outputSchema') } : {}) };
  return { actionSpec, schemaSections };
}

/** Restore the existing sectioned discovery format before freezing executable schemas. */
export async function readCompleteActionSpecV1(params: Readonly<{
  actionId: string;
  signal?: AbortSignal;
  /** An input-admission caller (a Session send) reads no output grammar; contract readers keep the default. */
  includeOutputSchema?: boolean;
  read: (input: Readonly<{ id: string; includeOutputSchema: boolean; schemaPath?: string }>) => Promise<unknown>;
}>): Promise<ActionDiscoveryDefinitionV1> {
  const includeOutputSchema = params.includeOutputSchema ?? true;
  const read = async (schemaPath?: string) => {
    params.signal?.throwIfAborted();
    const result = await params.read({ id: params.actionId, includeOutputSchema,
      ...(schemaPath !== undefined ? { schemaPath } : {}) });
    params.signal?.throwIfAborted();
    const parsed = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(result);
    if (parsed.actionSpec.id !== params.actionId || (schemaPath === undefined
      ? parsed.schemaSection !== undefined : parsed.schemaSection?.path !== schemaPath)) {
      throw new Error('invalid_action_schema_section');
    }
    return parsed;
  };
  const root = await read();
  const restore = async (schema: JsonSchemaObject, path: string,
    sections: readonly Readonly<{ path: string }>[]): Promise<JsonSchemaObject> => {
    if (sections.length === 0) return schema;
    const parent = schemaSectionPathParts(path);
    // Sibling sections can be read independently from the discovery projection.
    // Serial transport here multiplied every machine/Account admission read
    // by the complete grammar size before a Workflow could admit its Run.
    const definitions = await Promise.all(sections.map(async (section): Promise<readonly [string, JsonSchemaObject]> => {
      const parts = schemaSectionPathParts(section.path);
      if (parts.length !== parent.length + 2 || !parent.every((part, index) => parts[index] === part)) {
        throw new Error('invalid_action_schema_section');
      }
      const response = await read(section.path);
      if (!response.schemaSection) throw new Error('invalid_action_schema_section');
      return [parts[parts.length - 1], await restore(response.schemaSection.schema, section.path, response.schemaSections ?? [])];
    }));
    const prior = schema.definitions;
    return { ...schema, definitions: {
      ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
      ...Object.fromEntries<JsonSchemaObject>(definitions),
    } };
  };
  const sections = root.schemaSections ?? [];
  const inputSections = sections.filter(section => schemaSectionPathParts(section.path)[0] === 'inputSchema');
  const outputSections = sections.filter(section => schemaSectionPathParts(section.path)[0] === 'outputSchema');
  if (!root.actionSpec.outputSchema && outputSections.length) throw new Error('invalid_action_schema_section');
  const [inputSchema, outputSchema] = await Promise.all([
    restore(root.actionSpec.inputSchema, '/inputSchema', inputSections),
    includeOutputSchema && root.actionSpec.outputSchema
      ? restore(root.actionSpec.outputSchema, '/outputSchema', outputSections) : undefined,
  ]);
  const { outputSchema: _advertisedOutput, ...definition } = root.actionSpec;
  return { ...definition, inputSchema, ...(outputSchema ? { outputSchema } : {}) };
}
