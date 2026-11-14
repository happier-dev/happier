import { forEachJsonSchemaChild, type JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

/** Lossless wire compaction: share repeated inline grammar within this document. */
export function compactToolJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
    const document = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
    const counts = new Map<string, number>();
    const protectedNodes = new Set<unknown>();
    let scoped = false;
    const walk = (value: unknown, visit: (node: Record<string, unknown>) => void): void => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const node = value as Record<string, unknown>;
        visit(node);
        forEachJsonSchemaChild(node, child => walk(child, visit));
    };
    walk(document, node => {
        if (node.$id !== undefined || node.$anchor !== undefined || node.$dynamicRef !== undefined) scoped = true;
        const key = JSON.stringify(node);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        // Keep every ancestor of an existing reference target at its original
        // pointer, so compaction cannot invalidate references into that subtree.
        if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
            let target: unknown = document;
            for (const part of node.$ref.slice(2).split('/')) {
                protectedNodes.add(target);
                target = target && typeof target === 'object'
                    ? Reflect.get(target, part.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
            }
            protectedNodes.add(target);
        }
    });
    // Relative references beneath an authored resource identity have their own
    // scope; retain those documents verbatim rather than moving their schemas.
    if (scoped) return schema;
    const definitions: Record<string, unknown> = {};
    const shared = new Map<string, string>();
    let index = 0;
    const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const node = value as Record<string, unknown>;
        const key = JSON.stringify(node);
        const count = counts.get(key) ?? 0;
        let name = `tool${index}`;
        while (Object.hasOwn((document.$defs as object | undefined) ?? {}, name)) name = `tool${++index}`;
        const ref = shared.get(key) ?? `#/$defs/${name}`;
        const refBytes = JSON.stringify({ $ref: ref }).length;
        if (node !== document && !protectedNodes.has(node)
            && (count - 1) * key.length > count * refBytes + name.length + 4) {
            if (!shared.has(key)) {
                shared.set(key, ref);
                index++;
                forEachJsonSchemaChild(node, visit);
                definitions[name] = { ...node };
            }
            for (const field of Object.keys(node)) delete node[field];
            node.$ref = ref;
        } else forEachJsonSchemaChild(node, visit);
    };
    visit(document);
    if (Object.keys(definitions).length) document.$defs = { ...(document.$defs as object | undefined), ...definitions };
    return JSON.stringify(document).length < JSON.stringify(schema).length ? document : schema;
}
