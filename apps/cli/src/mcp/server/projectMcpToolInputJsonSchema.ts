import type { JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

function asObject(value: unknown): JsonSchemaObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonSchemaObject : undefined;
}

function requiredFields(schema: JsonSchemaObject): string[] {
    return Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
}

function referencedObject(document: JsonSchemaObject, ref: unknown): JsonSchemaObject | undefined {
    if (ref === '#') return document;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    let value: unknown = document;
    for (const part of ref.slice(2).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = Reflect.get(value, key);
    }
    return asObject(value);
}

/** Visit schema nodes without interpreting literal const/default/enum data. */
function mapSchemaChildren(schema: JsonSchemaObject, map: (child: JsonSchemaObject) => JsonSchemaObject): JsonSchemaObject {
    const result: Record<string, unknown> = { ...schema };
    for (const key of ['properties', 'patternProperties', 'dependentSchemas', 'definitions', '$defs']) {
        const entries = asObject(schema[key]);
        if (entries) result[key] = Object.fromEntries(Object.entries(entries).map(([name, child]) =>
            [name, asObject(child) ? map(child as JsonSchemaObject) : child]));
    }
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'propertyNames', 'not', 'contains', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems']) {
        const child = asObject(schema[key]);
        if (child) result[key] = map(child);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'items', 'prefixItems']) {
        const children = schema[key];
        if (Array.isArray(children)) result[key] = children.map(child =>
            asObject(child) ? map(child) : child);
    }
    return result;
}

function mapMcpJsonSchema(schema: JsonSchemaObject, project: (schema: JsonSchemaObject) => JsonSchemaObject): JsonSchemaObject {
    return mapSchemaChildren(project(schema), child => mapMcpJsonSchema(child, project));
}

/** Cut reference back-edges in discovery only; never impose an input depth limit. */
function projectRecursiveReferences(document: JsonSchemaObject): JsonSchemaObject {
    const active = new Set<JsonSchemaObject>();
    const visited = new Set<JsonSchemaObject>();
    const recursive = new Set<JsonSchemaObject>();
    const visit = (node: JsonSchemaObject): JsonSchemaObject => {
        if (visited.has(node)) return node;
        active.add(node);
        const target = referencedObject(document, node.$ref);
        if (target) {
            if (active.has(target)) recursive.add(node);
            else visit(target);
        }
        mapSchemaChildren(node, visit);
        active.delete(node);
        visited.add(node);
        return node;
    };
    visit(document);
    return mapMcpJsonSchema(document, node => {
        if (!recursive.has(node)) return node;
        const { $ref, ...siblings } = node;
        const target = referencedObject(document, $ref)!;
        const readTypes = (schema: JsonSchemaObject): string[] => {
            if (typeof schema.type === 'string') return [schema.type];
            if (Array.isArray(schema.type) && schema.type.every(type => typeof type === 'string')) return schema.type;
            const branches = schema.anyOf ?? schema.oneOf;
            if (!Array.isArray(branches)) return [];
            const types = branches.map(branch => readTypes(asObject(branch) ?? {}));
            return types.every(types => types.length > 0) ? [...new Set(types.flat())] : [];
        };
        const types = readTypes(target);
        return { ...(types.length ? { type: types.length === 1 ? types[0] : types } : {}), ...siblings,
            description: [node.description,
                'Recursive value: discover the full input shape with action_spec_get; the server validates every nested value.',
            ].filter(Boolean).join(' ') };
    });
}

/** Rewrite schema references without interpreting literal const/default/enum data. */
export function rewriteMcpJsonSchemaReferences(schema: JsonSchemaObject, rewrite: (ref: string) => string): JsonSchemaObject {
    return mapMcpJsonSchema(schema, node => typeof node.$ref === 'string' ? { ...node, $ref: rewrite(node.$ref) } : node);
}

/** xAI accepts object/boolean items, not draft-7 positional tuples.
 * Discovery advertises the union; the original parser owns positional validation.
 */
function projectProviderTupleItems(document: JsonSchemaObject): JsonSchemaObject {
    const rewritten = rewriteMcpJsonSchemaReferences(document, ref => {
        if (!ref.startsWith('#/')) return ref;
        const parts = ref.slice(2).split('/');
        const projected: string[] = [];
        let value: unknown = document;
        for (const [index, part] of parts.entries()) {
            if (Array.isArray(value) && parts[index - 1] === 'items') projected.push('anyOf');
            const tuple = asObject(value);
            if (part === 'additionalItems' && Array.isArray(tuple?.items)) {
                projected.push('items', 'anyOf', String(tuple.items.length));
            } else projected.push(part);
            value = value !== null && typeof value === 'object'
                ? Reflect.get(value, part.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
        }
        return `#/${projected.join('/')}`;
    });
    return mapMcpJsonSchema(rewritten, schema => {
        if (!Array.isArray(schema.items)) return schema;
        const { items, additionalItems, ...rest } = schema;
        return { ...rest, items: { anyOf: [...items, additionalItems ?? {}] } };
    });
}

function projectProviderEnum(schema: JsonSchemaObject): JsonSchemaObject {
    // Gemini function declarations accept only string enum values. Adapters
    // also turn const into enum, so omit non-string constraints in discovery
    // while retaining their types and the original validator at dispatch.
    // https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html
    if (Object.hasOwn(schema, 'const') && typeof schema.const !== 'string') {
        const { const: _const, ...rest } = schema;
        schema = rest;
    }
    if (Array.isArray(schema.enum) && schema.enum.some(value => typeof value !== 'string')) {
        const { enum: _enum, ...rest } = schema;
        return rest;
    }
    const values = schema.enum;
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) return schema;
    // OpenAI/Meta strict tool schemas constrain large string enums at 250
    // values / 15,000 combined characters. Happier advertises an enum only
    // within BOTH thresholds; the original Action/plugin parser stays strict.
    // https://developers.openai.com/api/docs/guides/structured-outputs#limitations-on-enum-size
    if (values.length <= 250 && values.reduce((sum, value) => sum + value.length, 0) <= 15_000) return schema;
    const { enum: _enum, ...rest } = schema;
    return { ...rest, type: 'string', description: [schema.description,
        'Discover valid identifiers with action_spec_search; the server validates the selected value.',
    ].filter(Boolean).join(' ') };
}

/** Meta limits expanded discovery schemas to ten levels, even in non-strict mode.
 * Shared subtrees use their deepest advertised placement, retaining compact refs.
 * https://dev.meta.ai/docs/structured-output
 */
function projectSchemaDepth(document: JsonSchemaObject): JsonSchemaObject {
    const levels = new Map<JsonSchemaObject, number>();
    const opaque = new Set<JsonSchemaObject>();
    const visit = (node: JsonSchemaObject, level: number): JsonSchemaObject => {
        if ((levels.get(node) ?? 0) >= level) return node;
        levels.set(node, level);
        // The canonical Zod exporter expands type arrays into anyOf branches.
        if (level === 10 && Array.isArray(node.type)) opaque.add(node);
        const target = referencedObject(document, node.$ref);
        if (target) visit(target, level);
        mapSchemaChildren(node, child => {
            if (level === 10) opaque.add(node);
            else visit(child, level + 1);
            return child;
        });
        return node;
    };
    visit(document, 1);
    return mapMcpJsonSchema(document, node => opaque.has(node) ? {
        type: 'object', description: [node.description,
            'Nested value: see action_spec_get for the full input shape; the server validates every nested value.',
        ].filter(Boolean).join(' '),
    } : node);
}

/**
 * Provider-facing presentation only. MCP arguments remain the original flat
 * object, and the original Action/plugin validator still checks every call.
 * Providers reject root combinators, so expose their fields on one object:
 * alternatives require only common fields; intersections combine requirements.
 * Cross-field/variant correlations remain authoritative at call validation.
 */
export function projectMcpToolInputJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
    return projectSchemaDepth(projectMcpToolObjectRoot(schema));
}

function projectMcpToolObjectRoot(schema: JsonSchemaObject): JsonSchemaObject {
    schema = projectRecursiveReferences(mapMcpJsonSchema(projectProviderTupleItems(schema), projectProviderEnum));
    const projected = projectObjectInputSchema(schema, schema, new Set());
    const removed = ['anyOf', 'oneOf', 'allOf'].filter(key => Array.isArray(schema[key]));
    if (removed.length === 0) return projected;
    const definitions = asObject(schema.definitions) ?? {};
    let name = 'happierMcpInput';
    while (Object.hasOwn(definitions, name)) name += '_';
    const pointer = `#/definitions/${name}`;
    let needsOriginal = false;
    const rewrite = (ref: string) => {
        if (ref === '#' || removed.some(key => ref.startsWith(`#/${key}/`))) {
            needsOriginal = true;
            return `${pointer}${ref.slice(1)}`;
        }
        return ref;
    };
    const original = rewriteMcpJsonSchemaReferences(schema, rewrite);
    if (!needsOriginal) return projected;
    const relocated = rewriteMcpJsonSchemaReferences(projected, rewrite);
    // Only retain a source definition when an advertised reference needs its
    // removed root path. Call validation still uses schema.
    return { ...relocated, definitions: { ...asObject(relocated.definitions), [name]: original } };
}

function projectObjectInputSchema(input: JsonSchemaObject, document: JsonSchemaObject, ancestors: ReadonlySet<JsonSchemaObject>): JsonSchemaObject {
    const visited = new Set(ancestors).add(input);
    const referenced = referencedObject(document, input.$ref);
    let schema = input;
    if (referenced && !visited.has(referenced)) {
        const { $ref: _ref, ...siblings } = input;
        schema = { ...siblings, allOf: [referenced, ...(Array.isArray(input.allOf) ? input.allOf : [])] };
    }
    const result: Record<string, unknown> = { ...schema, type: 'object' };
    let properties = { ...asObject(schema.properties) };
    const required = new Set(requiredFields(schema));
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        const rawBranches = schema[key];
        if (!Array.isArray(rawBranches)) continue;
        const branches = rawBranches.map(branch => projectObjectInputSchema(asObject(branch) ?? {}, document, visited));
        const names = new Set(branches.flatMap(branch => Object.keys(asObject(branch.properties) ?? {})));
        const projectedProperties: Record<string, unknown> = {};
        for (const name of names) {
            const alternatives = branches.flatMap(branch => {
                const fields = asObject(branch.properties) ?? {};
                if (Object.hasOwn(fields, name)) return [fields[name]];
                if (key === 'allOf') return [];
                // An open alternative can accept a field declared by another
                // branch, so its additional-property schema must also be allowed.
                return branch.additionalProperties === false ? [] : [branch.additionalProperties ?? {}];
            });
            const unique = [...new Map(alternatives.map(value => [JSON.stringify(value), value])).values()];
            projectedProperties[name] = unique.length === 1 ? unique[0] : { [key === 'allOf' ? 'allOf' : 'anyOf']: unique };
        }
        properties = Object.fromEntries([...new Set([...Object.keys(properties), ...names])].map(name => {
            if (!Object.hasOwn(properties, name)) return [name, projectedProperties[name]];
            if (!Object.hasOwn(projectedProperties, name)) return [name, properties[name]];
            return [name, { allOf: [properties[name], projectedProperties[name]] }];
        }));
        const branchRequired = branches.map(requiredFields);
        for (const name of branchRequired.flat()) {
            if (key === 'allOf' || branchRequired.every(fields => fields.includes(name))) required.add(name);
        }
        const closed = (branch: JsonSchemaObject) => branch.additionalProperties === false && branch.patternProperties === undefined;
        if (result.additionalProperties === undefined && branches.length > 0
            && (key === 'allOf' ? branches.some(closed) : branches.every(closed))) {
            result.additionalProperties = false;
        }
        delete result[key];
    }
    result.properties = properties;
    if (required.size > 0) result.required = [...required];
    return result;
}
