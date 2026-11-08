import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

type SchemaNode = Readonly<Record<string, unknown>>;
type SubschemaSlot = Readonly<{ keyword: string; key: string | number | null }>;

const SCHEMA_MAP_KEYWORDS = ['properties', 'definitions', '$defs'] as const;
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;
const SCHEMA_KEYWORDS: readonly string[] = ['items', 'not', 'additionalProperties', 'propertyNames'];
/** Inline subschemas smaller than a reference are cheaper to repeat. */
const MIN_SHARED_SCHEMA_UTF16_LENGTH = 64;

function isSchemaNode(value: unknown): value is SchemaNode {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function forEachSubschema(node: SchemaNode, visit: (child: SchemaNode, slot: SubschemaSlot) => void): void {
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
        const map = node[keyword];
        if (isSchemaNode(map)) for (const [key, child] of Object.entries(map)) if (isSchemaNode(child)) visit(child, { keyword, key });
    }
    for (const keyword of SCHEMA_LIST_KEYWORDS) {
        const list = node[keyword];
        if (Array.isArray(list)) list.forEach((child, key) => { if (isSchemaNode(child)) visit(child, { keyword, key }); });
    }
    for (const keyword of SCHEMA_KEYWORDS) {
        const child = node[keyword];
        if (isSchemaNode(child)) visit(child, { keyword, key: null });
    }
}

/** The node with each subschema replaced by `map`; the node itself when nothing changes. */
function mapSubschemas(node: SchemaNode, map: (child: SchemaNode, slot: SubschemaSlot) => unknown): SchemaNode {
    let copy: Record<string, unknown> | undefined;
    forEachSubschema(node, (child, slot) => {
        const next = map(child, slot);
        if (next === child) return;
        copy ??= { ...node };
        const { keyword, key } = slot;
        if (key === null) copy[keyword] = next;
        else {
            if (copy[keyword] === node[keyword]) {
                const container = node[keyword];
                copy[keyword] = Array.isArray(container) ? [...container] : { ...(container as SchemaNode) };
            }
            (copy[keyword] as Record<string | number, unknown>)[key] = next;
        }
    });
    return copy ?? node;
}

const slotName = ({ keyword, key }: SubschemaSlot) => key === null ? keyword : `${keyword}/${key}`;

/**
 * Publishes each subschema the Collection author repeats at several schema
 * positions once, under root `$defs`, and refers to it from every position.
 * Validation is unchanged: a `$ref` to a byte-identical document accepts
 * exactly what the inline copy accepts. Equal content is found bottom-up (a
 * node's key names its children's keys), so the walk stays linear in the
 * document instead of re-serializing every subtree at module evaluation.
 *
 * Kept inline: root properties (Collection scalar, index and projection
 * admission read them directly), subschemas holding a `$ref` or named by one
 * (those pointers are absolute), and anything smaller than a reference.
 */
export function shareRepeatedCollectionSchemas<TSchema extends PluginJsonSchema>(schema: TSchema): TSchema {
    const root = schema as unknown as SchemaNode;
    if (root.$defs !== undefined || root.definitions !== undefined) {
        throw new Error('Collection schema definitions are owned by shareRepeatedCollectionSchemas.');
    }

    // Content identity: equal keys mean byte-equal subschemas.
    const keys = new Map<SchemaNode, number>();
    const interned = new Map<string, number>();
    const sizes: number[] = [];
    const references: boolean[] = [];
    const keyOf = (node: SchemaNode): number => {
        const known = keys.get(node);
        if (known !== undefined) return known;
        let size = 0;
        let reference = typeof node.$ref === 'string';
        const text = JSON.stringify(mapSubschemas(node, (child) => {
            const childKey = keyOf(child);
            size += sizes[childKey]!;
            reference ||= references[childKey]!;
            return { '#': childKey };
        }));
        let id = interned.get(text);
        if (id === undefined) {
            id = interned.size;
            interned.set(text, id);
            sizes[id] = size + text.length;
            references[id] = reference;
        }
        keys.set(node, id);
        return id;
    };

    const positions = new Map<number, number>();
    const pinned = new Map<unknown, Set<string>>();
    const resolve = (tokens: readonly string[]) => tokens.reduce<unknown>(
        (at, token) => isSchemaNode(at) || Array.isArray(at) ? (at as Record<string, unknown>)[token] : undefined, root);
    const count = (node: SchemaNode) => {
        if (typeof node.$ref === 'string') {
            // Pointer targets stay in the slot their absolute `$ref` names.
            const tokens = node.$ref.replace(/^#\/?/u, '').split('/').filter(Boolean)
                .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
            if (tokens.length > 0) {
                const single = SCHEMA_KEYWORDS.includes(tokens.at(-1)!);
                const parent = resolve(tokens.slice(0, single ? -1 : -2));
                pinned.set(parent, (pinned.get(parent) ?? new Set()).add(tokens.slice(single ? -1 : -2).join('/')));
            }
        }
        forEachSubschema(node, (child, { keyword }) => {
            const key = keyOf(child);
            const seen = positions.get(key) ?? 0;
            if (!(node === root && keyword === 'properties')) positions.set(key, seen + 1);
            if (seen === 0) count(child);
        });
    };
    count(root);

    const names = new Map<number, string>();
    const definitions: Record<string, unknown> = {};
    const rebuilt = new Map<SchemaNode, SchemaNode>();
    const define = (node: SchemaNode): string => {
        const key = keyOf(node);
        let name = names.get(key);
        if (name === undefined) {
            name = `s${names.size}`;
            names.set(key, name);
            definitions[name] = rebuild(node);
        }
        return name;
    };
    const rebuild = (node: SchemaNode): SchemaNode => {
        let result = rebuilt.get(node);
        if (result === undefined) {
            result = mapSubschemas(node, (child, slot) => {
                const key = keyOf(child);
                const shared = !(node === root && slot.keyword === 'properties') && !pinned.get(node)?.has(slotName(slot))
                    && (positions.get(key) ?? 0) >= 2 && sizes[key]! >= MIN_SHARED_SCHEMA_UTF16_LENGTH && !references[key];
                return shared ? { $ref: `#/$defs/${define(child)}` } : rebuild(child);
            });
            rebuilt.set(node, result);
        }
        return result;
    };
    const published = rebuild(root);
    return (names.size === 0 ? published : { ...published, $defs: definitions }) as unknown as TSchema;
}
